"""PostgreSQL pgvector persistent vector store for production retrieval.

Implements cosine similarity search over chunk embeddings with tenant-aware isolation.
"""
from __future__ import annotations

import json
import logging
from typing import Any

from .models import KnowledgeChunk, RetrievalHit
from .vector_store import VectorStore

logger = logging.getLogger(__name__)


class PgVectorStore(VectorStore):
    """Production persistent vector store powered by pgvector (HNSW + GIN FTS + RBAC SQL filters)."""

    def __init__(self, dsn: str, dimensions: int = 384, *, use_halfvec: bool = False) -> None:
        self._dsn = dsn
        self._dimensions = dimensions
        self._use_halfvec = use_halfvec
        self._ensure_schema()

    def _get_connection(self):
        try:
            import psycopg
            return psycopg.connect(self._dsn, connect_timeout=2)
        except ImportError:
            try:
                import psycopg2
                return psycopg2.connect(self._dsn, connect_timeout=2)
            except ImportError as exc:
                raise RuntimeError("PgVectorStore requires psycopg or psycopg2 with pgvector") from exc

    def _ensure_schema(self) -> None:
        vec_col_type = f"halfvec({self._dimensions})" if self._use_halfvec else f"vector({self._dimensions})"
        hnsw_ops = "halfvec_cosine_ops" if self._use_halfvec else "vector_cosine_ops"
        try:
            with self._get_connection() as conn:
                with conn.cursor() as cur:
                    cur.execute("CREATE EXTENSION IF NOT EXISTS vector;")
                    cur.execute(
                        f"""
                        CREATE TABLE IF NOT EXISTS knowledge_embeddings (
                            chunk_id VARCHAR(128) PRIMARY KEY,
                            content TEXT NOT NULL,
                            source_id VARCHAR(256) NOT NULL,
                            source_type VARCHAR(64) NOT NULL,
                            tenant_id VARCHAR(128) NOT NULL DEFAULT 'default-tenant',
                            department VARCHAR(64) NOT NULL DEFAULT 'General',
                            compartment VARCHAR(64) NOT NULL DEFAULT 'comp_general',
                            metadata JSONB NOT NULL,
                            embedding {vec_col_type},
                            created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
                        );
                        ALTER TABLE knowledge_embeddings
                            ADD COLUMN IF NOT EXISTS tenant_id VARCHAR(128) NOT NULL DEFAULT 'default-tenant';
                        ALTER TABLE knowledge_embeddings
                            ADD COLUMN IF NOT EXISTS department VARCHAR(64) NOT NULL DEFAULT 'General';
                        ALTER TABLE knowledge_embeddings
                            ADD COLUMN IF NOT EXISTS compartment VARCHAR(64) NOT NULL DEFAULT 'comp_general';
                        CREATE INDEX IF NOT EXISTS idx_knowledge_source
                            ON knowledge_embeddings(source_id, source_type);
                        CREATE INDEX IF NOT EXISTS idx_knowledge_tenant_comp
                            ON knowledge_embeddings(tenant_id, compartment);
                        CREATE INDEX IF NOT EXISTS idx_knowledge_fts_gin
                            ON knowledge_embeddings USING GIN (to_tsvector('english', content));
                        """
                    )
                    try:
                        cur.execute(
                            f"""
                            CREATE INDEX IF NOT EXISTS idx_knowledge_hnsw_cosine
                                ON knowledge_embeddings USING hnsw (embedding {hnsw_ops})
                                WITH (m = 16, ef_construction = 64);
                            """
                        )
                    except Exception as idx_exc:
                        logger.debug("Optional pgvector HNSW index skipped: %s", idx_exc)
                conn.commit()
        except Exception as exc:
            logger.warning("Could not pre-initialize pgvector schema: %s", exc)

    def upsert(self, chunks: list[KnowledgeChunk], vectors: list[list[float]]) -> None:
        if len(chunks) != len(vectors):
            raise ValueError("chunks and vectors must have equal length")

        cast_type = "halfvec" if self._use_halfvec else "vector"
        with self._get_connection() as conn:
            with conn.cursor() as cur:
                for chunk, vector in zip(chunks, vectors):
                    meta = dict(chunk.metadata or {})
                    src = getattr(chunk, "source", None)
                    source_id = getattr(chunk, "source_id", None) or (src.source_id if src else "")
                    source_type = getattr(chunk, "source_type", None) or (src.source_type if src else "company_file")
                    access = getattr(src, "access", None) if src else None
                    tenant_id = str(
                        meta.get("tenant_id")
                        or (getattr(access, "tenant_id", None) if access else None)
                        or "default-tenant"
                    )
                    department = str(
                        meta.get("department")
                        or (getattr(access, "department", None) if access else None)
                        or "General"
                    )
                    compartment = str(meta.get("compartment") or f"comp_{department.casefold()}")
                    meta_json = json.dumps(meta)
                    vec_str = "[" + ",".join(str(x) for x in vector) + "]"
                    cur.execute(
                        f"""
                        INSERT INTO knowledge_embeddings (
                            chunk_id, content, source_id, source_type,
                            tenant_id, department, compartment, metadata, embedding
                        ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s::{cast_type})
                        ON CONFLICT (chunk_id) DO UPDATE SET
                            content = EXCLUDED.content,
                            source_id = EXCLUDED.source_id,
                            source_type = EXCLUDED.source_type,
                            tenant_id = EXCLUDED.tenant_id,
                            department = EXCLUDED.department,
                            compartment = EXCLUDED.compartment,
                            metadata = EXCLUDED.metadata,
                            embedding = EXCLUDED.embedding
                        """,
                        (chunk.chunk_id, chunk.content, source_id, source_type, tenant_id, department, compartment, meta_json, vec_str),
                    )
            conn.commit()

    def search(self, vector: list[float], top_k: int) -> list[RetrievalHit]:
        return self.search_filtered(vector, top_k=top_k)

    def search_filtered(
        self,
        vector: list[float],
        top_k: int,
        *,
        tenant_id: str | None = None,
        allowed_compartments: tuple[str, ...] | None = None,
        keyword_query: str | None = None,
    ) -> list[RetrievalHit]:
        """Search PostgreSQL pgvector with SQL-enforced tenant/compartment isolation."""
        if top_k <= 0 or not vector:
            return []

        cast_type = "halfvec" if self._use_halfvec else "vector"
        vec_str = "[" + ",".join(str(x) for x in vector) + "]"
        where_clauses: list[str] = ["embedding IS NOT NULL"]
        filter_params: list[Any] = []
        if tenant_id:
            where_clauses.append("tenant_id = %s")
            filter_params.append(tenant_id)
        if allowed_compartments is not None:
            if not allowed_compartments:
                return []
            where_clauses.append("compartment = ANY(%s)")
            filter_params.append(list(allowed_compartments))
        if keyword_query and keyword_query.strip():
            where_clauses.append(
                "(to_tsvector('english', content) @@ plainto_tsquery('english', %s) OR embedding IS NOT NULL)"
            )
            filter_params.append(keyword_query.strip())

        where_sql = " AND ".join(where_clauses)
        with self._get_connection() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    f"""
                    SELECT chunk_id, content, source_id, source_type, metadata,
                           1 - (embedding <=> %s::{cast_type}) AS similarity
                    FROM knowledge_embeddings
                    WHERE {where_sql}
                    ORDER BY embedding <=> %s::{cast_type} ASC
                    LIMIT %s
                    """,
                    [vec_str, *filter_params, vec_str, top_k],
                )
                rows = cur.fetchall()
                hits = []
                for row in rows:
                    meta = row[4] if isinstance(row[4], dict) else json.loads(row[4])
                    chunk = KnowledgeChunk(
                        chunk_id=row[0],
                        content=row[1],
                        source_id=row[2],
                        source_type=row[3],
                        metadata=meta,
                    )
                    score = float(row[5]) if row[5] is not None else 0.0
                    hits.append(RetrievalHit(chunk=chunk, score=score, retrieval_strategy="vector"))
                return hits

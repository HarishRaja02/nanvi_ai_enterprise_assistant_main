"""KnowledgeAgent implementation for document retrieval and enterprise search."""
from __future__ import annotations

import logging
import re
from typing import Any

from backend.agents.interfaces import Agent
from backend.agents.models import AgentRequest, AgentResponse, Capability
from backend.agents.security_gateway import SecureToolGateway, ToolContext
from backend.security.authorization import Permission, Resource
from backend.sources.models import SourceReference, SourceType
from backend.sources.service import SourceReferenceService

logger = logging.getLogger(__name__)


class KnowledgeAgent(Agent):
    capability = Capability.KNOWLEDGE

    def __init__(
        self,
        retrieval_service=None,
        source_references: SourceReferenceService | None = None,
        gateway: SecureToolGateway | None = None,
        company_data_service=None,
    ):
        self._retrieval = retrieval_service
        self._sources = source_references
        self._gateway = gateway
        self._company_data = company_data_service

    def run(self, request: AgentRequest) -> AgentResponse:
        from backend.retrieval.intent import classify_retrieval_intent, QueryIntent

        intent = classify_retrieval_intent(request.query)

        t_id = str(getattr(request.user, "tenant_id", None) or "default")
        u_id = str(getattr(request.user, "user_id", None) or getattr(request.user, "subject", None) or "default")

        company_data = self._company_data
        from backend.integrations.files.company_data_service import CompanyDataService as _CDS
        user_cds = _CDS.for_user(t_id, u_id)
        if user_cds.chunks or (user_cds.root and str(user_cds.root).strip() not in ("", ".") and user_cds.root.exists()):
            company_data = user_cds
        elif company_data is not None and getattr(company_data, "root", None) and str(company_data.root).strip() not in ("", ".") and company_data.root.exists():
            # Preserve explicitly configured disk root for tenant-level tests/company-data fixtures
            if hasattr(company_data, "for_tenant") and request.user.tenant_id and getattr(company_data, "tenant_id", None) != request.user.tenant_id:
                company_data = company_data.for_tenant(request.user.tenant_id)
        else:
            company_data = user_cds

        req_local_ctx = getattr(request, "local_context", None)
        transient_files = (
            req_local_ctx.get("files") if isinstance(req_local_ctx, dict) and isinstance(req_local_ctx.get("files"), list) else []
        )
        transient_chunks = (
            req_local_ctx.get("chunks") if isinstance(req_local_ctx, dict) and isinstance(req_local_ctx.get("chunks"), list) else []
        )

        # 1. Deterministic File Discovery / Directory Listing (skip when numeric/overdue/aggregation/invoice-status Q&A is detected)
        from backend.retrieval.semantic import (
            detect_entity_aggregation_intent,
            is_overdue_invoice_query,
            parse_numeric_filter_query,
            parse_structured_invoice_filter,
        )
        inv_filter_spec = parse_structured_invoice_filter(request.query)
        is_structured_qa_intent = bool(
            parse_numeric_filter_query(request.query)
            or detect_entity_aggregation_intent(request.query)
            or is_overdue_invoice_query(request.query)
            or (inv_filter_spec and (inv_filter_spec.get("status_filter") or inv_filter_spec.get("year") or inv_filter_spec.get("group_by") or inv_filter_spec.get("entity_filter")))
            or (isinstance(req_local_ctx, dict) and req_local_ctx.get("structured_summary"))
        )
        if not is_structured_qa_intent and intent in (QueryIntent.FILE_SEARCH, QueryIntent.DIRECTORY_LISTING):
            if transient_files:
                from backend.chat.file_search import format_transient_local_files
                ans, files, sources = format_transient_local_files(request.query, transient_files, max_results=10)
                if files:
                    return AgentResponse(self.capability, ans, tuple(sources), deterministic=True)

            if company_data is not None:
                try:
                    res = company_data.search_files(request.user, request.query)
                    if res.sources and "couldn't find" not in str(res.answer_content).lower():
                        return AgentResponse(self.capability, res.answer_content, tuple(res.sources), deterministic=True)
                except Exception as exc:
                    logger.warning("CompanyData file search failed, falling back: %s", exc)

            try:
                from backend.chat.file_search import execute_file_search
                ans, files, sources = execute_file_search(request.user, request.query, "local", max_results=10)
                if files:
                    return AgentResponse(self.capability, ans, tuple(sources), deterministic=True)
            except Exception as exc:
                logger.debug("Local agent fallback file search error: %s", exc)

        # 2. Content-first search for Knowledge Questions (skip redundant server scan when Desktop zero-upload context already supplied)
        has_desktop_ctx = bool(
            isinstance(req_local_ctx, dict)
            and (req_local_ctx.get("folder_path") or transient_files or transient_chunks)
        )
        structured_summary = (
            str(req_local_ctx.get("structured_summary") or "").strip()
            if isinstance(req_local_ctx, dict)
            else ""
        )
        aggregated_entities = (
            req_local_ctx.get("aggregated_entities")
            if isinstance(req_local_ctx, dict) and isinstance(req_local_ctx.get("aggregated_entities"), dict)
            else None
        )
        is_desktop_zero_match = bool(
            isinstance(req_local_ctx, dict)
            and req_local_ctx.get("zero_match")
            and not transient_files
            and not transient_chunks
            and not structured_summary
        )

        if is_desktop_zero_match:
            folder_stats = req_local_ctx.get("folder_stats") if isinstance(req_local_ctx, dict) else None
            msg_parts = [
                f'I searched all indexed files in your connected folder for **"{request.query}"**, and found **no matching records or documents**.'
            ]
            if isinstance(folder_stats, dict) and folder_stats.get("total_files"):
                cats = folder_stats.get("categories") or {}
                cat_list = ", ".join(f"{k} ({v})" for k, v in list(cats.items())[:8])
                msg_parts.append(
                    f"Connected folder contains **{folder_stats['total_files']}** indexed files"
                    + (f" across: {cat_list}." if cat_list else ".")
                )
            msg_parts.append(
                "**Helpful follow-ups you can try:**\n"
                "• Share a specific invoice ID (e.g. `INV-00003`), customer name, employee name, or document title.\n"
                "• Ask about overdue invoices, employee headcount, customer directory, or contracts in your connected folder."
            )
            return AgentResponse(self.capability, "\n\n".join(msg_parts), (), deterministic=True)

        active_doc_id = getattr(request, "active_document_id", None)
        company_data_res = None
        if company_data is not None and (not has_desktop_ctx or bool(active_doc_id)):
            try:
                company_data_res = company_data.search(
                    request.user,
                    request.query,
                    active_document_id=active_doc_id,
                )
            except Exception as exc:
                logger.warning("CompanyData search failed, falling back: %s", exc)

        # 3. Query Local Agent files (from transient Desktop snippets or stored browser/server chunks)
        local_hits = []
        if transient_chunks:
            from types import SimpleNamespace
            for idx, tc in enumerate(transient_chunks[:12]):
                if not isinstance(tc, dict) or not str(tc.get("text") or "").strip():
                    continue
                local_hits.append(SimpleNamespace(
                    chunk_id=str(tc.get("chunk_id") or f"desk-{idx}"),
                    folder_path=str(tc.get("folder_path") or req_local_ctx.get("folder_path") or ""),
                    relative_path=str(tc.get("relative_path") or tc.get("filename") or ""),
                    filename=str(tc.get("filename") or "document"),
                    citation=str(tc.get("citation") or tc.get("full_path") or tc.get("relative_path") or tc.get("filename") or ""),
                    text=str(tc.get("text") or ""),
                    page=tc.get("page"),
                    sheet=tc.get("sheet"),
                ))

        if structured_summary or aggregated_entities:
            from types import SimpleNamespace
            extra_parts: list[str] = []
            if structured_summary:
                extra_parts.append(f"[Structured Document Analysis]\n{structured_summary}")
            if aggregated_entities:
                agg_lines = []
                for kind in ("employees", "customers", "vendors"):
                    b = aggregated_entities.get(kind)
                    if isinstance(b, dict) and b.get("total_count"):
                        sample_list = ", ".join((b.get("sample_names") or [])[:20])
                        bd = b.get("breakdown") or {}
                        bd_txt = ", ".join(f"{k}: {v}" for k, v in list(bd.items())[:8])
                        agg_lines.append(
                            f"{kind.title()} across ALL connected files: {b['total_count']} unique entries across {b.get('source_file_count', 0)} files."
                            + (f" Breakdown: {bd_txt}." if bd_txt else "")
                            + (f" Sample names/IDs: {sample_list}." if sample_list else "")
                        )
                if agg_lines:
                    extra_parts.append("[Cross-File Entity Aggregation]\n" + "\n".join(agg_lines))
            if extra_parts:
                first_tf = transient_files[0] if transient_files and isinstance(transient_files[0], dict) else {}
                first_fn = str(first_tf.get("name") or "")
                first_path = str(first_tf.get("full_path") or first_tf.get("path") or "")
                local_hits.insert(0, SimpleNamespace(
                    chunk_id="desk-structured-summary",
                    folder_path=str(req_local_ctx.get("folder_path") or "") if (isinstance(req_local_ctx, dict) and first_path) else "",
                    relative_path=first_path or first_fn,
                    filename=first_fn,
                    citation=first_path or first_fn,
                    text="\n\n".join(extra_parts),
                    page=None,
                    sheet=None,
                ))

        if not local_hits and transient_files:
            q_lower = request.query.lower()
            if any(w in q_lower for w in ("folder", "my file", "my document", "what do i have", "what is in", "contents", "all file", "show files")):
                from backend.chat.file_search import format_transient_local_files
                ans, files, sources = format_transient_local_files(request.query, transient_files, max_results=10)
                if files:
                    return AgentResponse(self.capability, ans, tuple(sources), deterministic=True)

        if not local_hits or active_doc_id:
            try:
                from backend.local_agent.service import get_local_agent_service
                local_svc = get_local_agent_service()
                u_id = getattr(request.user, "user_id", None) or getattr(request.user, "subject", "user")
                t_id = getattr(request.user, "tenant_id", "default")
                fetched_local = local_svc.search_local_chunks(
                    tenant_id=t_id,
                    user_id=u_id,
                    query=active_doc_id or request.query,
                    top_k=8,
                )
                if fetched_local:
                    if not local_hits:
                        local_hits = fetched_local
                    elif active_doc_id:
                        existing_cids = {getattr(h, "chunk_id", None) for h in local_hits}
                        active_matched = [h for h in fetched_local if active_doc_id.casefold() in str(getattr(h, "filename", "")).casefold() or active_doc_id.casefold() in str(getattr(h, "relative_path", "")).casefold()]
                        local_hits = [h for h in active_matched if getattr(h, "chunk_id", None) not in existing_cids] + list(local_hits)

                # If specific query produced 0 chunk hits, check if user asked for folder overview or numeric/entity aggregation
                if not local_hits and not transient_files:
                    local_files = local_svc.get_all_local_files(t_id, u_id)
                    if local_files:
                        from backend.retrieval.semantic import detect_entity_aggregation_intent, parse_numeric_filter_query
                        from backend.integrations.files.company_data.extraction import (
                            aggregate_entities_from_documents,
                            filter_entities_by_numeric_query,
                        )
                        num_spec = parse_numeric_filter_query(request.query)
                        agg_kind = detect_entity_aggregation_intent(request.query)
                        if num_spec or agg_kind:
                            stored_chunks = list(local_svc.store._tenant_field_unlocked(t_id, u_id, "chunks") or [])
                            docs_map: dict[str, dict[str, Any]] = {}
                            for ch in stored_chunks:
                                rp = str(ch.get("relative_path") or ch.get("filename") or "")
                                if rp not in docs_map:
                                    docs_map[rp] = {
                                        "filename": str(ch.get("filename") or Path(rp).name),
                                        "relative_path": rp,
                                        "content": "",
                                    }
                                docs_map[rp]["content"] += ("\n" + str(ch.get("text") or ""))
                            docs_list = list(docs_map.values())
                            if num_spec and num_spec.get("domain") in ("employees", "customers") and docs_list:
                                f_res = filter_entities_by_numeric_query(docs_list, num_spec, offset=0, limit=25)
                                if f_res["total_matching"] > 0:
                                    lines = [f"Found **{f_res['total_matching']} unique {f_res['domain']}** matching your filter across {f_res['scanned_files']} synced local files:"]
                                    for rec in f_res["records"][:20]:
                                        val_disp = rec.get("salary_display") or rec.get("value_display") or rec.get(f_res["field"])
                                        lines.append(f"• **{rec.get('name') or rec.get('id')}** ({rec.get('id')} | {rec.get('department') or rec.get('segment')}) — {f_res['field']}: {val_disp}")
                                    from types import SimpleNamespace
                                    local_hits = [SimpleNamespace(
                                        chunk_id="local-numeric-filter",
                                        folder_path="",
                                        relative_path=f_res["source_files"][0] if f_res["source_files"] else "LocalFolder",
                                        filename=Path(f_res["source_files"][0]).name if f_res["source_files"] else "LocalFolder",
                                        citation=f_res["source_files"][0] if f_res["source_files"] else "LocalFolder",
                                        text="\n".join(lines),
                                        page=None,
                                        sheet=None,
                                    )]
                            elif agg_kind in ("employees", "customers", "vendors") and docs_list:
                                agg = aggregate_entities_from_documents(docs_list, entity_kind=agg_kind)
                                bucket = agg.get(agg_kind) or {}
                                if bucket.get("total_count"):
                                    from types import SimpleNamespace
                                    local_hits = [SimpleNamespace(
                                        chunk_id="local-entity-agg",
                                        folder_path="",
                                        relative_path="LocalFolder",
                                        filename="LocalFolder",
                                        citation="LocalFolder",
                                        text=f"Found {bucket['total_count']} unique {agg_kind} across {bucket['source_file_count']} synced local files. Samples: {', '.join(bucket.get('sample_names', [])[:20])}",
                                        page=None,
                                        sheet=None,
                                    )]
                        if not local_hits:
                            q_lower = request.query.lower()
                            # Only list folder files when the user asks to browse/list/summarize the folder itself
                            if any(w in q_lower for w in (
                                "list files", "show files", "all files", "my files", "my documents",
                                "what files do i have", "what is in my folder", "summarize my folder", "folder contents",
                            )):
                                from backend.chat.file_search import execute_file_search
                                ans, files, sources = execute_file_search(request.user, request.query, "local", max_results=10)
                                if files:
                                    return AgentResponse(self.capability, ans, tuple(sources), deterministic=True)
                            # Zero-match verification: never pull random chunks on query="" fallback!
            except Exception as exc:
                logger.debug("Local agent search check error: %s", exc)

        if local_hits:
            local_sources = []
            local_snippets = []
            for h in local_hits:
                raw_fp = str(getattr(h, "folder_path", "") or "").strip()
                if raw_fp and (":" in raw_fp or raw_fp.startswith("\\\\") or raw_fp.startswith("/")):
                    sep = "\\" if (":" in raw_fp or "\\" in raw_fp) else "/"
                    rel_part = str(getattr(h, "relative_path", "") or h.filename).replace("/", sep).lstrip("/\\")
                    loc = f"{raw_fp.rstrip('/\\')}{sep}{rel_part}"
                else:
                    loc = str(h.citation or "").replace("\\", "/")
                    if loc.lower().startswith("browserfolder/"):
                        loc = loc[len("BrowserFolder/"):]
                if loc and (h.filename or "\\" in loc or "/" in loc):
                    src_ref = SourceReference(
                        reference_id=f"ref-local-{h.chunk_id[:16]}",
                        source_type=SourceType.FILE,
                        display_name=h.filename,
                        title=h.filename,
                        location=loc,
                        page=h.page,
                        sheet=h.sheet,
                    )
                    local_sources.append(src_ref)
                local_snippets.append(f"[{loc or h.citation or 'Structured Analysis'}]\n{h.text}")

            local_text = "\n\n---\n\n".join(local_snippets)
            # Also ensure all desktop-matched files (up to 12) are attached as SourceReference objects for UI table display
            seen_loc_keys = {str(getattr(s, "location", "") or "").replace("\\", "/").lower() for s in local_sources}
            for f_idx, tf in enumerate((transient_files or [])[:12]):
                if not isinstance(tf, dict):
                    continue
                t_loc = str(tf.get("full_path") or tf.get("path") or "").strip()
                t_fn = str(tf.get("name") or "document").strip()
                t_key = t_loc.replace("\\", "/").lower()
                if t_loc and t_key not in seen_loc_keys:
                    seen_loc_keys.add(t_key)
                    local_sources.append(SourceReference(
                        reference_id=f"ref-desk-file-{f_idx}",
                        source_type=SourceType.FILE,
                        display_name=t_fn,
                        title=t_fn,
                        location=t_loc,
                    ))

            if company_data_res and company_data_res.answer_content and "couldn't find" not in company_data_res.answer_content.lower():
                combined_content = f"{company_data_res.answer_content}\n\n### Local Computer Documents:\n{local_text}"
                dedup_sources: list[SourceReference] = []
                seen_src_keys: set[str] = set()
                for s in (*company_data_res.sources, *local_sources):
                    raw_loc = str(getattr(s, "location", "") or "").replace("\\", "/").strip()
                    if raw_loc.lower().startswith("browserfolder/"):
                        raw_loc = raw_loc[len("BrowserFolder/"):]
                    raw_fn = re.sub(r"^\[[^\]]+\]\s*", "", str(getattr(s, "title", None) or getattr(s, "display_name", "") or "")).strip()
                    raw_fn = re.sub(r"\s*\([^)]*\)$", "", raw_fn).strip()
                    dedup_key = (raw_loc or raw_fn).lower()
                    if dedup_key and dedup_key in seen_src_keys:
                        continue
                    if dedup_key:
                        seen_src_keys.add(dedup_key)
                    dedup_sources.append(s)
                return AgentResponse(self.capability, combined_content, tuple(dedup_sources), deterministic=False)
            return AgentResponse(self.capability, local_text, tuple(local_sources), deterministic=False)

        if company_data_res and company_data_res.sources:
            is_restricted = "Access Restricted" in getattr(company_data_res, "answer_content", "")
            if is_restricted:
                return AgentResponse(self.capability, company_data_res.answer_content, (), deterministic=True)

            if intent == QueryIntent.KNOWLEDGE_QA and company_data_res.answer_content and "couldn't find" not in str(company_data_res.answer_content).lower():
                return AgentResponse(
                    self.capability,
                    company_data_res.answer_content,
                    tuple(company_data_res.sources),
                    deterministic=False,
                )

            seen = set()
            clean_sources = []
            for s in company_data_res.sources:
                fn = getattr(s, "display_name", None) or getattr(s, "title", "document")
                # Clean prefix like [Finance] invoice_003.pdf -> invoice_003.pdf
                fn_clean = re.sub(r"^\[[^\]]+\]\s*", "", fn)
                if fn_clean not in seen:
                    seen.add(fn_clean)
                    clean_sources.append(s)

            count = len(clean_sources)
            summary = f"Found **{count}** matching document{'s' if count != 1 else ''}:"
            lines = [
                summary,
                "",
                "| File Name | File Path | Action |",
                "| --- | --- | --- |",
            ]
            for s in clean_sources[:10]:
                fn = re.sub(r"^\[[^\]]+\]\s*", "", getattr(s, "display_name", None) or getattr(s, "title", "document"))
                path = getattr(s, "location", fn) or fn
                lines.append(f"| {fn} | `{path}` | [Open]({path}) |")

            return AgentResponse(
                self.capability,
                "\n".join(lines),
                tuple(clean_sources),
                deterministic=True,
            )
        elif company_data_res and company_data_res.answer_content and company_data_res.sources and "couldn't find" not in str(company_data_res.answer_content).lower():
            return AgentResponse(
                self.capability,
                company_data_res.answer_content,
                tuple(company_data_res.sources),
                deterministic=True,
            )
        elif self._retrieval is None:
            return AgentResponse(
                self.capability,
                "I couldn't find sufficiently relevant information in the authorized documents to answer this question.",
                (),
                deterministic=False,
            )

        if self._retrieval is None:
            return AgentResponse(
                self.capability,
                "Knowledge retrieval is not configured for this environment.",
                (),
            )

        from backend.retrieval.models import RetrievalRequest

        if self._gateway is not None:
            context = ToolContext(request_id=request.request_id, user=request.user)
            resource = Resource(
                resource_id="knowledge-retrieval",
                resource_type="knowledge_source",
                tenant_id=request.user.tenant_id,
            )
            result = self._gateway.execute(
                context,
                "knowledge",
                Permission.FILE_READ,
                resource,
                lambda: self._retrieval.retrieve(
                    request.user,
                    RetrievalRequest(query=request.query, top_k=5, candidate_k=20),
                ),
            )
        else:
            result = self._retrieval.retrieve(
                request.user,
                RetrievalRequest(query=request.query, top_k=5, candidate_k=20),
            )

        if not result.hits:
            return AgentResponse(
                self.capability,
                "I couldn't find sufficiently relevant information in the authorized documents to answer this question.",
                (),
            )

        # Build content from authorized retrieval hits
        content_parts = []
        for hit in result.hits:
            content_parts.append(hit.chunk.content)
        content = "\n\n".join(content_parts)

        # Build source references
        refs: tuple[SourceReference, ...] = ()
        if self._sources:
            refs = self._retrieval.source_references(
                request.user, request.request_id, result
            )

        return AgentResponse(self.capability, content, refs)

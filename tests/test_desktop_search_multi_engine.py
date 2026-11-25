from __future__ import annotations

import hashlib
import os
from pathlib import Path
import shutil
import sqlite3
import tempfile

from fastapi.testclient import TestClient
import numpy as np
import pytest

from backend.desktop_search import (
    DesktopSearchWorkspace,
    EMBEDDING_DIM,
    LocalPayloadCipher,
    ResourceProfile,
    SearchFilter,
    WorkspaceManager,
    create_sidecar_app,
    generate_sidecar_token,
    is_blocked_system_path,
    validate_scan_root,
)
from backend.desktop_search.parsers import _split_into_chunks
from backend.desktop_search.security import resolve_allowed_compartments


def _deterministic_embed_counter(counter: dict[str, int]):
    """Deterministic unit-normalized 384d hash-projection embedder tracking call counts."""

    def _embed(texts: list[str]) -> np.ndarray:
        counter["calls"] += 1
        counter["texts"] += len(texts)
        rows = []
        for txt in texts:
            vec = np.zeros(EMBEDDING_DIM, dtype=np.float32)
            for tok in str(txt).casefold().split():
                h = int(hashlib.md5(tok.encode("utf-8")).hexdigest()[:8], 16)
                vec[h % EMBEDDING_DIM] += 1.0
            norm = float(np.linalg.norm(vec))
            if norm > 0:
                vec /= norm
            else:
                vec[0] = 1.0
            rows.append(vec)
        return np.vstack(rows)

    return _embed


@pytest.fixture
def workspace_env(tmp_path: Path):
    root = tmp_path / "company_docs"
    data_dir = tmp_path / "appdata"
    root.mkdir()
    data_dir.mkdir()
    return root, data_dir


def test_three_layer_identity_move_rename_and_vector_dedupe(workspace_env):
    root, data_dir = workspace_env
    fin = root / "Finance"
    fin.mkdir()
    inv = fin / "INV-2025-881.txt"
    inv.write_text(
        "Invoice #INV-2025-881\nVendor: Northwind Logistics\nAmount: $12,450.00\nDue Date: 2025-10-01\nStatus: Overdue",
        encoding="utf-8",
    )

    counts = {"calls": 0, "texts": 0}
    ws = DesktopSearchWorkspace(
        root,
        local_data_dir=data_dir,
        embed_fn=_deterministic_embed_counter(counts),
        allow_model_download=False,
        start_watcher=False,
        start_background_workers=False,
    )
    try:
        scan1 = ws.scan_and_sync(drain_outbox=True)
        assert scan1["indexed"] == 1
        assert counts["calls"] == 1

        row_before = ws.catalog.lookup_active_by_path(
            tenant_id=ws.tenant_id,
            user_id=ws.user_id,
            machine_id=ws.machine_id,
            workspace_id=ws.workspace_id,
            rel_path="Finance/INV-2025-881.txt",
        )
        assert row_before is not None
        original_doc_id = row_before["doc_id"]

        # Move/rename inside same volume
        sub = fin / "Archive_2025"
        sub.mkdir()
        moved_path = sub / "INV-2025-881-paid.txt"
        shutil.move(str(inv), str(moved_path))

        scan2 = ws.scan_and_sync(drain_outbox=True)
        assert scan2["moved"] == 1
        assert scan2["indexed"] == 0
        # Moving preserved doc_id and reused cached SHA-256 vector without re-embedding!
        assert counts["calls"] == 1

        row_after = ws.catalog.lookup_active_by_path(
            tenant_id=ws.tenant_id,
            user_id=ws.user_id,
            machine_id=ws.machine_id,
            workspace_id=ws.workspace_id,
            rel_path="Finance/Archive_2025/INV-2025-881-paid.txt",
        )
        assert row_after is not None
        assert row_after["doc_id"] == original_doc_id

        res = ws.search(
            "INV-2025-881",
            search_filter=SearchFilter(role="CEO", roles=("CEO",)),
        )
        assert res.total_matches == 1
        assert res.files[0]["path"] == "Finance/Archive_2025/INV-2025-881-paid.txt"
    finally:
        ws.close()


def test_outbox_crash_recovery_and_fts5_retirement(workspace_env):
    root, data_dir = workspace_env
    proj = root / "Projects"
    proj.mkdir()
    doc = proj / "architecture_roadmap.md"
    doc.write_text(
        "# Multi-Engine Desktop Search\nTantivy BM25F handles full-text ranking while SQLite Trigram handles filenames.",
        encoding="utf-8",
    )

    counts = {"calls": 0, "texts": 0}
    ws = DesktopSearchWorkspace(
        root,
        local_data_dir=data_dir,
        embed_fn=_deterministic_embed_counter(counts),
        allow_model_download=False,
        start_watcher=False,
        start_background_workers=False,
    )
    try:
        # Ingest into SQLite only (without draining outbox), leaving jobs queued.
        ws.scan_and_sync(drain_outbox=False)
        assert ws.catalog.is_chunks_fts_retired() is False

        # Simulate mid-flight process crash leaving a job 'leased'.
        with ws.catalog.transaction() as conn:
            conn.execute("UPDATE index_outbox SET status = 'leased', lease_expires_at = 9999999999.0")

        ws.close()

        # Re-open workspace cleanly after crash -> constructor runs recover_expired_leases().
        ws2 = DesktopSearchWorkspace(
            root,
            local_data_dir=data_dir,
            embed_fn=_deterministic_embed_counter(counts),
            allow_model_download=False,
            start_watcher=False,
            start_background_workers=False,
        )
        try:
            drained = ws2.outbox.drain_all(respect_governor=False)
            assert drained > 0
            assert ws2.tantivy.num_docs() >= 1
            assert ws2.catalog.is_chunks_fts_retired() is True

            # Verify chunks_fts table was dropped while files_trigram remained intact!
            conn = sqlite3.connect(str(ws2.catalog.db_path))
            try:
                tables = {
                    r[0]
                    for r in conn.execute(
                        "SELECT name FROM sqlite_master WHERE type='table'"
                    ).fetchall()
                }
                assert "chunks_fts" not in tables
                assert "files_trigram" in tables
            finally:
                conn.close()

            res = ws2.search("Multi-Engine Desktop Search")
            assert res.total_matches == 1
            assert "tantivy" in res.engines_used
            assert "sqlite_trigram" in res.engines_used
        finally:
            ws2.close()
    except Exception:
        ws.close()
        raise


def test_rbac_compartment_isolation_and_no_topk_crowding(workspace_env):
    root, data_dir = workspace_env
    fin = root / "Finance"
    hr = root / "HR"
    proj = root / "Projects"
    fin.mkdir()
    hr.mkdir()
    proj.mkdir()

    # Create 15 sensitive compensation docs + 1 employee handbook + 2 project specs mentioning "bonus"
    for i in range(15):
        (fin / f"executive_bonus_plan_{i}.txt").write_text(
            f"Confidential Executive Bonus Payout Plan #{i}: Annual discretionary cash bonus $85,000 for CFO.",
            encoding="utf-8",
        )
    (hr / "payroll_salaries_2025.txt").write_text(
        "Confidential Payroll Register: Bonus and salary compensation table for leadership.",
        encoding="utf-8",
    )
    (hr / "employee_onboarding_handbook.txt").write_text(
        "Welcome Handbook & Leave Policy: Quarterly team referral bonus guidelines for all employees.",
        encoding="utf-8",
    )
    (proj / "search_design_spec.md").write_text(
        "Engineering Search Spec: Evaluation metrics bonus accuracy score on desktop queries.",
        encoding="utf-8",
    )

    counts = {"calls": 0, "texts": 0}
    ws = DesktopSearchWorkspace(
        root,
        local_data_dir=data_dir,
        embed_fn=_deterministic_embed_counter(counts),
        allow_model_download=False,
        start_watcher=False,
        start_background_workers=False,
    )
    try:
        ws.scan_and_sync(drain_outbox=True)

        # Standard Employee MUST NOT have finance/hr_sensitive searched or leaked in top-K,
        # AND authorized employee handbook + project doc MUST appear at top cleanly!
        emp_res = ws.search(
            "bonus guidelines policy",
            search_filter=SearchFilter(role="Employee", roles=("Employee",)),
            top_files_limit=5,
        )
        assert "comp_finance" not in emp_res.compartments_searched
        assert "comp_hr_sensitive" not in emp_res.compartments_searched
        returned_paths = [f["path"] for f in emp_res.files]
        assert not any("executive_bonus_plan" in p for p in returned_paths)
        assert not any("payroll_salaries" in p for p in returned_paths)
        assert "HR/employee_onboarding_handbook.txt" in returned_paths
        assert "Projects/search_design_spec.md" in returned_paths

        # Tier 3 (Project Engineer / PM) includes comp_customers & comp_contracts, excludes Finance/HR sensitive
        pm_compartments = resolve_allowed_compartments(SearchFilter(role="Project Engineer", roles=("Project Engineer",)))
        assert "comp_customers" in pm_compartments
        assert "comp_contracts" in pm_compartments
        assert "comp_hr_public" in pm_compartments
        assert "comp_finance" not in pm_compartments
        assert "comp_hr_sensitive" not in pm_compartments

        # Tier 5 (Intern) matches basic non-sensitive public compartments without Finance/Contracts/Customers
        intern_res = ws.search(
            "bonus guidelines policy",
            search_filter=SearchFilter(role="Intern", roles=("Intern",)),
            top_files_limit=5,
        )
        assert "comp_finance" not in intern_res.compartments_searched
        assert "comp_contracts" not in intern_res.compartments_searched
        assert "comp_customers" not in intern_res.compartments_searched
        assert "HR/employee_onboarding_handbook.txt" in [f["path"] for f in intern_res.files]

        # CEO / Finance sees authorized confidential results cleanly.
        ceo_res = ws.search(
            "executive bonus payout",
            search_filter=SearchFilter(role="CEO", roles=("CEO",)),
            top_files_limit=10,
        )
        assert "comp_finance" in ceo_res.compartments_searched
        assert any("executive_bonus_plan" in f["path"] for f in ceo_res.files)
    finally:
        ws.close()


def test_delete_propagation_and_hnsw_compaction(workspace_env):
    root, data_dir = workspace_env
    proj = root / "Projects"
    proj.mkdir()
    created: list[Path] = []
    # Create >100 chunks across files so deleting 15 triggers >20% HNSW compaction threshold.
    for i in range(40):
        fp = proj / f"spec_{i:03d}.txt"
        fp.write_text(
            "\n\n".join(
                f"Section {s} of Spec {i}: quantum telemetry pipeline calibration parameter {i}_{s} with extended architecture notes and verification vectors."
                for s in range(20)
            )
            + ("\n\nUniqueSentinelDeleteMe" if i == 0 else ""),
            encoding="utf-8",
        )
        created.append(fp)

    counts = {"calls": 0, "texts": 0}
    ws = DesktopSearchWorkspace(
        root,
        local_data_dir=data_dir,
        embed_fn=_deterministic_embed_counter(counts),
        allow_model_download=False,
        start_watcher=False,
        start_background_workers=False,
    )
    try:
        ws.scan_and_sync(drain_outbox=True)
        before_live = ws.vector.total_live_vectors()
        assert before_live >= 40

        pre_search = ws.search("UniqueSentinelDeleteMe")
        assert pre_search.total_matches == 1

        # Remove first 15 files (>35% deletion triggers compartment compaction automatically)
        for fp in created[:15]:
            fp.unlink()

        scan_del = ws.scan_and_sync(drain_outbox=True)
        assert scan_del["deleted"] == 15
        after_live = ws.vector.total_live_vectors()
        removed_vectors = before_live - after_live
        assert removed_vectors >= 30
        comp_proj = ws.vector._compartments["comp_projects"]
        # Auto-compaction fired mid-batch so remaining tombstones are strictly below deleted vectors
        assert comp_proj.deleted_count < removed_vectors
        assert (comp_proj.deleted_count / max(1, comp_proj.live_count + comp_proj.deleted_count)) <= 0.21
        comp_proj.compact()
        ws.vector.persist_all()
        assert comp_proj.deleted_count == 0

        post_search = ws.search("UniqueSentinelDeleteMe")
        assert post_search.total_matches == 0
    finally:
        ws.close()


def test_fuzzy_exact_id_and_pagination(workspace_env):
    root, data_dir = workspace_env
    fin = root / "Finance"
    fin.mkdir()
    for i in range(14):
        (fin / f"quarterly_report_{i:02d}.txt").write_text(
            f"Quarterly Financial Summary #{i}: revenue metrics and operating expenses.",
            encoding="utf-8",
        )
    (fin / "INV-2025-9942.txt").write_text(
        "Invoice INV-2025-9942\nVendor: Vertex Cloud\nDue Date: 2025-09-01\nStatus: Overdue\nAmount: $4,200.00",
        encoding="utf-8",
    )

    counts = {"calls": 0, "texts": 0}
    ws = DesktopSearchWorkspace(
        root,
        local_data_dir=data_dir,
        embed_fn=_deterministic_embed_counter(counts),
        allow_model_download=False,
        start_watcher=False,
        start_background_workers=False,
    )
    try:
        ws.scan_and_sync(drain_outbox=True)
        sf = SearchFilter(role="CEO", roles=("CEO",))

        # Typo query should still find quarterly reports via Tantivy fuzzy + semantic vectors!
        page1 = ws.search("quartery summary", search_filter=sf, offset=0, top_files_limit=10)
        assert page1.total_matches >= 14
        assert len(page1.files) == 10
        assert page1.has_more is True

        page2 = ws.search("quartery summary", search_filter=sf, offset=10, top_files_limit=10)
        assert len(page2.files) >= 4

        # Exact ID boost ranks INV-2025-9942 at #1
        exact = ws.search("invoic INV-2025-9942", search_filter=sf)
        assert exact.total_matches >= 1
        assert exact.files[0]["name"] == "INV-2025-9942.txt"
        assert "Structured Invoice Summary" in exact.structured_summary
    finally:
        ws.close()


def test_bounded_governor_disk_pause_and_resume(workspace_env):
    root, data_dir = workspace_env
    docs = root / "General"
    docs.mkdir()
    for i in range(6):
        (docs / f"policy_{i}.txt").write_text(
            f"Corporate operational guideline document number {i}.",
            encoding="utf-8",
        )

    impossibly_high_disk_floor = ResourceProfile(
        tier="constrained_8gb",
        total_ram_gb=8.0,
        parse_workers=1,
        embed_workers=1,
        onnx_threads=1,
        embed_batch_size=4,
        ram_budget_mb=420,
        disk_free_floor_mb=999_999_999,
        max_pending_jobs=50,
        tantivy_heap_bytes=16 * 1024 * 1024,
        hnsw_m=16,
        hnsw_ef_construction=100,
        hnsw_ef_search=40,
    )
    ws = DesktopSearchWorkspace(
        root,
        local_data_dir=data_dir,
        profile=impossibly_high_disk_floor,
        embed_fn=_deterministic_embed_counter({"calls": 0, "texts": 0}),
        allow_model_download=False,
        start_watcher=False,
        start_background_workers=False,
    )
    try:
        paused_scan = ws.scan_and_sync(drain_outbox=True, respect_governor=True)
        assert paused_scan["paused_reason"] is not None
        assert "low_disk_space" in paused_scan["paused_reason"]

        # Recover disk headroom and resume cleanly -> zero files silently dropped!
        ws.governor.profile = ResourceProfile(
            tier="constrained_8gb",
            total_ram_gb=8.0,
            parse_workers=2,
            embed_workers=1,
            onnx_threads=1,
            embed_batch_size=8,
            ram_budget_mb=4096,
            disk_free_floor_mb=10,
            max_pending_jobs=500,
            tantivy_heap_bytes=16 * 1024 * 1024,
            hnsw_m=16,
            hnsw_ef_construction=100,
            hnsw_ef_search=40,
        )
        resumed = ws.scan_and_sync(drain_outbox=True, respect_governor=True)
        assert resumed["paused_reason"] is None
        assert resumed["discovered"] == 6
        health = ws.health()
        assert health.indexed_files == 6
    finally:
        ws.close()


def test_security_blocked_paths_encrypted_payloads_and_sidecar_auth(workspace_env):
    root, data_dir = workspace_env
    if os.name == "nt":
        with pytest.raises(ValueError):
            validate_scan_root(os.environ.get("WINDIR", r"C:\Windows"), local_data_dir=data_dir)
        with pytest.raises(ValueError):
            validate_scan_root(data_dir, local_data_dir=data_dir)

    fin = root / "Finance"
    fin.mkdir()
    secret_txt = "TopSecretAcquisitionTermSheet 2026 Valuation $99M"
    (fin / "merger_term_sheet.txt").write_text(secret_txt, encoding="utf-8")

    aes_key = os.urandom(32)
    ws = DesktopSearchWorkspace(
        root,
        local_data_dir=data_dir,
        encrypt_sensitive=True,
        cipher_key_bytes=aes_key,
        embed_fn=_deterministic_embed_counter({"calls": 0, "texts": 0}),
        allow_model_download=False,
        start_watcher=False,
        start_background_workers=False,
    )
    try:
        ws.scan_and_sync(drain_outbox=True)
        # Verify plaintext is encrypted at rest inside SQLite canonical_chunks!
        conn = sqlite3.connect(str(ws.catalog.db_path))
        try:
            raw_cell = conn.execute(
                "SELECT content, content_encrypted FROM canonical_chunks LIMIT 1"
            ).fetchone()
            assert raw_cell is not None
            assert raw_cell[1] == 1
            assert str(raw_cell[0]).startswith("ENC1:")
            assert "TopSecretAcquisitionTermSheet" not in str(raw_cell[0])
        finally:
            conn.close()

        # Authorized CEO receives transparently decrypted snippet
        res = ws.search(
            "TopSecretAcquisitionTermSheet",
            search_filter=SearchFilter(role="CEO", roles=("CEO",)),
        )
        assert res.total_matches == 1
        assert "TopSecretAcquisitionTermSheet" in res.chunks[0]["text"]
    finally:
        ws.close()

    # Sidecar HTTP auth test
    tok = generate_sidecar_token()
    mgr = WorkspaceManager(
        local_data_dir=data_dir,
        allow_model_download=False,
        start_watcher=False,
        start_background_workers=False,
    )
    app = create_sidecar_app(auth_token=tok, manager=mgr)
    with TestClient(app) as client:
        unauth = client.get("/internal/health")
        assert unauth.status_code == 401

        wrong = client.get("/internal/health", headers={"X-Nanvi-Sidecar-Token": "wrong-token"})
        assert wrong.status_code == 401

        ok = client.get("/internal/health", headers={"X-Nanvi-Sidecar-Token": tok})
        assert ok.status_code == 200
        assert ok.json()["status"] == "ok"

        warm = client.post(
            "/internal/warm",
            headers={"X-Nanvi-Sidecar-Token": tok},
            json={"folder_path": str(root), "wait_for_drain": True},
        )
        assert warm.status_code == 200
        assert warm.json()["status"] == "warmed"

        srch = client.post(
            "/internal/search",
            headers={"X-Nanvi-Sidecar-Token": tok},
            json={
                "folder_path": str(root),
                "query": "AcquisitionTermSheet",
                "role": "CEO",
                "roles": ["CEO"],
            },
        )
        assert srch.status_code == 200
        data = srch.json()
        assert data["folder_path"] == str(root.resolve())
        assert data["offline_mode"] is True


def test_large_csv_chunking_does_not_truncate_rows():
    lines = ["id,name,notes"]
    for i in range(1, 901):
        lines.append(f"{i},Item_{i},FinalSentinelToken_{i}")
    full_csv = "\n".join(lines)
    chunks = _split_into_chunks(full_csv, doc_id="doc-csv", file_version=1, ext=".csv")
    joined = "\n".join(c.content for c in chunks)
    assert "FinalSentinelToken_900" in joined


def test_partition_root_validation_and_non_blocking_warm(workspace_env):
    root, data_dir = workspace_env
    # 1. Drive system directory & root filtering checks
    if os.name == "nt":
        sys_drive = os.environ.get("SystemDrive") or "C:"
        with pytest.raises(ValueError, match="system drive root"):
            validate_scan_root(f"{sys_drive}\\", local_data_dir=data_dir)

    assert is_blocked_system_path(root / "$RECYCLE.BIN", local_data_dir=data_dir) is True
    assert is_blocked_system_path(root / "System Volume Information", local_data_dir=data_dir) is True
    assert is_blocked_system_path(root / "$WinREAgent", local_data_dir=data_dir) is True

    # 2. Candidate discovery ignores system directories with thousands of junk files
    sys_dir = root / "System Volume Information"
    sys_dir.mkdir(parents=True, exist_ok=True)
    (sys_dir / "system_data.txt").write_text("ShouldNotBeDiscovered", encoding="utf-8")

    rec_dir = root / "$RECYCLE.BIN"
    rec_dir.mkdir(parents=True, exist_ok=True)
    (rec_dir / "deleted_file.txt").write_text("ShouldNotBeDiscovered", encoding="utf-8")

    valid_dir = root / "Documents"
    valid_dir.mkdir(parents=True, exist_ok=True)
    (valid_dir / "company_plan.txt").write_text("Enterprise Strategy Document 2026", encoding="utf-8")

    ws = DesktopSearchWorkspace(
        root,
        local_data_dir=data_dir,
        embed_fn=_deterministic_embed_counter({"calls": 0, "texts": 0}),
        allow_model_download=False,
        start_watcher=False,
        start_background_workers=False,
    )
    try:
        candidates = ws._discover_candidate_files()
        candidate_names = [p.name for p in candidates]
        assert "company_plan.txt" in candidate_names
        assert "system_data.txt" not in candidate_names
        assert "deleted_file.txt" not in candidate_names

        # 3. Non-blocking sidecar warm test
        tok = "secret-test-token"
        app = create_sidecar_app(
            manager=WorkspaceManager(
                local_data_dir=data_dir,
                allow_model_download=False,
                start_watcher=False,
                start_background_workers=False,
            ),
            auth_token=tok,
        )
        with TestClient(app) as client:
            warm_resp = client.post(
                "/internal/warm",
                headers={"X-Nanvi-Sidecar-Token": tok},
                json={"folder_path": str(root), "wait_for_drain": False},
            )
            assert warm_resp.status_code == 200
            res = warm_resp.json()
            assert res["status"] == "warming"
            assert "health" in res
    finally:
        ws.close()

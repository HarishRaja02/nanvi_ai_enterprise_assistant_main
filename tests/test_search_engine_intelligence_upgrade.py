"""Tests for upgraded search engine intelligence, semantic matching, pagination, due-date logic, and entity aggregation."""
from __future__ import annotations

from datetime import date, datetime, timezone
from pathlib import Path

from backend.agents.models import AgentRequest, Capability
from backend.chat.answerers import DeterministicTestAnswerer
from backend.chat.context_engine import context_manager
from backend.chat.file_search import execute_file_search, format_transient_local_files
from backend.chat.intent_router import ChatIntent, intent_router
from backend.chat.models import ChatRequest
from backend.chat.service import ChatService
from backend.integrations.files.company_data.extraction import (
    aggregate_entities_from_documents,
    extract_invoice_records_from_files,
)
from backend.integrations.files.company_data.service import CompanyDataService
from backend.local_agent.models import FolderSyncPayload, LocalChunkRecord, LocalFileRecord
from backend.local_agent.service import get_local_agent_service
from backend.retrieval.embedding import DeterministicEmbeddingProvider
from backend.retrieval.semantic import (
    detect_entity_aggregation_intent,
    is_overdue_invoice_query,
    is_pagination_followup,
    semantic_text_similarity,
)
from backend.security.authorization import UserAttributes
from backend.security.authorization.rbac import Role


def test_intent_router_classifies_pagination_overdue_and_aggregation():
    assert is_pagination_followup("I need more")
    assert is_pagination_followup("show another set")
    assert is_pagination_followup("next 10 files")
    assert not is_pagination_followup("show overdue invoices")

    pag = intent_router.classify("I need more")
    assert pag.intent == ChatIntent.FILE_OR_DATA_QUERY
    assert pag.suggested_action == "paginate_previous_results"

    agg_emp = intent_router.classify("how many employees do I have?")
    assert agg_emp.intent == ChatIntent.FILE_OR_DATA_QUERY
    assert agg_emp.suggested_action == "entity_aggregation:employees"

    agg_cust = intent_router.classify("what are the customers I have")
    assert agg_cust.intent == ChatIntent.FILE_OR_DATA_QUERY
    assert agg_cust.suggested_action == "entity_aggregation:customers"

    ov = intent_router.classify("invoice over due files")
    assert ov.intent == ChatIntent.FILE_OR_DATA_QUERY
    assert ov.suggested_action == "structured_overdue_qa"

    conv = intent_router.classify("Good morning")
    assert conv.intent == ChatIntent.CONVERSATION


def test_invoice_date_due_date_separation_and_dynamic_overdue():
    admin = UserAttributes("u1", "t1", "Finance", frozenset({Role.ADMIN}))
    files = {
        "Uploads/mock_test_invoice.pdf": {
            "filename": "mock_test_invoice.pdf",
            "folder": "Uploads",
            "content": (
                "INVOICE\nDemo Technologies Pvt. Ltd.\n"
                "Invoice No.\nINV-2026-0042\n"
                "Invoice Date\n28 September 2026\n"
                "Due Date\n28 October 2026\n"
                "Bill To\nNanvi Solutions\n"
                "Payment Terms\nNet 30 Days\n"
                "Grand Total\n47,200.00\n"
            ),
            "full_path": "Uploads/mock_test_invoice.pdf",
        },
        "Finance/invoice_003.pdf": {
            "filename": "invoice_003.pdf",
            "folder": "Finance",
            "content": (
                "Invoice INV-00003\nField\nValue\n"
                "Invoice ID\nINV-00003\n"
                "Vendor\nCloudNova\n"
                "Invoice Date\n2025-01-31\n"
                "Customer\nBluePeak Solutions\n"
                "Total\nINR 29,571.98\n"
                "Payment Status\nOverdue\n"
            ),
            "full_path": "Finance/invoice_003.pdf",
        },
        "Finance/invoice_future.pdf": {
            "filename": "invoice_future.pdf",
            "folder": "Finance",
            "content": (
                "Invoice INV-2099-001\nVendor: CloudNova\n"
                "Customer: Acme Corp\nInvoice Date: 2099-01-01\n"
                "Due Date: 2099-01-31\nTotal: $500.00\nPayment Status: Pending\n"
            ),
            "full_path": "Finance/invoice_future.pdf",
        },
    }
    recs, _ = extract_invoice_records_from_files(
        files, lambda _u, _f: True, admin, status_filter="overdue", limit=20
    )
    ids = {r["id"] for r in recs}
    assert "INV-2026-0042" in ids
    assert "INV-00003" in ids
    assert "INV-2099-001" not in ids

    mock_rec = next(r for r in recs if r["id"] == "INV-2026-0042")
    assert mock_rec["invoice_date"] == "2026-09-28"
    assert mock_rec["due_date"] == "2026-10-28"
    assert mock_rec["is_overdue"] is True
    assert mock_rec["days_overdue"] > 0

    inv3 = next(r for r in recs if r["id"] == "INV-00003")
    assert inv3["invoice_date"] == "2025-01-31"
    assert inv3["due_date"] == ""


def test_cross_file_entity_aggregation_deduplicates_across_formats():
    docs = [
        {
            "filename": "employee_data_001.csv",
            "relative_path": "HR/employee_data_001.csv",
            "content": (
                "employee_id | name | department | role | salary | status\n"
                "E-001 | Alice Ray | Engineering | Engineer | 900000 | Active\n"
                "E-002 | Bob Chen | Sales | Manager | 1200000 | Active\n"
            ),
        },
        {
            "filename": "attendance_001.csv",
            "relative_path": "HR/attendance_001.csv",
            "content": (
                "employee_id | name | department | role | salary | status\n"
                "E-001 | Alice Ray | Engineering | Engineer | 900000 | Active\n"
                "E-003 | Cara Patel | HR | Analyst | 700000 | Probation\n"
            ),
        },
        {
            "filename": "employee_profile_004.pdf",
            "relative_path": "HR/employee_profile_004.pdf",
            "content": "Employee Profile EMP-004\nEmployee ID: EMP-004\nName: David Kim\nDepartment: AI\nRole: ML Lead\n",
        },
        {
            "filename": "customer_directory.xlsx",
            "relative_path": "Customers/customer_directory.xlsx",
            "content": (
                "Customer ID | Customer Name | Tier | Status\n"
                "--- | --- | --- | ---\n"
                "CUST-1 | Acme Corporation | Enterprise | Active\n"
                "CUST-2 | Globex Global | Enterprise | Active\n"
            ),
        },
    ]
    agg = aggregate_entities_from_documents(docs, entity_kind="all")
    assert agg["employees"]["total_count"] == 4
    assert agg["customers"]["total_count"] == 2
    assert "---" not in agg["customers"]["sample_names"]
    assert detect_entity_aggregation_intent("how many employees do I have") == "employees"
    assert detect_entity_aggregation_intent("what are the customers I have") == "customers"
    assert is_overdue_invoice_query("show me past due invoices")


def test_semantic_similarity_and_embeddings_align_synonyms():
    sim_match = semantic_text_similarity(
        "past due vendor bills",
        "Invoice INV-00003 Vendor: CloudNova Payment Status: Overdue Due Date: 2025-02-28",
    )
    sim_unrel = semantic_text_similarity(
        "past due vendor bills",
        "Office cafeteria weekly lunch menu salad soup fruit",
    )
    assert sim_match > sim_unrel and sim_match >= 0.25

    emb = DeterministicEmbeddingProvider()
    vq = emb.embed("staff headcount report")
    vd = emb.embed("employee workforce payroll roster")
    vo = emb.embed("titanium bridge girders weld thickness")
    dot_rel = sum(a * b for a, b in zip(vq, vd))
    dot_unrel = sum(a * b for a, b in zip(vq, vo))
    assert dot_rel > dot_unrel


def test_desktop_local_context_pagination_and_zero_match_no_fallback(tmp_path):
    from backend.agents.knowledge_agent import KnowledgeAgent

    user = UserAttributes("u-pag", "t-pag", "Executive", frozenset({Role.ADMIN}))
    # Verify local agent store returns strictly 0 chunks on unmatched specific queries
    svc = get_local_agent_service()
    svc.sync_folder(
        "t-pag",
        "u-pag",
        FolderSyncPayload(
            folder_id=str(tmp_path),
            folder_path=str(tmp_path),
            display_name="TestFolder",
            files=[LocalFileRecord(
                relative_path="invoice_001.pdf",
                filename="invoice_001.pdf",
                folder_name="TestFolder",
                file_type="pdf",
                size_bytes=200,
                chunk_count=1,
                modified_at="2026-05-01",
            )],
            chunks=[LocalChunkRecord(
                chunk_id="c1",
                relative_path="invoice_001.pdf",
                filename="invoice_001.pdf",
                folder_name="TestFolder",
                chunk_index=0,
                text="Invoice INV-001 Vendor CloudNova Amount $500 Due Date 2025-02-01 Payment Status Overdue",
                char_count=85,
                modified_at="2026-05-01",
            )],
        ),
    )

    ka = KnowledgeAgent()
    empty_req = AgentRequest(
        request_id="r-empty",
        user=user,
        query="medical insurance claim form mars",
    )
    resp = ka.run(empty_req)
    assert "INV-001" not in str(resp.content)
    assert not resp.sources

    zero_desktop_req = AgentRequest(
        request_id="r-zdesk",
        user=user,
        query="mars mission fuel log",
        local_context={
            "folder_path": str(tmp_path),
            "files": [],
            "chunks": [],
            "total_matches": 0,
            "zero_match": True,
            "folder_stats": {"total_files": 42, "categories": {"Finance": 20, "HR": 22}},
        },
    )
    z_resp = ka.run(zero_desktop_req)
    assert "no matching records or documents" in str(z_resp.content).lower()
    assert "Finance (20)" in str(z_resp.content)
    assert z_resp.deterministic is True

    # Test format_transient_local_files pagination banner
    sample_files = [
        {"name": f"invoice_{i:03d}.pdf", "path": f"C:/Data/invoice_{i:03d}.pdf", "type": "pdf"}
        for i in range(1, 11)
    ]
    ans, formatted, _ = format_transient_local_files(
        "invoice files", sample_files, max_results=10, offset=10, total_matches=25
    )
    assert len(formatted) == 10
    assert "11–20" in ans and "25" in ans
    assert "I need more" in ans


def test_chat_service_desktop_pagination_and_overdue_qa(tmp_path):
    from backend.agents.knowledge_agent import KnowledgeAgent
    from backend.agents.orchestrator import EnterpriseOrchestrator
    from backend.chat.service import ChatService
    from backend.chat.stores import InMemoryConversationStore
    from backend.llm.answerer import LLMChatAnswerer

    class StubProvider:
        def __init__(self):
            self.prompts = []
        def generate(self, prompt: str, *, system: str | None = None) -> str:
            self.prompts.append(prompt)
            return f"LLM_SYNTHESIZED: {prompt[:160]}"

    stub = StubProvider()
    user = UserAttributes("u-cs", "t-cs", "Executive", frozenset({Role.ADMIN}))
    orch = EnterpriseOrchestrator(agents={Capability.KNOWLEDGE: KnowledgeAgent()})
    svc = ChatService(
        orchestrator=orch,
        answerer=LLMChatAnswerer(stub),
        store=InMemoryConversationStore(),
    )

    all_22_files = [
        {
            "name": f"invoice_{i:03d}.pdf",
            "path": str(tmp_path / f"invoice_{i:03d}.pdf"),
            "full_path": str(tmp_path / f"invoice_{i:03d}.pdf"),
            "display_path": f"Finance/invoice_{i:03d}.pdf",
            "type": "pdf",
            "source": "local",
        }
        for i in range(1, 23)
    ]

    # 1. File discovery returns first 10 with pagination prompt & caches remaining 12
    req1 = ChatRequest(
        query="invoice files",
        conversation_id="conv-pag-1",
        local_context={
            "folder_path": str(tmp_path),
            "files": all_22_files[:10],
            "chunks": [{"chunk_id": "c1", "filename": "invoice_001.pdf", "text": "Invoice INV-001"}],
            "total_matches": 22,
            "all_ranked_files": all_22_files,
        },
    )
    res1 = svc.ask(user, req1)
    assert res1.file_results and len(res1.file_results) == 10
    assert res1.file_results[0]["name"] == "invoice_001.pdf"
    assert "I need more" in res1.answer or "1–10" in res1.answer

    # 2. Pagination follow-up "I need more" slices files 11-20 using cached/desktop state
    req2 = ChatRequest(
        query="I need more",
        conversation_id="conv-pag-1",
        local_context={
            "folder_path": str(tmp_path),
            "files": all_22_files[10:20],
            "chunks": [],
            "total_matches": 22,
            "offset": 10,
            "has_more": True,
        },
    )
    res2 = svc.ask(user, req2)
    assert res2.file_results and len(res2.file_results) == 10
    assert res2.file_results[0]["name"] == "invoice_011.pdf"
    assert "11–20" in res2.answer

    # 3. Structured overdue Q&A passes due-date structured summary into the LLM instead of skipping LLM
    req3 = ChatRequest(
        query="invoice overdue files",
        conversation_id="conv-pag-2",
        local_context={
            "folder_path": str(tmp_path),
            "files": all_22_files[:3],
            "chunks": [{"chunk_id": "c3", "filename": "invoice_003.pdf", "text": "Invoice Date 2025-01-31 Due Date 2025-03-01 Overdue"}],
            "structured_summary": "Found 1 overdue invoice: INV-00003 Invoice Date: 2025-01-31 Due Date: 2025-03-01",
            "total_matches": 1,
        },
    )
    res3 = svc.ask(user, req3)
    assert res3.answer.startswith("LLM_SYNTHESIZED:")
    assert stub.prompts and "INV-00003" in stub.prompts[-1]
    assert res3.file_results and len(res3.file_results) >= 1


def test_salary_indian_lakh_typo_filter_and_unconfigured_connection_hub_resilience(tmp_path):
    from backend.agents.database_agent import DatabaseAgent
    from backend.agents.email_agent import EmailAgent
    from backend.agents.google_drive_agent import GoogleDriveAgent
    from backend.agents.knowledge_agent import KnowledgeAgent
    from backend.agents.orchestrator import EnterpriseOrchestrator
    from backend.chat.service import ChatService
    from backend.chat.stores import InMemoryConversationStore
    from backend.integrations.files.company_data.extraction import filter_entities_by_numeric_query
    from backend.llm.answerer import LLMChatAnswerer
    from backend.retrieval.semantic import parse_numeric_filter_query

    spec = parse_numeric_filter_query("list the employees that they are salary was more then 10 lacks")
    assert spec is not None
    assert spec["domain"] == "employees"
    assert spec["field"] == "salary"
    assert spec["op"] == "gt"
    assert spec["min_val"] == 1_000_000.0

    # Verify numeric filtering across CSV + PDF documents excludes <= 10 lakh records
    docs = [
        {
            "filename": "employee_data_001.csv",
            "relative_path": "HR/employee_data_001.csv",
            "content": (
                "employee_id | name | department | role | salary | status\n"
                "E-101 | Asha Rao | Engineering | Engineer | 1850000 | Active\n"
                "E-102 | Vikram Sen | Sales | Analyst | 437820 | Active\n"
            ),
        },
        {
            "filename": "employee_profile_007.pdf",
            "relative_path": "HR/employee_profile_007.pdf",
            "content": (
                "Employee Profile EMP-20007\n"
                "Employee ID: EMP-20007\n"
                "Name: Employee 007\n"
                "Department: Operations\n"
                "Role: Software Engineer\n"
                "Annual Salary: INR 1,008,854\n"
                "Employment Status: On Leave\n"
            ),
        },
    ]
    f_res = filter_entities_by_numeric_query(docs, spec)
    assert f_res["total_matching"] == 2
    matched_ids = {r["id"] for r in f_res["records"]}
    assert matched_ids == {"E-101", "EMP-20007"}

    # Verify CompanyDataService handles salary filter without any external Connection Hub connectors
    hr_dir = tmp_path / "HR"
    hr_dir.mkdir(parents=True)
    (hr_dir / "employees.csv").write_text(
        "employee_id,name,department,role,salary,status\n"
        "E-201,Priya Nair,Engineering,Architect,1650000,Active\n"
        "E-202,Arun Das,Sales,Associate,550000,Active\n",
        encoding="utf-8",
    )
    user = UserAttributes("u-noconn", "t-noconn", "HR", frozenset({Role.HR}))
    cds = CompanyDataService(tmp_path, tenant_id="t-noconn")
    cds.ensure_indexed(force=True)

    class StubProvider:
        def __init__(self):
            self.prompts = []
        def generate(self, prompt: str, *, system: str | None = None) -> str:
            self.prompts.append(prompt)
            return f"LLM_ANSWER: {prompt}"

    stub = StubProvider()
    orch = EnterpriseOrchestrator(agents={
        Capability.KNOWLEDGE: KnowledgeAgent(company_data_service=cds),
        Capability.DATABASE: DatabaseAgent(tool=None),
        Capability.EMAIL: EmailAgent(email_service=None),
        Capability.GOOGLE_DRIVE: GoogleDriveAgent(connection_manager=None),
    })
    svc = ChatService(
        orchestrator=orch,
        answerer=LLMChatAnswerer(stub),
        store=InMemoryConversationStore(),
    )

    resp = svc.ask(user, ChatRequest(query="list the employees that they are salary was more then 10 lacks"))
    assert "E-201" in resp.answer or "Priya Nair" in resp.answer
    assert "E-202" not in resp.answer
    assert "not configured" not in resp.answer.lower()
    assert "not connected" not in resp.answer.lower()


def test_precision_exact_id_paid_unpaid_year_and_lpa_desktop_search(tmp_path):
    from backend.agents.knowledge_agent import KnowledgeAgent
    from backend.agents.orchestrator import EnterpriseOrchestrator
    from backend.chat.service import ChatService
    from backend.chat.stores import InMemoryConversationStore
    from backend.desktop_search.models import SearchFilter
    from backend.desktop_search.orchestrator import DesktopSearchWorkspace
    from backend.llm.answerer import LLMChatAnswerer

    docs = tmp_path / "docs"
    data_dir = tmp_path / "appdata"
    fin = docs / "Finance"
    hr = docs / "HR"
    con = docs / "Contracts"
    for p in (fin, hr, con):
        p.mkdir(parents=True)

    # Deliberately index as .txt files for pure text precision check alongside Contracts/PDF_Employment
    (con / "NDA-0008.txt").write_text(
        "Mutual NDA NDA-0008\nParty A: Asteron Technologies\nParty B: SecureNet",
        encoding="utf-8",
    )
    (con / "NDA-0001.txt").write_text(
        "Mutual NDA NDA-0001\nParty A: Alpha Corp\nParty B: Beta Corp",
        encoding="utf-8",
    )
    (con / "EMP-0008.txt").write_text(
        "Employment Agreement EMP-0008\nEmployee: Employee 1008\nAnnual Compensation: INR 1,500,000",
        encoding="utf-8",
    )
    (con / "master_services_agreement.txt").write_text(
        "Master Services Agreement referencing contract and NDA obligations.",
        encoding="utf-8",
    )
    (hr / "leave_and_vacation_policy.txt").write_text(
        "Paid leave and paid holiday policy for full-time staff.",
        encoding="utf-8",
    )
    (hr / "employee_data.csv").write_text(
        "employee_id,name,department,role,salary,status\n"
        "E-1,Asha Rao,Engineering,Architect,2190000,Active\n"
        "E-2,Vikram Sen,Sales,Manager,1450000,Active\n",
        encoding="utf-8",
    )
    (fin / "invoice_008.txt").write_text(
        "Invoice INV-00008\nVendor: CloudNova\nInvoice Date: 2026-01-03\n"
        "Customer: Vertex Logistics\nTotal: INR 106,984.70\nPayment Status: Paid\n",
        encoding="utf-8",
    )
    (fin / "invoice_004.txt").write_text(
        "Invoice INV-00004\nVendor: Prime Telecom\nInvoice Date: 2025-01-28\n"
        "Customer: BluePeak Solutions\nTotal: INR 174,199.86\nPayment Status: Overdue\n",
        encoding="utf-8",
    )
    (fin / "invoice_015.txt").write_text(
        "Invoice INV-00015\nVendor: DataBridge\nInvoice Date: 2026-04-19\n"
        "Customer: Nexa Retail\nTotal: INR 117,965.78\nPayment Status: Overdue\n",
        encoding="utf-8",
    )
    (hr / "employee_handbook_2026.txt").write_text(
        "Employee Handbook 2026 policies and benefits.",
        encoding="utf-8",
    )

    ws = DesktopSearchWorkspace(
        docs,
        local_data_dir=data_dir,
        allow_model_download=False,
        start_watcher=False,
        start_background_workers=False,
    )
    try:
        ws.scan_and_sync(drain_outbox=True)
        sf = SearchFilter(tenant_id="default-tenant", user_id="ceo2", role="Superior", roles=("Superior", "CEO"))

        # 1. Exact ID "NDA-0008" returns ONLY matching NDA-0008 files (never EMP-0008, NDA-0001, or agreements)
        res_id = ws.search("NDA-0008", search_filter=sf)
        assert [f["name"] for f in res_id.files] == ["NDA-0008.txt"]

        # 2. "invoice that was already paid" returns ONLY Paid invoices (never Overdue 004/015 or Paid Leave)
        res_paid = ws.search("invoice that was already paid", search_filter=sf)
        assert [f["name"] for f in res_paid.files] == ["invoice_008.txt"]
        assert "INV-00008" in res_paid.structured_summary
        assert "INV-00004" not in res_paid.structured_summary

        # 3. "list the customres they did'n paid" groups unpaid customers cleanly with zero HR noise
        res_unpaid = ws.search("list the customres they did'n paid", search_filter=sf)
        unpaid_names = {f["name"] for f in res_unpaid.files}
        assert unpaid_names == {"invoice_004.txt", "invoice_015.txt"}
        assert "BluePeak Solutions" in res_unpaid.structured_summary
        assert "Nexa Retail" in res_unpaid.structured_summary
        assert "leave_and_vacation_policy" not in res_unpaid.structured_summary

        # 4. "2026 invoic" and "invoice that created on 2026" return ONLY 2026 invoices (not 2025 or handbook_2026)
        for q_2026 in ("2026 invoic", "invoice that created on 2026"):
            res_26 = ws.search(q_2026, search_filter=sf)
            names_26 = {f["name"] for f in res_26.files}
            assert names_26 == {"invoice_008.txt", "invoice_015.txt"}

        # 5. "employee salary more then 30lpa" parses 30lpa -> 0 matches with honest highest salary & empty file list
        res_sal = ws.search("employee salary more then 30lpa", search_filter=sf)
        assert res_sal.files == []
        assert res_sal.zero_match is False
        assert "0 employees" in res_sal.structured_summary
        assert "2,190,000" in res_sal.structured_summary

        # 6. Verify ChatService preserves structured_summary even when LLM fails/refuses (zero blank summary!)
        class FailingProvider:
            def generate(self, prompt: str, *, system: str | None = None) -> str:
                return "How can I assist you with your invoices or payments today?"

        user = UserAttributes("ceo2", "t1", "Executive", frozenset({Role.SUPERIOR}))
        orch = EnterpriseOrchestrator(agents={Capability.KNOWLEDGE: KnowledgeAgent()})
        svc = ChatService(
            orchestrator=orch,
            answerer=LLMChatAnswerer(FailingProvider()),
            store=InMemoryConversationStore(),
        )
        chat_res = svc.ask(
            user,
            ChatRequest(
                query="employee salary more then 30lpa",
                local_context=res_sal.to_dict(),
            ),
        )
        assert "2,190,000" in chat_res.answer
        assert "How can I assist" not in chat_res.answer
    finally:
        ws.close()


def test_compound_filters_alternation_and_strict_zero_match_validation(tmp_path):
    from backend.desktop_search.models import SearchFilter
    from backend.desktop_search.orchestrator import DesktopSearchWorkspace

    docs = tmp_path / "docs"
    data_dir = tmp_path / "appdata"
    fin = docs / "Finance"
    con = docs / "Contracts"
    hr = docs / "HR"
    for p in (fin, con, hr):
        p.mkdir(parents=True)

    (fin / "invoice_008.txt").write_text(
        "Invoice INV-00008\nVendor: CloudNova\nInvoice Date: 2026-01-03\n"
        "Customer: Vertex Logistics\nTotal: INR 106,984.70\nPayment Status: Paid\n",
        encoding="utf-8",
    )
    (fin / "invoice_010.txt").write_text(
        "Invoice INV-00010\nVendor: CloudNova\nInvoice Date: 2025-10-28\n"
        "Customer: Vertex Logistics\nTotal: INR 112,454.00\nPayment Status: Overdue\n",
        encoding="utf-8",
    )
    (fin / "invoice_004.txt").write_text(
        "Invoice INV-00004\nVendor: Prime Telecom\nInvoice Date: 2025-01-28\n"
        "Customer: BluePeak Solutions\nTotal: INR 174,199.86\nPayment Status: Overdue\n",
        encoding="utf-8",
    )
    (fin / "travel_and_expense_policy.txt").write_text(
        "Corporate Travel and Expense Payment Reimbursement Policy.",
        encoding="utf-8",
    )
    (fin / "annual_budget_forecast_2026.txt").write_text(
        "Annual Corporate Budget 2026 Payment Schedule Order Overview.",
        encoding="utf-8",
    )
    (con / "PUR-0001.txt").write_text(
        "Purchase Agreement PUR-0001\nAgreement ID: PUR-0001\nBuyer: Asteron Technologies\n",
        encoding="utf-8",
    )
    (con / "NDA-0008.txt").write_text(
        "Mutual NDA NDA-0008\nParty A: Asteron Technologies\n",
        encoding="utf-8",
    )
    (con / "README.txt").write_text(
        "Folder README listing payment terms and general order notes.",
        encoding="utf-8",
    )

    ws = DesktopSearchWorkspace(
        docs,
        local_data_dir=data_dir,
        allow_model_download=False,
        start_watcher=False,
        start_background_workers=False,
    )
    try:
        ws.scan_and_sync(drain_outbox=True)
        sf = SearchFilter(tenant_id="default-tenant", user_id="ceo2", role="Superior", roles=("Superior", "CEO"))

        # 1. Combined customer + overdue status must return ONLY Vertex Logistics overdue invoice (never BluePeak or Vertex Paid)
        r_v_ov = ws.search("Vertex Logistics invoice files that was overdue", search_filter=sf)
        assert [f["name"] for f in r_v_ov.files] == ["invoice_010.txt"]
        assert "INV-00010" in r_v_ov.structured_summary
        assert "BluePeak Solutions" not in r_v_ov.structured_summary
        assert " | " not in r_v_ov.structured_summary

        # 2. Entity-only invoice filter returns strictly Vertex Logistics invoices
        r_v_all = ws.search("Vertex Logistics invoice files", search_filter=sf)
        assert {f["name"] for f in r_v_all.files} == {"invoice_008.txt", "invoice_010.txt"}

        # 3. Compound filter with 0 matches ("Vertex Logistics 2027 overdue invoices") returns [] (never BluePeak padding!)
        r_v_2027 = ws.search("Vertex Logistics 2027 overdue invoices", search_filter=sf)
        assert r_v_2027.files == []
        assert "No overdue year 2027 invoice records for **Vertex Logistics**" in r_v_2027.structured_summary
        assert "other invoice(s) on file" in r_v_2027.structured_summary

        # 4. Alternation OR query ("Find payment receipt or purchase order files") validates branches & avoids README/travel noise
        r_po = ws.search("Find payment receipt or purchase order files", search_filter=sf)
        assert [f["name"] for f in r_po.files] == ["PUR-0001.txt"]
        assert "payment receipt" in r_po.structured_summary.lower()

        # 5. Multi-constraint general query with 0 overlap ("Vertex Logistics NDA") returns [] cleanly instead of padding
        r_zero_mix = ws.search("Vertex Logistics NDA", search_filter=sf)
        assert r_zero_mix.files == []
        assert "No documents matching **all** criteria" in r_zero_mix.structured_summary
    finally:
        ws.close()




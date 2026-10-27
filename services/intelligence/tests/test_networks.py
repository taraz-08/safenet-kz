"""Public graph behavior through HTTP, using only isolated synthetic fixtures."""
from datetime import timedelta
from contextvars import ContextVar
from concurrent.futures import ThreadPoolExecutor
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, event, select
from sqlalchemy.orm import sessionmaker

from safenet import app as api, store
from safenet.models import Base, ScanTask, ScannedContent, RiskAssessment, utcnow
from safenet.networks import account_url


@pytest.fixture
def graph(tmp_path, monkeypatch):
    engine = create_engine("sqlite:///" + str(tmp_path / "networks.sqlite"), connect_args={"check_same_thread": False})
    Base.metadata.create_all(engine)
    sessions = sessionmaker(engine, expire_on_commit=False)
    monkeypatch.setattr(store, "Session", sessions)
    monkeypatch.setattr(api.settings, "local_admin", False)
    statements = []
    in_request = ContextVar("networks_test_request", default=False)

    def record_statement(conn, cursor, statement, *args):
        # The suite can leave scheduler threads alive across fixture boundaries.
        # Context propagates from ASGI into AnyIO's sync route worker, while an
        # unrelated pre-existing thread cannot acquire this request's marker.
        if in_request.get():
            statements.append(statement)

    event.listen(engine, "before_cursor_execute", record_statement)

    async def request_app(scope, receive, send):
        token = in_request.set(True)
        try:
            await api.app(scope, receive, send)
        finally:
            in_request.reset(token)

    def add(url="https://t.me/alpha_news/12", text="", links=None, **kw):
        metadata = kw.pop("metadata", {"collector": "public_http", "authenticated": False, "source_url": url})
        score = kw.pop("score", 65)
        evidence = kw.pop("evidence", [{"weight": 30, "quote": "Fixture rule evidence"}])
        with sessions.begin() as db:
            task = ScanTask(url=url, platform="telegram", status=kw.pop("status", "completed"), completed_at=utcnow(), **kw)
            db.add(task)
            db.flush()
            db.add(ScannedContent(task_id=task.id, text=text, links=links or [], source_metadata=metadata))
            db.add(RiskAssessment(task_id=task.id, score=score, level="high" if score >= 60 else "low", category="unknown", analysis={"evidence": evidence}))
            return task.id

    # No lifespan: tests must never start scheduler jobs or modify the real DB.
    client = TestClient(request_app)
    try:
        yield SimpleNamespace(client=client, add=add, Session=sessions, statements=statements)
    finally:
        client.close()
        engine.dispose()


def read(graph, mode="live"):
    response = graph.client.get("/api/v1/networks", params={"mode": mode})
    assert response.status_code == 200, response.text
    assert response.headers["cache-control"] == "no-store"
    return response.json()


def test_guest_citations_deduplicate_accounts_preserve_risk_and_never_mutate(graph):
    first = graph.add("https://t.me/s/Alpha_News/12", links=["https://telegram.me/beta_news/3", "https://t.me/beta_news/3"])
    graph.add("http://telegram.me/alpha_news/13?utm_source=test")
    second = graph.add("https://t.me/beta_news/3", score=0, evidence=[])
    graph.statements.clear()
    data = read(graph)
    assert len(graph.statements) == 1
    assert graph.statements[0].lstrip().startswith("SELECT")
    assert len(data["nodes"]) == 2 and len(data["edges"]) == 1
    assert next(node for node in data["nodes"] if node["id"].endswith("alpha_news"))["scan_count"] == 2
    edge = data["edges"][0]
    assert edge["kind"] == "citation" and edge["source"].endswith("alpha_news")
    assert edge["citations"][0]["scan_id"] == first
    assert edge["citations"][0]["quote"] == "https://telegram.me/beta_news/3"
    assert next(node for node in data["nodes"] if node["scan_id"] == second)["score"] == 0
    with graph.Session() as db:
        assert db.scalar(select(RiskAssessment.score).where(RiskAssessment.task_id == second)) == 0
    assert graph.client.post("/api/v1/networks").status_code == 405


def test_sql_observer_excludes_unrelated_thread_but_catches_request_writes(graph, monkeypatch):
    with ThreadPoolExecutor(max_workers=1) as pool:
        pool.submit(store.audit, "fixture_background", "Unrelated background write").result()
    assert graph.statements == []
    # Exercise a real write in an AnyIO route worker, without changing auth state.
    monkeypatch.setattr(api, "login", lambda request, code: "fixture-token")
    response = graph.client.post("/api/v1/session", json={"code": "fixture-code"})
    assert response.status_code == 200
    assert any(statement.lstrip().startswith("INSERT INTO audit_logs") for statement in graph.statements)


def test_specific_promo_and_referral_have_two_scan_citations(graph):
    a = graph.add(text="Промокод: TARAZ2026", links=["https://campaign.example/join?ref=AgentA724&other=x"])
    b = graph.add("https://t.me/beta_news/1", text="Promo code taraz2026", links=["https://campaign.example/register?ref=AgentA724"])
    data = read(graph)
    assert {edge["kind"] for edge in data["edges"]} == {"promo", "referral"}
    for edge in data["edges"]:
        assert {citation["scan_id"] for citation in edge["citations"]} == {a, b}
        assert all(citation["quote"] and citation["source_url"] for citation in edge["citations"])


@pytest.mark.parametrize("text,links", [
    ("", ["https://youtube.com", "https://instagram.com", "https://campaign.example/join"]),
    ("Промокод BONUS2026. Promo code WELCOME10", []),
    ("Промокод: SALE20", ["https://campaign.example/?utm_campaign=AgentA724"]),
    ("", ["https://youtube.com/watch?v=abcdefghijk&ref=AgentA724"]),
    ("", ["https://t.me/share/url?ref=AgentA724", "https://campaign.example/?ref=welcome"]),
])
def test_common_domains_generic_codes_and_tracking_do_not_group(graph, text, links):
    graph.add(text=text, links=links)
    graph.add("https://t.me/beta_news/1", text=text, links=links)
    assert read(graph)["edges"] == []


def test_same_referral_on_different_sites_or_different_case_is_not_shared(graph):
    graph.add(links=["https://one.example/?ref=AgentA724"])
    graph.add("https://t.me/beta_news/1", links=["https://two.example/?ref=AgentA724", "https://one.example/?ref=agenta724"])
    assert read(graph)["edges"] == []


@pytest.mark.parametrize("changes", [
    {"input_text": "operator submitted text"}, {"input_media": {"file": "private.mp4"}},
    {"status": "blocked"}, {"status": "failed"}, {"status": "running"}, {"mode": "demo"},
    {"metadata": {"origin": "uploaded_media", "source_url": "https://t.me/pretended_author/1", "independently_fetched": False}},
    {"metadata": {"source_url": "https://t.me/pretended_author/1"}},
    {"metadata": {"collector": "public_http", "authenticated": True, "source_url": "https://t.me/pretended_author/1"}},
])
def test_unverified_upload_manual_unfinished_and_other_mode_are_excluded(graph, changes):
    graph.add(text="Промокод TARAZ2026 private fixture", **changes)
    data = read(graph)
    assert data["nodes"] == [] and data["edges"] == []
    assert "private fixture" not in str(data)


def test_demo_never_borrows_live_accounts_or_attributes_synthetic_text(graph):
    graph.add(text="Промокод TARAZ2026")
    graph.add("https://t.me/beta_news/1", mode="demo", text="Промокод TARAZ2026")
    assert len(read(graph)["nodes"]) == 1
    assert read(graph, "demo")["nodes"] == []
    assert graph.client.get("/api/v1/networks?mode=other").status_code == 422


def test_model_only_or_low_risk_matches_do_not_create_connections(graph):
    graph.add(text="Промокод TARAZ2026")
    graph.add("https://t.me/beta_news/1", text="Промокод TARAZ2026", evidence=[])
    graph.add("https://t.me/gamma_news/1", text="Промокод TARAZ2026", score=0)
    assert read(graph)["edges"] == []


def test_self_links_and_repeated_captures_never_create_a_network(graph):
    for i in range(3):
        graph.add(f"https://t.me/alpha_news/{i + 1}", text="Промокод TARAZ2026", links=["https://t.me/s/alpha_news/99"])
    data = read(graph)
    assert len(data["nodes"]) == 1 and data["edges"] == []


def test_edge_limit_is_explicit_and_bounded(graph):
    for i in range(47):
        graph.add(f"https://t.me/fixture_{i}/1", text="Промокод TARAZ2026")
    data = read(graph)
    assert len(data["edges"]) == 1000
    assert data["summary"]["edges_truncated"] is True


def test_history_is_labeled_and_final_capture_url_is_used(graph):
    scan = graph.add("https://t.me/submitted_account/1", metadata={"origin": "legacy_public_capture", "source": "telegram_discovery", "source_url": "https://t.me/captured_account/1"})
    node = read(graph)["nodes"][0]
    assert node["id"] == "https://t.me/captured_account"
    assert node["scan_id"] == scan and node["provenance"] == "historical_public"


def test_recent_window_is_bounded(graph):
    for i in range(501):
        graph.add(created_at=utcnow() - timedelta(days=i))
    data = read(graph)
    assert data["summary"]["scans_considered"] == 500
    assert data["summary"]["window_full"] is True
    assert data["nodes"][0]["scan_count"] == 500


@pytest.mark.parametrize("url,expected", [
    ("https://www.tiktok.com/@Creator/video/1234", "https://www.tiktok.com/@creator"),
    ("https://threads.net/@Creator/post/AbC", "https://www.threads.com/@creator"),
    ("https://instagram.com/Creator/", "https://www.instagram.com/creator"),
    ("https://instagram.com/p/AbC/", None),
    ("https://youtube.com/watch?v=abcdefghijk", None),
    ("https://t.me/share/url", None),
    ("https://t.me.evil.example/creator", None),
])
def test_account_identity_does_not_guess_from_anonymous_posts(url, expected):
    result = account_url(url)
    assert (result[1] if result else None) == expected

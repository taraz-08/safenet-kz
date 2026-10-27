"""Offline API/worker integration tests; no shared conftest or corpus fixtures.

Only dispatch and external I/O are replaced. Each test uses the real routes,
SQLAlchemy persistence, scheduler decisions, worker, and deterministic analyzer.
"""

from datetime import timedelta
import json
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, event, func, select
from sqlalchemy.engine import URL
from sqlalchemy.orm import sessionmaker

from safenet import app as api
from safenet import collectors, runner, safe_fetch, store
from safenet.models import (
    Agent, AuditLog, Base, Evidence, Report, RiskAssessment, ScanTask, ScannedContent, utcnow,
)


PREFIX = "/api/v1"
PUBLIC_URL = "https://www.youtube.com/watch?v=abcdefghijk"
PUBLIC_IP = "93.184.216.34"
RISK_TEXT = (
    "Invest today for guaranteed returns. Invite friends and earn commission "
    "for each recruit. Double your money. Act now!"
)
BENIGN_TEXT = "The public library opens at nine and holds a reading club on Tuesday."
SCAN_FIELDS = {
    "id", "url", "title", "platform", "mode", "status", "stage", "created_at",
    "completed_at", "score", "level", "category", "text", "analysis", "error",
    "review", "agent_id", "metadata",
}
AGENT_FIELDS = {
    "id", "name", "platform", "enabled", "status", "stage", "last_error",
    "last_run_at", "next_run_at", "seeds", "interval_seconds", "checked", "flagged",
}


@pytest.fixture
def workflow(tmp_path, monkeypatch):
    # A file, not :memory:, is shared by TestClient's thread and the manual worker.
    from safenet import llm

    engine = create_engine(
        URL.create("sqlite", database=str(tmp_path / "workflow.sqlite")),
        connect_args={"check_same_thread": False},
    )

    @event.listens_for(engine, "connect")
    def foreign_keys(connection, _):
        connection.execute("PRAGMA foreign_keys=ON")

    sessions = sessionmaker(engine, expire_on_commit=False)
    for module in (store, api, runner):
        monkeypatch.setattr(module, "Session", sessions)
    monkeypatch.setattr(store, "engine", engine)
    for key, value in {
        "database_url": str(engine.url), "queue": "local", "scheduler_enabled": False,
        "local_admin": True, "admin_code": "workflow-test-admin-secret",
        "allowed_origins": "http://testserver,http://localhost:3000",
        "secure_cookie": False, "max_tasks": 100,
    }.items():
        monkeypatch.setattr(api.settings, key, value)
    for key in ("SAFENET_LLM_API_KEY", "SAFENET_LLM_MODEL", "SAFENET_YOUTUBE_API_KEY"):
        monkeypatch.delenv(key, raising=False)
    dispatch = Mock(name="dispatch")
    collect = AsyncMock(side_effect=AssertionError("Unexpected collector I/O"))
    dns = AsyncMock(return_value=[PUBLIC_IP])
    explain = AsyncMock(return_value={
        "status": "disabled", "provider": "none", "explanation": "", "citations": [],
    })
    monkeypatch.setattr(runner, "dispatch", dispatch)
    monkeypatch.setattr(collectors, "collect", collect)
    monkeypatch.setattr(safe_fetch, "_resolve", dns)
    monkeypatch.setattr(safe_fetch, "_request_once", AsyncMock(
        side_effect=AssertionError("Real HTTP is forbidden in workflow tests"),
    ))
    monkeypatch.setattr(llm, "explain_with_llm", explain)
    Base.metadata.create_all(engine)
    try:
        with TestClient(api.app, raise_server_exceptions=False) as client:
            yield SimpleNamespace(
                client=client, Session=sessions, dispatch=dispatch, collect=collect,
                dns=dns, explain=explain,
            )
    finally:
        engine.dispose()


def queued(workflow, **body):
    response = workflow.client.post(PREFIX + "/scans", json=body)
    assert response.status_code == 202, response.text
    scan = response.json()
    assert SCAN_FIELDS <= scan.keys()
    assert scan["status"] == "queued"
    assert scan["completed_at"] is None
    assert_unscored(scan)
    workflow.dispatch.assert_called_with(scan["id"])
    return scan


def completed(workflow, **body):
    task = queued(workflow, **body)
    runner.execute(task["id"])
    response = workflow.client.get(PREFIX + "/scans/" + task["id"])
    assert response.status_code == 200, response.text
    scan = response.json()
    assert scan["status"] == "completed", scan
    assert scan["completed_at"]
    assert scan["error"] is None
    assert 0 <= scan["score"] <= 100
    assert scan["analysis"]["score"] == scan["score"]
    assert scan["analysis"]["method"] == "rules"
    return scan


def assert_unscored(scan):
    for key in ("score", "level", "category", "analysis"):
        assert scan[key] is None, (key, scan)


def public_content(**overrides):
    result = {
        "status": "completed", "url": PUBLIC_URL, "title": "Public test post",
        "text": RISK_TEXT, "links": [], "metadata": {"origin": "public_http"},
        "reason": None, "screenshot_path": None,
    }
    result.update(overrides)
    return result


def configured_agent(workflow):
    response = workflow.client.patch(PREFIX + "/agents/youtube", json={
        "seeds": [PUBLIC_URL], "interval_seconds": 60,
    })
    assert response.status_code == 200, response.text
    response = workflow.client.post(PREFIX + "/agents/youtube/start")
    assert response.status_code == 200, response.text
    assert response.json()["enabled"] is True
    tasks = workflow.client.get(PREFIX + "/scans").json()["items"]
    assert len(tasks) == 1
    return tasks[0]


def test_fresh_install_has_real_empty_states_and_no_credentials(workflow):
    client = workflow.client
    # Reinitialization must not duplicate agents or seed synthetic activity.
    store.initialize()
    health = client.get(PREFIX + "/health")
    assert health.status_code == 200
    assert {"status", "database", "queue", "llm", "browser", "version"} <= health.json().keys()
    assert health.json()["status"] == "ok"
    assert health.json()["database"] == "sqlite"
    assert health.json()["queue"] == "local_thread_pool"
    settings = client.get(PREFIX + "/settings")
    assert settings.status_code == 200
    assert {"capabilities", "retention_days", "mode", "queue", "llm", "browser"} <= settings.json().keys()
    assert settings.json()["llm"] == "disabled"
    assert "workflow-test-admin-secret" not in settings.text + health.text
    assert "admin_code" not in settings.text
    agents = client.get(PREFIX + "/agents").json()["items"]
    assert {a["id"] for a in agents} == {"tiktok", "instagram", "youtube", "threads", "telegram"}
    # Availability now reflects installed local models and OCR dependencies.
    assert isinstance(health.json()["video_analysis"], bool)
    assert isinstance(health.json()["audio_transcription"], bool)
    assert health.json()["media_processing"]["max_bytes"] == 64 * 1024 * 1024
    assert health.json()["media_processing"]["max_seconds"] == 120
    for agent in agents:
        assert AGENT_FIELDS <= agent.keys()
        assert agent["enabled"] is False
        assert agent["checked"] == agent["flagged"] == 0
        assert agent["seeds"] == []
    for mode in ("live", "demo"):
        overview = client.get(PREFIX + "/overview", params={"mode": mode}).json()
        assert overview["mode"] == mode
        assert overview["totals"] == {"scanned": 0, "suspicious": 0, "critical": 0, "active_agents": 0}
        assert overview["recent"] == overview["timeline"] == []
        assert all(row["count"] == 0 for row in overview["distribution"])
        assert client.get(PREFIX + "/scans", params={"mode": mode}).json() == {"items": [], "total": 0}
    assert client.get(PREFIX + "/reports").json() == {"items": []}
    workflow.dispatch.assert_not_called()
    workflow.collect.assert_not_awaited()
    workflow.dns.assert_not_awaited()


@pytest.mark.parametrize("locale", ["ru", "kk", "en"])
def test_manual_workflow_persists_rule_evidence_and_is_explicitly_manual(workflow, locale):
    scan = completed(workflow, text=RISK_TEXT, locale=locale, platform="instagram")
    assert scan["platform"] == "manual"
    assert scan["url"] == ""
    assert scan["agent_id"] is None
    assert scan["text"] == RISK_TEXT
    assert scan["metadata"]["origin"] == "manual"
    assert scan["metadata"]["independently_fetched"] is False
    assert scan["analysis"]["language"] == locale
    assert scan["score"] >= 30
    evidence = scan["analysis"]["evidence"]
    assert evidence
    assert scan["analysis"]["recommendations"]
    assert scan["analysis"]["limitations"]
    for item in evidence:
        assert {"code", "label", "quote", "weight", "source_url"} <= item.keys()
        assert item["quote"] and item["quote"] in scan["text"]
    with workflow.Session() as db:
        stored = db.scalar(select(RiskAssessment).where(RiskAssessment.task_id == scan["id"]))
        assert stored.score == scan["score"]
        rows = list(db.scalars(select(Evidence).where(Evidence.assessment_id == stored.id)))
        assert {(r.code, r.quote, r.weight) for r in rows} == {
            (e["code"], e["quote"], e["weight"]) for e in evidence
        }
    before = workflow.client.get(PREFIX + "/overview").json()
    runner.execute(scan["id"])
    assert workflow.client.get(PREFIX + "/overview").json() == before
    workflow.explain.assert_awaited_once()
    assert workflow.explain.await_args.kwargs["locale"] == locale
    workflow.collect.assert_not_awaited()
    workflow.dns.assert_not_awaited()


def test_public_url_uses_real_collected_source_and_progress(workflow):
    async def collect(url, *, platform, on_event):
        assert url == PUBLIC_URL
        assert platform == "youtube"
        await on_event({"stage": "extracting", "message": "Reading public test post"})
        return public_content()

    workflow.collect.side_effect = collect
    scan = completed(workflow, url=PUBLIC_URL, platform="instagram", locale="en")
    assert scan["platform"] == "youtube"
    assert scan["title"] == "Public test post"
    assert scan["text"] == RISK_TEXT
    assert scan["metadata"]["source_url"] == PUBLIC_URL
    assert scan["metadata"]["collected_at"]
    assert scan["metadata"]["screenshot_available"] is False
    assert scan["score"] >= 30
    assert all(e["source_url"] == PUBLIC_URL for e in scan["analysis"]["evidence"])
    workflow.collect.assert_awaited_once()
    workflow.dns.assert_awaited_once()
    with workflow.Session() as db:
        stages = list(db.scalars(select(AuditLog.stage).where(AuditLog.task_id == scan["id"])))
    assert {"queued", "opening", "extracting", "analyzing", "saving", "completed"} <= set(stages)


def test_demo_isolation_in_lists_filters_totals_and_timeline(workflow):
    live = completed(workflow, text=BENIGN_TEXT, mode="live", locale="en")
    demo = completed(workflow, text=RISK_TEXT, mode="demo", locale="en")
    assert live["score"] == 0
    assert demo["score"] >= 30
    assert demo["metadata"]["origin"] == "synthetic"
    assert demo["metadata"]["independently_fetched"] is False
    for mode, scan in (("live", live), ("demo", demo)):
        listing = workflow.client.get(PREFIX + "/scans", params={"mode": mode}).json()
        assert listing["total"] == 1
        assert [item["id"] for item in listing["items"]] == [scan["id"]]
        overview = workflow.client.get(PREFIX + "/overview", params={"mode": mode}).json()
        assert overview["totals"]["scanned"] == 1
        assert overview["totals"]["suspicious"] == int(scan["score"] >= 30)
        assert overview["totals"]["critical"] == int(scan["level"] == "critical")
        assert [row["id"] for row in overview["recent"]] == [scan["id"]]
        assert sum(row["count"] for row in overview["distribution"]) == 1
        assert sum(row["count"] for row in overview["timeline"]) == 1
        assert sum(row["suspicious"] for row in overview["timeline"]) == int(scan["score"] >= 30)
    assert workflow.client.get(PREFIX + "/scans", params={"level": demo["level"]}).json()["total"] == 0
    assert workflow.client.get(PREFIX + "/scans").json()["items"][0]["id"] == live["id"]
    workflow.collect.assert_not_awaited()


def test_scan_filters_and_pagination_keep_total_before_slicing(workflow):
    risk = completed(workflow, text=RISK_TEXT)
    benign = completed(workflow, text=BENIGN_TEXT)
    completed(workflow, text=RISK_TEXT, mode="demo")
    all_live = workflow.client.get(PREFIX + "/scans").json()
    assert all_live["total"] == 2
    assert {row["id"] for row in all_live["items"]} == {risk["id"], benign["id"]}
    for offset in (0, 1, 2):
        page = workflow.client.get(PREFIX + "/scans", params={"limit": 1, "offset": offset}).json()
        assert page["total"] == 2
        assert page["items"] == all_live["items"][offset:offset + 1]
    filtered = workflow.client.get(PREFIX + "/scans", params={"level": risk["level"], "platform": "manual"}).json()
    assert filtered["total"] == 1
    assert filtered["items"][0]["id"] == risk["id"]
    assert workflow.client.get(PREFIX + "/scans", params={"platform": "youtube"}).json() == {"items": [], "total": 0}


@pytest.mark.parametrize("outcome", ["blocked", "unavailable", "exception"])
def test_failed_collectors_never_create_assessments_or_success_counts(workflow, monkeypatch, outcome):
    from safenet import analysis

    analyze = Mock(wraps=analysis.analyze)
    monkeypatch.setattr(analysis, "analyze", analyze)
    if outcome == "exception":
        workflow.collect.side_effect = RuntimeError("private transport failure details")
    else:
        workflow.collect.side_effect = None
        # A failure may contain partial text with obvious signals. It is not an assessment.
        workflow.collect.return_value = public_content(status=outcome, reason="Public access unavailable")
    task = configured_agent(workflow)
    runner.execute(task["id"])
    scan = workflow.client.get(PREFIX + "/scans/" + task["id"]).json()
    assert scan["status"] == ("blocked" if outcome == "blocked" else "failed")
    assert scan["completed_at"] and scan["error"]
    assert "private transport failure details" not in scan["error"]
    assert_unscored(scan)
    analyze.assert_not_called()
    workflow.explain.assert_not_awaited()
    with workflow.Session() as db:
        for model in (RiskAssessment, Evidence, ScannedContent):
            assert db.scalar(select(func.count()).select_from(model)) == 0
    overview = workflow.client.get(PREFIX + "/overview").json()
    assert overview["totals"]["scanned"] == overview["totals"]["suspicious"] == 0
    assert overview["timeline"] == []
    assert sum(row["count"] for row in overview["distribution"]) == 0
    agent = next(a for a in overview["agents"] if a["id"] == "youtube")
    assert agent["checked"] == agent["flagged"] == 0
    assert workflow.client.post(PREFIX + "/reports", json={"scan_id": task["id"]}).status_code == 409
    assert workflow.client.post(PREFIX + "/scans/" + task["id"] + "/review", json={"decision": "confirmed_signals"}).status_code == 409
    assert workflow.client.post(PREFIX + "/assistant", json={"question": "Why?", "scan_id": task["id"]}).status_code == 409


@pytest.mark.parametrize("decision", ["confirmed_signals", "false_positive", "needs_context"])
def test_human_review_and_report_preserve_the_stored_assessment(workflow, decision):
    scan = completed(workflow, text=RISK_TEXT, locale="en")
    client = workflow.client
    note = "Operator reviewed the quoted context."
    response = client.post(PREFIX + "/scans/" + scan["id"] + "/review", json={"decision": decision, "note": note})
    assert response.status_code == 200, response.text
    reviewed = response.json()
    assert reviewed["review"]["decision"] == decision
    assert reviewed["review"]["note"] == note
    assert reviewed["review"]["reviewer"] == "administrator"
    assert reviewed["review"]["at"]
    assert reviewed["analysis"] == scan["analysis"]
    assert reviewed["score"] == scan["score"]
    assert client.get(PREFIX + "/scans/" + scan["id"]).json() == reviewed
    response = client.post(PREFIX + "/reports", json={"scan_id": scan["id"]})
    assert response.status_code in (200, 201), response.text
    report = response.json()
    assert {"id", "scan_id", "created_at", "title", "markdown"} <= report.keys()
    assert report["scan_id"] == scan["id"]
    markdown = report["markdown"]
    for expected in ("not proof of fraud or a legal verdict", "not independently fetched", "Mode: live", decision, note, scan["analysis"]["summary"], f"{scan['score']}/100"):
        assert expected in markdown
    for evidence in scan["analysis"]["evidence"]:
        assert evidence["quote"] in markdown
        assert evidence["label"] in markdown
    assert client.get(PREFIX + "/reports/" + report["id"]).json() == report
    assert client.get(PREFIX + "/reports").json()["items"] == [report]
    # Later review is mutable; an already generated document is a persisted snapshot.
    assert client.post(PREFIX + "/scans/" + scan["id"] + "/review", json={"decision": "needs_context", "note": "Follow-up review"}).status_code == 200
    assert client.get(PREFIX + "/reports/" + report["id"]).json() == report


def test_pending_scan_cannot_be_reviewed_reported_or_explained(workflow):
    task = queued(workflow, text=RISK_TEXT)
    responses = [
        workflow.client.post(PREFIX + "/reports", json={"scan_id": task["id"]}),
        workflow.client.post(PREFIX + "/scans/" + task["id"] + "/review", json={"decision": "false_positive"}),
        workflow.client.post(PREFIX + "/assistant", json={"question": "Why?", "scan_id": task["id"]}),
    ]
    for response in responses:
        assert response.status_code == 409, response.text
        assert isinstance(response.json()["detail"], str)
    with workflow.Session() as db:
        assert db.scalar(select(func.count()).select_from(Report)) == 0
        assert db.get(ScanTask, task["id"]).review is None


@pytest.mark.parametrize("llm_status,expected_status", [("disabled", "rules_only"), ("unavailable", "llm_unavailable")])
def test_assistant_falls_back_to_stored_evidence_without_changing_score(workflow, llm_status, expected_status):
    workflow.collect.side_effect = None
    workflow.collect.return_value = public_content()
    scan = completed(workflow, url=PUBLIC_URL, locale="en")
    workflow.explain.return_value = {"status": llm_status, "provider": "none", "explanation": "", "citations": []}
    response = workflow.client.post(PREFIX + "/assistant", json={"question": "Explain this score", "scan_id": scan["id"], "locale": "en"})
    assert response.status_code == 200, response.text
    result = response.json()
    assert result["status"] == expected_status
    assert result["provider"] == "evidence_assistant"
    assert result["citations"] == [PUBLIC_URL]
    assert scan["analysis"]["summary"] in result["answer"]
    for item in scan["analysis"]["evidence"]:
        assert item["quote"] in result["answer"]
    assert workflow.client.get(PREFIX + "/scans/" + scan["id"]).json() == scan


def test_assistant_optional_llm_explanation_does_not_replace_rule_score(workflow):
    scan = completed(workflow, text=RISK_TEXT)
    workflow.explain.return_value = {
        "status": "completed", "provider": "fixture_provider",
        "explanation": "Explanation of stored evidence only.", "citations": [], "score": 0,
    }
    response = workflow.client.post(PREFIX + "/assistant", json={"question": "Explain", "scan_id": scan["id"]})
    assert response.status_code == 200
    assert response.json() == {"answer": "Explanation of stored evidence only.", "provider": "fixture_provider", "citations": [], "status": "completed"}
    assert workflow.client.get(PREFIX + "/scans/" + scan["id"]).json() == scan


@pytest.mark.parametrize("locale", ["ru", "kk", "en"])
def test_general_assistant_never_claims_a_source_without_a_scan(workflow, locale):
    response = workflow.client.post(PREFIX + "/assistant", json={"question": "How do checks work?", "locale": locale})
    assert response.status_code == 200
    answer = response.json()
    assert answer["answer"]
    assert answer["citations"] == []
    assert answer["status"] == "rules_only"
    assert answer["provider"] == "evidence_assistant"
    workflow.explain.assert_not_awaited()


def test_configuration_start_stop_restart_and_logs_reflect_real_tasks(workflow):
    client = workflow.client
    response = client.patch(PREFIX + "/agents/youtube", json={"seeds": [PUBLIC_URL, PUBLIC_URL], "interval_seconds": 120})
    assert response.status_code == 200, response.text
    assert response.json()["seeds"] == [PUBLIC_URL]
    assert response.json()["interval_seconds"] == 120
    assert response.json()["enabled"] is False
    workflow.dispatch.assert_not_called()
    started = client.post(PREFIX + "/agents/youtube/start").json()
    assert started["enabled"] and started["status"] == "queued"
    assert started["last_run_at"] and started["next_run_at"]
    first = client.get(PREFIX + "/scans").json()["items"][0]
    assert first["agent_id"] == "youtube" and first["url"] == PUBLIC_URL
    runner.schedule()
    assert client.post(PREFIX + "/agents/youtube/start").status_code == 200
    assert workflow.dispatch.call_count == 1
    restarted = client.post(PREFIX + "/agents/youtube/restart")
    assert restarted.status_code == 200
    assert workflow.dispatch.call_count == 2
    assert client.get(PREFIX + "/scans/" + first["id"]).json()["status"] == "cancelled"
    tasks = client.get(PREFIX + "/scans").json()["items"]
    second = next(task for task in tasks if task["id"] != first["id"])
    stopped = client.post(PREFIX + "/agents/youtube/stop").json()
    assert stopped["enabled"] is False and stopped["status"] == "stopped"
    assert stopped["next_run_at"] is None
    runner.execute(first["id"])
    runner.execute(second["id"])
    for task in (first, second):
        cancelled = client.get(PREFIX + "/scans/" + task["id"]).json()
        assert cancelled["status"] == "cancelled" and cancelled["completed_at"]
        assert_unscored(cancelled)
    logs = client.get(PREFIX + "/agents/youtube/logs").json()["items"]
    assert {"configuration", "start", "restart", "stop"} <= {row["stage"] for row in logs}
    assert all({"id", "at", "stage", "message", "task_id"} <= row.keys() for row in logs)
    workflow.collect.assert_not_awaited()


def test_start_all_without_seeds_has_no_synthetic_activity(workflow):
    started = workflow.client.post(PREFIX + "/agents/start")
    assert started.status_code == 200
    assert len(started.json()["items"]) == 5
    assert all(row["enabled"] and row["stage"] == "waiting_for_seed" for row in started.json()["items"])
    assert workflow.client.get(PREFIX + "/overview").json()["totals"]["active_agents"] == 5
    assert workflow.client.get(PREFIX + "/scans").json()["total"] == 0
    stopped = workflow.client.post(PREFIX + "/agents/stop")
    assert stopped.status_code == 200
    assert all(not row["enabled"] and row["status"] == "stopped" for row in stopped.json()["items"])
    assert workflow.client.get(PREFIX + "/overview").json()["totals"]["active_agents"] == 0
    workflow.dispatch.assert_not_called()


def test_completed_agent_updates_checked_flagged_and_task_logs_once(workflow):
    workflow.collect.side_effect = None
    workflow.collect.return_value = public_content()
    task = configured_agent(workflow)
    runner.execute(task["id"])
    runner.execute(task["id"])
    agent = next(a for a in workflow.client.get(PREFIX + "/agents").json()["items"] if a["id"] == "youtube")
    assert agent["checked"] == agent["flagged"] == 1
    assert agent["enabled"] is True
    assert agent["status"] == "idle"
    logs = workflow.client.get(PREFIX + "/agents/youtube/logs").json()["items"]
    assert sum(row["stage"] == "completed" and row["task_id"] == task["id"] for row in logs) == 1
    workflow.collect.assert_awaited_once()


@pytest.mark.parametrize("phase", ["collecting", "explaining"])
@pytest.mark.parametrize("late_error", [False, True], ids=["late-result", "late-exception"])
def test_stop_during_execution_discards_late_result_and_does_not_increment_counters(workflow, phase, late_error):
    client = workflow.client
    task = configured_agent(workflow)

    def stop_while_running():
        assert client.get(PREFIX + "/scans/" + task["id"]).json()["status"] == "running"
        response = client.post(PREFIX + "/agents/youtube/stop")
        assert response.status_code == 200, response.text

    async def collect(url, *, platform, on_event):
        if phase == "collecting":
            stop_while_running()
            if late_error:
                raise RuntimeError("Collector finished with an error after Stop")
        return public_content()

    async def explain(*args, **kwargs):
        stop_while_running()
        if late_error:
            raise RuntimeError("Explanation finished with an error after Stop")
        return {"status": "disabled", "provider": "none", "explanation": "", "citations": []}

    workflow.collect.side_effect = collect
    if phase == "explaining":
        workflow.explain.side_effect = explain
    runner.execute(task["id"])
    scan = client.get(PREFIX + "/scans/" + task["id"]).json()
    assert scan["status"] == "cancelled" and scan["completed_at"]
    assert_unscored(scan)
    with workflow.Session() as db:
        for model in (RiskAssessment, Evidence, ScannedContent):
            assert db.scalar(select(func.count()).select_from(model)) == 0
    agent = next(a for a in client.get(PREFIX + "/agents").json()["items"] if a["id"] == "youtube")
    assert agent["status"] == "stopped" and agent["enabled"] is False
    assert agent["checked"] == agent["flagged"] == 0
    assert client.get(PREFIX + "/overview").json()["totals"]["scanned"] == 0
    assert client.post(PREFIX + "/reports", json={"scan_id": task["id"]}).status_code == 409
    assert client.post(PREFIX + "/scans/" + task["id"] + "/review", json={"decision": "confirmed_signals"}).status_code == 409
    runner.execute(task["id"])
    workflow.collect.assert_awaited_once()


@pytest.mark.parametrize("url", [
    "http://127.0.0.1/", "http://169.254.169.254/latest/meta-data/",
    "http://[::1]/", "http://localhost/", "file:///etc/passwd",
    "https://user:password@example.com/", "https://example.com:4310/",
])
def test_unsafe_scan_rejected_before_dns_persistence_and_dispatch(workflow, url):
    response = workflow.client.post(PREFIX + "/scans", json={"url": url})
    assert response.status_code == 422, response.text
    assert isinstance(response.json()["detail"], str)
    assert workflow.client.get(PREFIX + "/scans").json()["total"] == 0
    workflow.dns.assert_not_awaited()
    workflow.dispatch.assert_not_called()
    workflow.collect.assert_not_awaited()


@pytest.mark.parametrize("addresses", [["127.0.0.1"], [PUBLIC_IP, "10.0.0.1"], [PUBLIC_IP, "::ffff:169.254.169.254"]])
def test_private_or_mixed_dns_is_rejected_by_post_before_queue(workflow, addresses):
    workflow.dns.return_value = addresses
    response = workflow.client.post(PREFIX + "/scans", json={"url": "https://example.com/public"})
    assert response.status_code == 422, response.text
    assert isinstance(response.json()["detail"], str)
    workflow.dns.assert_awaited_once()
    workflow.dispatch.assert_not_called()
    with workflow.Session() as db:
        assert db.scalar(select(func.count()).select_from(ScanTask)) == 0


@pytest.mark.parametrize("endpoint", ["scan", "seed"])
@pytest.mark.parametrize("dns_error", [OSError("DNS offline"), TimeoutError("DNS deadline")])
def test_dns_unavailability_is_a_structured_early_rejection(workflow, endpoint, dns_error):
    workflow.dns.side_effect = dns_error
    if endpoint == "scan":
        response = workflow.client.post(PREFIX + "/scans", json={"url": PUBLIC_URL})
    else:
        response = workflow.client.patch(PREFIX + "/agents/youtube", json={"seeds": [PUBLIC_URL], "interval_seconds": 60})
    assert response.status_code == 422, response.text
    assert isinstance(response.json()["detail"], str)
    workflow.dispatch.assert_not_called()
    with workflow.Session() as db:
        assert db.scalar(select(func.count()).select_from(ScanTask)) == 0
        assert db.get(Agent, "youtube").seeds == []


@pytest.mark.parametrize("config", [
    {"seeds": ["https://www.instagram.com/public/"], "interval_seconds": 60},
    {"seeds": ["https://youtube.com.attacker.example/public"], "interval_seconds": 60},
    {"seeds": [PUBLIC_URL], "interval_seconds": 59},
    {"seeds": [PUBLIC_URL], "interval_seconds": 86401},
])
def test_invalid_agent_configuration_is_atomic(workflow, config):
    before = workflow.client.get(PREFIX + "/agents").json()
    response = workflow.client.patch(PREFIX + "/agents/youtube", json=config)
    assert response.status_code == 422, response.text
    assert workflow.client.get(PREFIX + "/agents").json() == before
    workflow.dispatch.assert_not_called()


@pytest.mark.parametrize("agent_id,url", [
    ("instagram", "https://www.instagram.com/accounts/login/"),
    ("instagram", "https://www.instagram.com/"),
    ("instagram", "https://l.instagram.com/?u=https://example.com"),
    ("youtube", "https://www.youtube.com/results?search_query=slots"),
    ("tiktok", "https://www.tiktok.com/login"),
    ("telegram", "https://t.me/+privateinvite"),
])
def test_service_pages_rejected_before_seed_dns_and_persistence(workflow, agent_id, url):
    before = workflow.client.get(PREFIX + "/agents").json()
    response = workflow.client.patch(PREFIX + "/agents/" + agent_id, json={"seeds": [url]})
    assert response.status_code == 422
    assert workflow.client.get(PREFIX + "/agents").json() == before
    workflow.dns.assert_not_awaited()


def test_telegram_monitor_runs_public_source_without_creating_demo(workflow):
    url = "https://t.me/s/public_channel"
    response = workflow.client.patch(PREFIX + "/agents/telegram", json={"seeds": [url], "interval_seconds": 900})
    assert response.status_code == 200
    workflow.collect.side_effect = None
    workflow.collect.return_value = public_content(url=url, metadata={"collector": "public_http", "content_scope": "public_telegram_channel_posts"})
    assert workflow.client.post(PREFIX + "/agents/telegram/start").status_code == 200
    task = workflow.client.get(PREFIX + "/scans").json()["items"][0]
    assert task["agent_id"] == task["platform"] == "telegram"
    assert task["url"] == url and task["mode"] == "live"
    runner.execute(task["id"])
    result = workflow.client.get(PREFIX + "/scans/" + task["id"]).json()
    assert result["status"] == "completed" and result["analysis"]["evidence"]
    report = workflow.client.post(PREFIX + "/reports", json={"scan_id": task["id"]})
    assert "Video frames and audio were not analyzed" in report.json()["markdown"]
    assert workflow.client.get(PREFIX + "/scans?mode=demo").json()["total"] == 0


def test_unsafe_later_seed_cannot_partially_replace_configuration(workflow):
    valid = workflow.client.patch(PREFIX + "/agents/youtube", json={"seeds": [PUBLIC_URL], "interval_seconds": 120})
    assert valid.status_code == 200
    before = workflow.client.get(PREFIX + "/agents").json()
    workflow.dns.side_effect = [[PUBLIC_IP], ["127.0.0.1"]]
    response = workflow.client.patch(PREFIX + "/agents/youtube", json={
        "seeds": ["https://www.youtube.com/@one", "https://www.youtube.com/@two"], "interval_seconds": 60,
    })
    assert response.status_code == 422
    assert workflow.client.get(PREFIX + "/agents").json() == before
    workflow.dispatch.assert_not_called()


@pytest.mark.parametrize("body", [
    {}, {"text": "   "}, {"text": "x", "url": PUBLIC_URL}, {"text": "x" * 20001},
    {"url": "https://example.com/" + "x" * 2048}, {"text": "x", "locale": "de"},
    {"text": "x", "mode": "unknown"}, {"url": PUBLIC_URL, "mode": "demo"},
])
def test_invalid_scan_input_never_creates_work(workflow, body):
    response = workflow.client.post(PREFIX + "/scans", json=body)
    assert response.status_code == 422, response.text
    assert workflow.client.get(PREFIX + "/scans").json()["total"] == 0
    workflow.dispatch.assert_not_called()
    workflow.dns.assert_not_awaited()


def test_validation_errors_follow_string_detail_contract(workflow):
    response = workflow.client.post(PREFIX + "/scans", json={})
    assert response.status_code == 422
    assert isinstance(response.json()["detail"], str), response.json()


def test_queue_capacity_rejects_work_without_dispatch(workflow, monkeypatch):
    monkeypatch.setattr(api.settings, "max_tasks", 1)
    task = queued(workflow, text=BENIGN_TEXT)
    response = workflow.client.post(PREFIX + "/scans", json={"text": RISK_TEXT})
    assert response.status_code == 429, response.text
    assert isinstance(response.json()["detail"], str)
    assert workflow.dispatch.call_count == 1
    assert workflow.client.get(PREFIX + "/scans").json()["total"] == 1
    runner.execute(task["id"])
    queued(workflow, text=RISK_TEXT)
    assert workflow.dispatch.call_count == 2


def test_redacted_manual_data_never_reappears_in_review_or_report(workflow):
    payment = "4111 1111 1111 1111"
    phone = "+7 (701) 123-45-67"
    scan = completed(workflow, text=RISK_TEXT + f" Pay {payment}; contact {phone}.")
    response = workflow.client.post(PREFIX + "/scans/" + scan["id"] + "/review", json={"decision": "needs_context", "note": f"Contact {phone}; payment {payment}."})
    assert response.status_code == 200
    report = workflow.client.post(PREFIX + "/reports", json={"scan_id": scan["id"]})
    assert report.status_code in (200, 201)
    serialized = str(scan) + response.text + report.text
    assert payment not in serialized and phone not in serialized
    assert "[payment details redacted]" in scan["text"]
    assert "[phone redacted]" in response.json()["review"]["note"]


@pytest.mark.parametrize("method,path,body", [
    ("get", "/scans/missing", None), ("get", "/reports/missing", None),
    ("get", "/agents/missing/logs", None), ("post", "/agents/missing/start", None),
    ("patch", "/agents/missing", {"seeds": [], "interval_seconds": 60}),
    ("post", "/scans/missing/review", {"decision": "needs_context"}),
    ("post", "/reports", {"scan_id": "missing"}),
    ("post", "/assistant", {"scan_id": "missing", "question": "Why?"}),
])
def test_unknown_resources_have_structured_404s(workflow, method, path, body):
    response = workflow.client.request(method, PREFIX + path, **({"json": body} if body is not None else {}))
    assert response.status_code == 404, response.text
    assert isinstance(response.json()["detail"], str)


def test_websocket_snapshot_respects_explicit_demo_mode(workflow):
    completed(workflow, text=BENIGN_TEXT, mode="live")
    demo = completed(workflow, text=RISK_TEXT, mode="demo")
    expected = workflow.client.get(PREFIX + "/overview", params={"mode": "demo"}).json()
    with workflow.client.websocket_connect("/events?mode=demo", headers={"Origin": "http://testserver"}) as websocket:
        message = websocket.receive_json()
        assert message == {"type": "snapshot", "data": expected}
        assert [row["id"] for row in message["data"]["recent"]] == [demo["id"]]


def test_stop_between_final_read_and_save_cannot_publish_a_cancelled_result(workflow):
    """Deterministic interleaving: Stop commits after the worker reads its row."""
    workflow.collect.side_effect = None
    workflow.collect.return_value = public_content()
    task = configured_agent(workflow)
    stopped = []

    def stop_after_read(session, row):
        if (isinstance(row, ScanTask) and row.id == task["id"]
                and row.stage == "saving" and not stopped):
            stopped.append(True)
            response = workflow.client.post(PREFIX + "/agents/youtube/stop")
            assert response.status_code == 200, response.text

    event.listen(workflow.Session, "loaded_as_persistent", stop_after_read)
    try:
        runner.execute(task["id"])
    finally:
        event.remove(workflow.Session, "loaded_as_persistent", stop_after_read)
    assert stopped == [True], "The final-save race was not exercised"
    result = workflow.client.get(PREFIX + "/scans/" + task["id"]).json()
    assert result["status"] == "cancelled", result
    assert_unscored(result)
    agent = next(a for a in workflow.client.get(PREFIX + "/agents").json()["items"] if a["id"] == "youtube")
    assert agent["checked"] == agent["flagged"] == 0


def test_cleanup_does_not_expire_a_fresh_worker_claim_based_on_queue_age(workflow):
    task = queued(workflow, url=PUBLIC_URL)
    with workflow.Session.begin() as db:
        db.get(ScanTask, task["id"]).created_at = utcnow() - timedelta(minutes=11)
    observations = []

    async def collect(url, *, platform, on_event):
        # This worker has just started; only the time spent waiting was long.
        runner.cleanup()
        observations.append(workflow.client.get(PREFIX + "/scans/" + task["id"]).json())
        return public_content()

    workflow.collect.side_effect = collect
    runner.execute(task["id"])
    assert len(observations) == 1
    assert observations[0]["status"] == "running", observations[0]
    result = workflow.client.get(PREFIX + "/scans/" + task["id"]).json()
    assert result["status"] == "completed" and result["error"] is None, result


def test_post_commit_audit_failure_cannot_turn_saved_assessment_into_failed_scan(workflow, monkeypatch):
    task = queued(workflow, text=RISK_TEXT)
    real_audit = runner.audit

    def unavailable_completion_log(stage, *args, **kwargs):
        if stage == "completed":
            raise OSError("Transient database outage after the result was committed")
        return real_audit(stage, *args, **kwargs)

    monkeypatch.setattr(runner, "audit", unavailable_completion_log)
    runner.execute(task["id"])
    result = workflow.client.get(PREFIX + "/scans/" + task["id"]).json()
    with workflow.Session() as db:
        assert db.scalar(select(func.count()).select_from(RiskAssessment)) == 1
    assert result["status"] == "completed", result
    assert result["score"] >= 30 and result["error"] is None


def test_imported_report_preserves_historical_capture_date_and_source_scope(workflow, monkeypatch, tmp_path):
    from safenet import import_legacy

    monkeypatch.setattr(import_legacy, "Session", workflow.Session)
    captured = "2024-01-02T03:04:05Z"
    record = {
        "demo": False, "source": "social_discovery", "url": PUBLIC_URL,
        "originalText": RISK_TEXT, "capturedAt": captured, "links": [],
        "provenance": {
            "method": "search_index", "scope": "public_search_index_excerpt",
            "publicVisibilityVerified": False,
        },
    }
    path = tmp_path / "synthetic-legacy-record.json"
    path.write_text(json.dumps([record]), encoding="utf-8")
    assert import_legacy.import_records(path)["imported"] == 1
    assert import_legacy.import_records(path)["skipped"] == 1
    scan = workflow.client.get(PREFIX + "/scans").json()["items"][0]
    assert scan["metadata"]["captured_at"] == captured
    assert scan["metadata"]["independently_fetched_this_run"] is False
    response = workflow.client.post(PREFIX + "/reports", json={"scan_id": scan["id"]})
    assert response.status_code in (200, 201), response.text
    markdown = response.json()["markdown"]
    assert captured in markdown, markdown
    assert "search_index" in markdown or "search index" in markdown.lower(), markdown
    assert "Collected: " + scan["completed_at"] not in markdown
    assert "Source: " + PUBLIC_URL in markdown
    assert f"Risk: {scan['score']}/100 ({scan['level']})" in markdown
    assert "Category: " + scan["category"] in markdown
    assert scan["analysis"]["summary"] in markdown


def test_chunked_request_cannot_bypass_the_api_body_size_limit(workflow):
    response = workflow.client.post(
        PREFIX + "/scans",
        content=iter([b'{"text":"A library notice."}', b" " * 100_001]),
        headers={"Content-Type": "application/json"},
    )
    assert "content-length" not in response.request.headers
    assert response.status_code == 413, response.text
    assert isinstance(response.json()["detail"], str)
    workflow.dispatch.assert_not_called()


def test_stop_between_exception_read_and_failure_write_preserves_cancellation(workflow):
    task = configured_agent(workflow)
    collector_failed = []
    stopped = []

    async def failing_collector(*args, **kwargs):
        collector_failed.append(True)
        raise RuntimeError("Collector failure immediately before concurrent Stop")

    def stop_after_failure_read(session, row):
        if (isinstance(row, ScanTask) and row.id == task["id"]
                and row.status == "running" and collector_failed and not stopped):
            stopped.append(True)
            response = workflow.client.post(PREFIX + "/agents/youtube/stop")
            assert response.status_code == 200, response.text

    workflow.collect.side_effect = failing_collector
    event.listen(workflow.Session, "loaded_as_persistent", stop_after_failure_read)
    try:
        runner.execute(task["id"])
    finally:
        event.remove(workflow.Session, "loaded_as_persistent", stop_after_failure_read)
    assert stopped == [True], "The failure-write race was not exercised"
    result = workflow.client.get(PREFIX + "/scans/" + task["id"]).json()
    assert result["status"] == "cancelled", result
    assert_unscored(result)

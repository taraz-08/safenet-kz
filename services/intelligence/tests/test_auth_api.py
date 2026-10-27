"""Standalone authentication and CSRF tests against real FastAPI routes."""

from collections import defaultdict, deque
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, event, func, select
from sqlalchemy.engine import URL
from sqlalchemy.orm import sessionmaker
from starlette.websockets import WebSocketDisconnect

from safenet import app as api
from safenet import auth, collectors, runner, safe_fetch, store
from safenet.models import Base, ScanTask


PREFIX = "/api/v1"
ADMIN_CODE = "known-auth-fixture-admin-code"
ORIGIN = "http://localhost:3000"
MUTATIONS = [
    ("POST", "/agents/start", None),
    ("POST", "/agents/stop", None),
    ("POST", "/agents/youtube/start", None),
    ("POST", "/agents/youtube/stop", None),
    ("POST", "/agents/youtube/restart", None),
    ("PATCH", "/agents/youtube", {"seeds": [], "interval_seconds": 60}),
    ("POST", "/scans", {"text": "A public library notice."}),
    ("POST", "/scans/missing/review", {"decision": "needs_context"}),
    ("POST", "/reports", {"scan_id": "missing"}),
    ("POST", "/assistant", {"question": "Explain the method"}),
]


@pytest.fixture
def auth_api(tmp_path, monkeypatch):
    # Deliberately independent of test_workflow and any other agent's fixtures.
    engine = create_engine(
        URL.create("sqlite", database=str(tmp_path / "auth.sqlite")),
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
        "local_admin": False, "admin_code": ADMIN_CODE, "session_hours": 1,
        "allowed_origins": ORIGIN, "secure_cookie": False, "max_tasks": 100,
    }.items():
        monkeypatch.setattr(api.settings, key, value)
    for key in ("SAFENET_LLM_API_KEY", "SAFENET_LLM_MODEL", "SAFENET_YOUTUBE_API_KEY"):
        monkeypatch.delenv(key, raising=False)
    monkeypatch.setattr(auth, "_sessions", {})
    monkeypatch.setattr(auth, "_attempts", defaultdict(deque))
    monkeypatch.setattr(auth, "_global_attempts", deque())
    clock = SimpleNamespace(now=10_000.0)
    # Replacing the auth module's reference avoids changing asyncio's real clock.
    monkeypatch.setattr(auth, "time", SimpleNamespace(monotonic=lambda: clock.now))
    dispatch = Mock(name="dispatch")
    monkeypatch.setattr(runner, "dispatch", dispatch)
    monkeypatch.setattr(collectors, "collect", AsyncMock(side_effect=AssertionError("No collector I/O in auth tests")))
    monkeypatch.setattr(safe_fetch, "_resolve", AsyncMock(side_effect=AssertionError("No DNS in auth tests")))
    Base.metadata.create_all(engine)
    try:
        with TestClient(api.app, raise_server_exceptions=False) as client:
            yield SimpleNamespace(client=client, Session=sessions, dispatch=dispatch, clock=clock)
    finally:
        engine.dispose()


def sign_in(auth_api):
    response = auth_api.client.post(PREFIX + "/session", json={"code": ADMIN_CODE}, headers={"Origin": ORIGIN})
    assert response.status_code == 200, response.text
    assert response.json() == {"authenticated": True, "login_enabled": True}
    return response


def mutate(client, method, path, body, **kwargs):
    if body is not None:
        kwargs["json"] = body
    return client.request(method, PREFIX + path, **kwargs)


@pytest.mark.parametrize("path", [
    "/session", "/health", "/overview", "/agents", "/agents/youtube/logs",
    "/scans", "/reports", "/settings",
])
def test_read_endpoints_are_public_and_responses_prevent_caching(auth_api, path):
    response = auth_api.client.get(PREFIX + path)
    assert response.status_code == 200, response.text
    assert response.headers["cache-control"] == "no-store"
    assert response.headers["x-content-type-options"] == "nosniff"
    assert response.headers["x-frame-options"] == "DENY"
    assert ADMIN_CODE not in response.text
    assert auth_api.client.get(PREFIX + "/session").json() == {"authenticated": False, "login_enabled": True}


@pytest.mark.parametrize("method,path,body", MUTATIONS)
def test_every_mutation_requires_an_admin_session(auth_api, method, path, body):
    response = mutate(auth_api.client, method, path, body, headers={"Origin": ORIGIN})
    assert response.status_code == 401, response.text
    assert isinstance(response.json()["detail"], str)
    auth_api.dispatch.assert_not_called()
    assert all(not row["enabled"] for row in auth_api.client.get(PREFIX + "/agents").json()["items"])
    with auth_api.Session() as db:
        assert db.scalar(select(func.count()).select_from(ScanTask)) == 0


def test_login_cookie_authorizes_work_then_logout_revokes_captured_cookie(auth_api):
    response = sign_in(auth_api)
    cookie_header = response.headers["set-cookie"].lower()
    assert "httponly" in cookie_header
    assert "samesite=strict" in cookie_header
    assert "path=/" in cookie_header
    assert "max-age=3600" in cookie_header
    token = auth_api.client.cookies.get(auth.COOKIE)
    assert token and token != ADMIN_CODE
    assert token not in response.text and ADMIN_CODE not in response.text
    assert auth_api.client.get(PREFIX + "/session").json()["authenticated"] is True
    accepted = auth_api.client.post(PREFIX + "/scans", json={"text": "A library notice."}, headers={"Origin": ORIGIN})
    assert accepted.status_code == 202, accepted.text
    auth_api.dispatch.assert_called_once_with(accepted.json()["id"])
    logout = auth_api.client.delete(PREFIX + "/session", headers={"Origin": ORIGIN})
    assert logout.status_code == 200
    assert logout.json() == {"authenticated": False, "login_enabled": True}
    assert "max-age=0" in logout.headers["set-cookie"].lower()
    assert auth_api.client.get(PREFIX + "/session").json()["authenticated"] is False
    # Reinsert the exact stolen cookie: deleting it in the browser is insufficient.
    auth_api.client.cookies.set(auth.COOKIE, token)
    assert auth_api.client.get(PREFIX + "/session").json()["authenticated"] is False
    replay = auth_api.client.post(PREFIX + "/scans", json={"text": "Replay"}, headers={"Origin": ORIGIN})
    assert replay.status_code == 401
    assert auth_api.dispatch.call_count == 1


def test_logout_revokes_only_the_current_admin_session(auth_api):
    sign_in(auth_api)
    first_token = auth_api.client.cookies.get(auth.COOKIE)
    auth_api.client.cookies.clear()
    sign_in(auth_api)
    second_token = auth_api.client.cookies.get(auth.COOKIE)
    assert first_token != second_token
    assert auth_api.client.delete(PREFIX + "/session").status_code == 200
    auth_api.client.cookies.set(auth.COOKIE, first_token)
    assert auth_api.client.get(PREFIX + "/session").json()["authenticated"] is True
    assert auth_api.client.post(PREFIX + "/agents/start").status_code == 200


def test_expired_session_cannot_be_replayed(auth_api):
    sign_in(auth_api)
    auth_api.clock.now += 3601
    assert auth_api.client.get(PREFIX + "/session").json()["authenticated"] is False
    response = auth_api.client.post(PREFIX + "/agents/start", headers={"Origin": ORIGIN})
    assert response.status_code == 401
    assert all(not row["enabled"] for row in auth_api.client.get(PREFIX + "/agents").json()["items"])


def test_tampered_cookie_is_rejected_without_revoking_valid_session(auth_api):
    sign_in(auth_api)
    token = auth_api.client.cookies.get(auth.COOKIE)
    auth_api.client.cookies.clear()
    auth_api.client.cookies.set(auth.COOKIE, token + "tampered")
    assert auth_api.client.get(PREFIX + "/session").json()["authenticated"] is False
    assert auth_api.client.post(PREFIX + "/agents/start").status_code == 401
    auth_api.client.cookies.clear()
    auth_api.client.cookies.set(auth.COOKIE, token)
    assert auth_api.client.get(PREFIX + "/session").json()["authenticated"] is True


@pytest.mark.parametrize("headers", [
    {"Origin": "https://attacker.example"},
    {"Origin": "null"},
    {"Origin": "http://localhost:3000.attacker.example"},
    {"Origin": ORIGIN, "Sec-Fetch-Site": "cross-site"},
    {"Sec-Fetch-Site": "cross-site"},
])
def test_cross_site_login_cannot_create_session(auth_api, headers):
    response = auth_api.client.post(PREFIX + "/session", json={"code": ADMIN_CODE}, headers=headers)
    assert response.status_code == 403, response.text
    assert isinstance(response.json()["detail"], str)
    assert "set-cookie" not in response.headers
    assert auth_api.client.get(PREFIX + "/session").json()["authenticated"] is False


@pytest.mark.parametrize("method,path,body", MUTATIONS)
def test_authenticated_mutations_still_enforce_csrf_origin(auth_api, method, path, body):
    sign_in(auth_api)
    before = auth_api.client.get(PREFIX + "/agents").json()
    response = mutate(auth_api.client, method, path, body, headers={"Origin": "https://attacker.example"})
    assert response.status_code == 403, response.text
    assert isinstance(response.json()["detail"], str)
    assert auth_api.client.get(PREFIX + "/agents").json() == before
    assert auth_api.client.get(PREFIX + "/session").json()["authenticated"] is True
    auth_api.dispatch.assert_not_called()


def test_cross_site_logout_cannot_revoke_a_session(auth_api):
    sign_in(auth_api)
    for headers in ({"Origin": "https://attacker.example"}, {"Sec-Fetch-Site": "cross-site"}):
        response = auth_api.client.delete(PREFIX + "/session", headers=headers)
        assert response.status_code == 403
        assert "set-cookie" not in response.headers
        assert auth_api.client.get(PREFIX + "/session").json()["authenticated"] is True
    assert auth_api.client.delete(PREFIX + "/session", headers={"Origin": ORIGIN}).status_code == 200


def test_wrong_code_is_rate_limited_and_window_expires_without_sleep(auth_api):
    for _ in range(10):
        response = auth_api.client.post(PREFIX + "/session", json={"code": "wrong-code"})
        assert response.status_code == 401
        assert "set-cookie" not in response.headers
        assert ADMIN_CODE not in response.text
    response = auth_api.client.post(PREFIX + "/session", json={"code": ADMIN_CODE})
    assert response.status_code == 429
    assert isinstance(response.json()["detail"], str)
    assert auth_api.client.get(PREFIX + "/session").json()["authenticated"] is False
    auth_api.clock.now += 301
    sign_in(auth_api)


def test_proxy_header_cannot_evade_per_client_login_rate_limit(auth_api):
    for index in range(10):
        response = auth_api.client.post(PREFIX + "/session", json={"code": "wrong"}, headers={"X-Forwarded-For": f"203.0.113.{index + 1}"})
        assert response.status_code == 401
    response = auth_api.client.post(PREFIX + "/session", json={"code": ADMIN_CODE}, headers={"X-Forwarded-For": "198.51.100.99"})
    assert response.status_code == 429


def test_missing_admin_code_is_explicitly_unavailable(auth_api, monkeypatch):
    monkeypatch.setattr(api.settings, "admin_code", "")
    assert auth_api.client.get(PREFIX + "/session").json() == {"authenticated": False, "login_enabled": False}
    response = auth_api.client.post(PREFIX + "/session", json={"code": ADMIN_CODE})
    assert response.status_code == 503
    assert isinstance(response.json()["detail"], str)
    assert "set-cookie" not in response.headers
    assert auth_api.client.post(PREFIX + "/agents/start").status_code == 401


@pytest.mark.parametrize("local_admin", [False, True])
def test_local_admin_is_an_explicit_opt_in_and_still_has_csrf_checks(auth_api, monkeypatch, local_admin):
    monkeypatch.setattr(api.settings, "local_admin", local_admin)
    assert auth_api.client.get(PREFIX + "/session").json()["authenticated"] is local_admin
    response = auth_api.client.post(PREFIX + "/agents/start", headers={"Origin": ORIGIN})
    assert response.status_code == (200 if local_admin else 401)
    forbidden = auth_api.client.post(PREFIX + "/agents/stop", headers={"Origin": "https://attacker.example"})
    assert forbidden.status_code == 403


def test_local_admin_does_not_trust_remote_client_or_forwarded_loopback(auth_api, monkeypatch):
    monkeypatch.setattr(api.settings, "local_admin", True)
    with TestClient(api.app, client=("203.0.113.5", 4444)) as remote:
        headers = {"X-Forwarded-For": "127.0.0.1", "Origin": ORIGIN}
        assert remote.get(PREFIX + "/session", headers=headers).json()["authenticated"] is False
        response = remote.post(PREFIX + "/agents/start", headers=headers)
        assert response.status_code == 401


def test_secure_cookie_setting_applies_on_login_and_logout(auth_api, monkeypatch):
    monkeypatch.setattr(api.settings, "secure_cookie", True)
    with TestClient(api.app, base_url="https://testserver") as secure:
        response = secure.post(PREFIX + "/session", json={"code": ADMIN_CODE}, headers={"Origin": ORIGIN})
        assert response.status_code == 200
        assert "secure" in response.headers["set-cookie"].lower()
        assert secure.get(PREFIX + "/session").json()["authenticated"] is True
        response = secure.delete(PREFIX + "/session", headers={"Origin": ORIGIN})
        assert response.status_code == 200
        assert "secure" in response.headers["set-cookie"].lower()
        assert "max-age=0" in response.headers["set-cookie"].lower()


@pytest.mark.parametrize("body", [{}, {"code": ""}, {"code": "x" * 257}])
def test_invalid_login_payload_has_structured_error_and_no_session(auth_api, body):
    response = auth_api.client.post(PREFIX + "/session", json=body)
    assert response.status_code == 422
    assert isinstance(response.json()["detail"], str)
    assert "set-cookie" not in response.headers
    assert auth_api.client.get(PREFIX + "/session").json()["authenticated"] is False


@pytest.mark.parametrize("path,headers", [
    ("/events?mode=live", {"Origin": "https://attacker.example"}),
    ("/events?mode=live", {}),
    ("/events?mode=unknown", {"Origin": ORIGIN}),
])
def test_websocket_rejects_untrusted_origin_or_invalid_mode(auth_api, path, headers):
    with pytest.raises(WebSocketDisconnect) as rejection:
        with auth_api.client.websocket_connect(path, headers=headers):
            pytest.fail("Websocket should be rejected before acceptance")
    assert rejection.value.code == 1008

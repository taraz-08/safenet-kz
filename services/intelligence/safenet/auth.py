import hashlib
import hmac
import secrets
import threading
import time
from collections import defaultdict, deque
from fastapi import HTTPException, Request
from .settings import settings

COOKIE = "safenet_ai_session"
_sessions = {}
_attempts = defaultdict(deque)
_global_attempts = deque()
_lock = threading.RLock()


def check_origin(request: Request):
    origin = request.headers.get("origin")
    if (origin and origin.rstrip("/") not in settings.origins) or request.headers.get("sec-fetch-site") == "cross-site":
        raise HTTPException(403, "Origin is not allowed")


def authenticated(request: Request):
    # Development shortcut is opt-in and the launch script binds to loopback.
    if settings.local_admin and request.client and request.client.host in ("127.0.0.1", "::1", "testclient"):
        return True
    cookie = request.cookies.get(COOKIE, "")
    with _lock:
        return bool(cookie and _sessions.get(hashlib.sha256(cookie.encode()).hexdigest(), 0) > time.monotonic())


def require_admin(request: Request):
    check_origin(request)
    if not authenticated(request):
        raise HTTPException(401, "Administrator sign-in is required")


def login(request: Request, code: str):
    check_origin(request)
    now = time.monotonic()
    address = request.client.host if request.client else "unknown"
    with _lock:
        for entries in [_global_attempts, _attempts[address]]:
            while entries and entries[0] < now - 300:
                entries.popleft()
        if len(_attempts[address]) >= 10 or len(_global_attempts) >= 100:
            raise HTTPException(429, "Too many attempts. Try again in five minutes.")
        _attempts[address].append(now)
        _global_attempts.append(now)
        if len(_attempts) > 2048:
            _attempts.clear()
        if not settings.admin_code:
            raise HTTPException(503, "Admin code is not configured")
        if not hmac.compare_digest(hashlib.sha256(code.encode()).digest(), hashlib.sha256(settings.admin_code.encode()).digest()):
            raise HTTPException(401, "Incorrect admin code")
        for key, expiry in list(_sessions.items()):
            if expiry <= now:
                _sessions.pop(key, None)
        if len(_sessions) >= 128:
            raise HTTPException(429, "Active session limit reached")
        token = secrets.token_urlsafe(32)
        _sessions[hashlib.sha256(token.encode()).hexdigest()] = now + settings.session_hours * 3600
        return token


def logout(request: Request):
    check_origin(request)
    with _lock:
        _sessions.pop(hashlib.sha256(request.cookies.get(COOKIE, "").encode()).hexdigest(), None)

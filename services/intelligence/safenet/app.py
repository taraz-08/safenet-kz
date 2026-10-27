import asyncio
import json
import logging
import os
from contextlib import asynccontextmanager
from datetime import timedelta
from typing import Literal
from fastapi import FastAPI, HTTPException, Request, Response, WebSocket, WebSocketDisconnect, Depends, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field, model_validator
from sqlalchemy import select, func, update, text as sql_text
from .settings import settings
from .models import Agent, ScanTask, Report, AuditLog, RiskAssessment, utcnow
from .store import Session, initialize, agent_json, scan_json, overview, audit, iso
from .auth import authenticated, require_admin, login, logout, COOKIE
from . import runner
from .uploads import router as media_router, UploadLimitMiddleware
from .networks import router as networks_router


class StructuredFormatter(logging.Formatter):
    def format(self, record):
        return json.dumps({"time": utcnow().isoformat(), "level": record.levelname, "logger": record.name, "event": record.getMessage(), "task_id": getattr(record, "task_id", None), "error_type": record.exc_info[0].__name__ if record.exc_info else None}, ensure_ascii=False)


handler = logging.StreamHandler()
handler.setFormatter(StructuredFormatter())
logging.getLogger("safenet").addHandler(handler)
logging.getLogger("safenet").setLevel(logging.INFO)
logging.getLogger("safenet").propagate = False


@asynccontextmanager
async def lifespan(_app):
    initialize()
    runner.start_scheduler()
    yield
    runner.stop_scheduler()


app = FastAPI(title="SafeNet AI", version="0.1.0", lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=settings.origins, allow_credentials=True, allow_methods=["GET", "POST", "PATCH", "DELETE"], allow_headers=["Content-Type"])
app.add_middleware(UploadLimitMiddleware)
PREFIX = "/api/v1"
Mode = Literal["live", "demo"]
Locale = Literal["ru", "kk", "en"]


@app.exception_handler(RequestValidationError)
async def validation_error(_request, error):
    # Do not reflect submitted codes or potentially sensitive input values.
    return JSONResponse(status_code=422, content={"detail": "; ".join(item["msg"] for item in error.errors())[:1200]})


@app.middleware("http")
async def headers(request, call_next):
    media_upload = request.method == "POST" and request.url.path == PREFIX + "/media/scans"
    if not media_upload and request.headers.get("content-length", "").isdigit() and int(request.headers["content-length"]) > 100_000:
        return Response('{"detail":"Request body is too large"}', status_code=413, media_type="application/json")
    if not media_upload and request.method in {"POST", "PATCH", "PUT"}:
        body = bytearray()
        async for chunk in request.stream():
            if len(body) + len(chunk) > 100_000:
                return JSONResponse(status_code=413, content={"detail": "Request body is too large"})
            body.extend(chunk)
        # Starlette's cached request passes this bounded buffer to the route.
        request._body = bytes(body)
    response = await call_next(request)
    response.headers["Cache-Control"] = "no-store"
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["Referrer-Policy"] = "same-origin"
    response.headers["X-Frame-Options"] = "DENY"
    return response


class LoginBody(BaseModel):
    code: str = Field(min_length=1, max_length=256)


@app.get(PREFIX + "/session")
def session_status(request: Request):
    return {"authenticated": authenticated(request), "login_enabled": bool(settings.admin_code)}


@app.post(PREFIX + "/session")
def sign_in(body: LoginBody, request: Request, response: Response):
    token = login(request, body.code)
    response.set_cookie(COOKIE, token, max_age=settings.session_hours * 3600, httponly=True, secure=settings.secure_cookie, samesite="strict", path="/")
    audit("admin_login", "Administrator signed in")
    return {"authenticated": True, "login_enabled": True}


@app.delete(PREFIX + "/session")
def sign_out(request: Request, response: Response):
    logout(request)
    response.delete_cookie(COOKIE, path="/", secure=settings.secure_cookie, httponly=True, samesite="strict")
    return {"authenticated": False, "login_enabled": bool(settings.admin_code)}


def capabilities():
    from .media import media_capabilities
    llm = bool(os.getenv("SAFENET_LLM_API_KEY") and os.getenv("SAFENET_LLM_MODEL"))
    return {"llm": "configured" if llm else "disabled", "browser": "playwright_public_only", "browser_use": "not_enabled", "official_youtube_api": bool(os.getenv("SAFENET_YOUTUBE_API_KEY")), "live_stream": False, "screenshots": False, **media_capabilities(), "languages": ["ru", "kk", "en"], "automatic_legal_verdicts": False}


@app.get(PREFIX + "/health")
def health(response: Response):
    database = "postgresql" if settings.database_url.startswith("postgres") else "sqlite"
    try:
        with Session() as db:
            db.execute(sql_text("SELECT 1"))
    except Exception:
        response.status_code = 503
        return {"status": "unhealthy", "database": "unavailable", "queue": settings.queue, **capabilities(), "version": app.version}
    queue = "local_thread_pool"
    if settings.queue == "celery":
        try:
            import redis
            redis.Redis.from_url(settings.redis_url, socket_connect_timeout=2, socket_timeout=2).ping()
            queue = "celery_redis_broker_ready"
        except Exception:
            queue = "unavailable"
            response.status_code = 503
    return {"status": "ok" if (response.status_code or 200) < 400 else "degraded", "database": database, "queue": queue, **capabilities(), "version": app.version}


@app.get(PREFIX + "/overview")
def get_overview(mode: Mode = "live"):
    return overview(mode)


@app.get(PREFIX + "/agents")
def agents():
    with Session() as db:
        return {"items": [agent_json(row) for row in db.scalars(select(Agent).order_by(Agent.id))]}


def change_agents(action, agent_id=None):
    with Session.begin() as db:
        rows = list(db.scalars(select(Agent).where(Agent.id == agent_id))) if agent_id else list(db.scalars(select(Agent)))
        if not rows:
            raise HTTPException(404, "Agent not found")
        for agent in rows:
            # Worker completion also locks task before agent. Keep this order
            # to avoid a PostgreSQL deadlock during Stop/Restart.
            if action in {"stop", "restart"}:
                with db.no_autoflush:
                    db.execute(update(ScanTask).where(ScanTask.agent_id == agent.id, ScanTask.status.in_(["queued", "running"])).values(cancel_requested=True, status="cancelled", stage="stopped", completed_at=utcnow()))
            enabled = action != "stop"
            agent.enabled = enabled
            agent.last_error = None
            agent.status = "idle" if enabled else "stopped"
            agent.stage = "waiting_for_seed" if enabled and not agent.seeds else "waiting_for_schedule" if enabled else "stopped"
            agent.next_run_at = utcnow() if enabled else None
            db.add(AuditLog(agent_id=agent.id, stage=action, message=f"Operator requested {action}"))
        result = [agent_json(row) for row in rows]
    if action != "stop":
        runner.schedule()
    return result


@app.post(PREFIX + "/agents/start", dependencies=[Depends(require_admin)])
def start_all():
    change_agents("start")
    return agents()


@app.post(PREFIX + "/agents/stop", dependencies=[Depends(require_admin)])
def stop_all():
    return {"items": change_agents("stop")}


@app.post(PREFIX + "/agents/{agent_id}/{action}", dependencies=[Depends(require_admin)])
def agent_action(agent_id: str, action: Literal["start", "stop", "restart"]):
    change_agents(action, agent_id)
    with Session() as db:
        return agent_json(db.get(Agent, agent_id))


class AgentConfig(BaseModel):
    seeds: list[str] = Field(max_length=100)
    interval_seconds: int = Field(default=300, ge=60, le=86400)


@app.patch(PREFIX + "/agents/{agent_id}", dependencies=[Depends(require_admin)])
async def configure_agent(agent_id: str, body: AgentConfig):
    from .safe_fetch import validate_url, FetchError
    from .discovery_urls import public_content_url
    with Session() as db:
        agent = db.get(Agent, agent_id)
        if not agent:
            raise HTTPException(404, "Agent not found")
    seeds = []
    for submitted in body.seeds:
        url = public_content_url(submitted, agent_id)
        if url is None:
            raise HTTPException(422, "Use a public profile, channel or post URL on this platform; login, search and service pages are not sources")
        if url in seeds:
            continue
        try:
            await validate_url(url)
        except (ValueError, OSError, FetchError) as error:
            raise HTTPException(422, "Unsafe or unavailable seed URL") from error
        seeds.append(url)
    with Session.begin() as db:
        agent = db.get(Agent, agent_id)
        agent.seeds, agent.interval_seconds = seeds, body.interval_seconds
        if agent.enabled:
            agent.next_run_at = utcnow()
        result = agent_json(agent)
    audit("configuration", f"Updated {len(seeds)} public seed URLs", agent_id)
    return result


@app.get(PREFIX + "/agents/{agent_id}/logs")
def agent_logs(agent_id: str):
    with Session() as db:
        if not db.get(Agent, agent_id):
            raise HTTPException(404, "Agent not found")
        return {"items": [{"id": row.id, "at": iso(row.at), "stage": row.stage, "message": row.message, "task_id": row.task_id} for row in db.scalars(select(AuditLog).where(AuditLog.agent_id == agent_id).order_by(AuditLog.id.desc()).limit(100))]}


class ScanBody(BaseModel):
    url: str = Field(default="", max_length=2048)
    text: str = Field(default="", max_length=20000)
    platform: str = Field(default="", max_length=20)
    mode: Mode = "live"
    locale: Locale = "ru"

    @model_validator(mode="after")
    def check_source(self):
        self.url, self.text = self.url.strip(), self.text.strip()
        if bool(self.url) == bool(self.text):
            raise ValueError("Supply exactly one public URL or text")
        if self.mode == "demo" and self.url:
            raise ValueError("Demo mode accepts synthetic text only")
        return self


@app.post(PREFIX + "/scans", status_code=202, dependencies=[Depends(require_admin)])
async def create_scan(body: ScanBody):
    if body.url:
        from .safe_fetch import validate_url, FetchError
        try:
            await validate_url(body.url)
        except (ValueError, OSError, FetchError) as error:
            raise HTTPException(422, "Unsafe, invalid or unresolved public URL") from error
    with Session.begin() as db:
        count = db.scalar(select(func.count()).select_from(ScanTask).where(ScanTask.status.in_(["queued", "running"])))
        if count >= settings.max_tasks:
            raise HTTPException(429, "Queue is full. Wait for current checks to finish.")
        task = ScanTask(url=body.url, input_text=runner.redact(body.text), platform=runner.platform_for(body.url) if body.url else "manual", mode=body.mode, locale=body.locale)
        db.add(task)
        db.flush()
        result = scan_json(db, task)
    audit("queued", "Public URL queued" if body.url else "User-supplied text queued", task_id=result["id"])
    runner.dispatch(result["id"])
    return result


@app.get(PREFIX + "/scans")
def scans(mode: Mode = "live", limit: int = Query(50, ge=1, le=100), offset: int = Query(0, ge=0), level: str = "", platform: str = ""):
    with Session() as db:
        query = select(ScanTask).where(ScanTask.mode == mode)
        if platform:
            query = query.where(ScanTask.platform == platform)
        if level:
            query = query.join(RiskAssessment, RiskAssessment.task_id == ScanTask.id).where(RiskAssessment.level == level)
        total = db.scalar(select(func.count()).select_from(query.subquery()))
        items = [scan_json(db, row) for row in db.scalars(query.order_by(ScanTask.created_at.desc()).offset(offset).limit(limit))]
        return {"items": items, "total": total}


@app.get(PREFIX + "/scans/{scan_id}")
def get_scan(scan_id: str):
    with Session() as db:
        task = db.get(ScanTask, scan_id)
        if not task:
            raise HTTPException(404, "Scan not found")
        return scan_json(db, task)


class ReviewBody(BaseModel):
    decision: Literal["confirmed_signals", "false_positive", "needs_context"]
    note: str = Field(default="", max_length=2000)


@app.post(PREFIX + "/scans/{scan_id}/review", dependencies=[Depends(require_admin)])
def review_scan(scan_id: str, body: ReviewBody):
    with Session.begin() as db:
        task = db.get(ScanTask, scan_id)
        if not task:
            raise HTTPException(404, "Scan not found")
        if task.status != "completed":
            raise HTTPException(409, "Only completed assessments can be reviewed")
        task.review = {"decision": body.decision, "note": runner.redact(body.note), "at": utcnow().isoformat(), "reviewer": "administrator"}
        result = scan_json(db, task)
    audit("review", "Human review: " + body.decision, task_id=scan_id)
    return result


def report_json(row):
    return {"id": row.id, "scan_id": row.scan_id, "created_at": iso(row.created_at), "title": row.title, "markdown": row.markdown}


class ReportBody(BaseModel):
    scan_id: str = Field(max_length=36)


@app.post(PREFIX + "/reports", dependencies=[Depends(require_admin)])
def make_report(body: ReportBody):
    scan = get_scan(body.scan_id)
    if scan["status"] != "completed":
        raise HTTPException(409, "Wait for the assessment to complete")
    analysis = scan["analysis"]
    lines = ["# SafeNet AI — preliminary assessment", "", "This is a screening result, not proof of fraud or a legal verdict.", "", f"Mode: {scan['mode']}", f"Source: {scan['url'] or 'User-supplied text (not independently fetched)'}", f"Collected: {scan['completed_at']}", f"Risk: {scan['score']}/100 ({scan['level']})", f"Category: {scan['category']}", "", "## Explanation", analysis["summary"], "", "## Evidence"]
    if scan["metadata"].get("origin") == "legacy_public_capture":
        metadata = scan["metadata"]
        lines[6] = f"Originally captured: {metadata.get('captured_at') or 'unknown'}"
        lines[7:7] = [f"Imported / reassessed: {metadata.get('imported_at')}", "Historical material; not freshly fetched.", f"Original collection method: {metadata.get('legacy_provenance', {}).get('method', 'unknown')}", f"Original scope: {metadata.get('legacy_provenance', {}).get('scope', metadata.get('content_scope'))}"]
    for item in analysis.get("evidence", []):
        timestamp = f" [{item.get('modality')}, {item['start_seconds']:.1f}–{item.get('end_seconds', item['start_seconds']):.1f}s]" if "start_seconds" in item else ""
        lines += [f"- {item['label']} (+{item['weight']}){timestamp}", "> " + item.get("quote", "").replace("\n", "\n> ")]
    lines += ["", "## Recommendations"] + ["- " + item for item in analysis.get("recommendations", [])]
    lines += ["", "## Limitations"] + ["- " + item for item in analysis.get("limitations", [])]
    media = scan["metadata"].get("media")
    if media:
        lines += ["", "## Media processing", f"Status: {media.get('status')}", f"Analyzed: {media.get('analyzed_seconds', 0)} seconds; total duration: {media.get('duration_seconds', 'unknown')}", "Visual model observations are hypotheses for human review and do not increase the score.", "The uploaded file's source attribution is not independently verified." if scan["metadata"].get("origin") in {"uploaded_media", "synthetic_media"} else "Publicly accessible media only."]
        lines += [f"- [{row['start']:.1f}–{row['end']:.1f}s] {row['text']}" for row in media.get("transcript", [])]
    elif scan["url"] and scan["metadata"].get("origin") != "legacy_public_capture":
        lines += ["- Scope: " + str(scan["metadata"].get("content_scope", "available public text")), "- Video frames and audio were not analyzed. A low text score does not establish that the video is safe."]
    if scan["review"]:
        lines += ["", "## Human review", scan["review"]["decision"], "> " + scan["review"]["note"].replace("\n", "\n> ")]
    with Session.begin() as db:
        row = Report(scan_id=body.scan_id, title=f"SafeNet • {scan['category']} • {scan['score']}/100", markdown="\n".join(lines))
        db.add(row)
        db.flush()
        result = report_json(row)
    audit("report", "Report generated from stored assessment", task_id=body.scan_id)
    return result


@app.get(PREFIX + "/reports")
def reports():
    with Session() as db:
        return {"items": [report_json(row) for row in db.scalars(select(Report).order_by(Report.created_at.desc()).limit(100))]}


@app.get(PREFIX + "/reports/{report_id}")
def get_report(report_id: str):
    with Session() as db:
        row = db.get(Report, report_id)
        if not row:
            raise HTTPException(404, "Report not found")
        return report_json(row)


class AssistantBody(BaseModel):
    question: str = Field(min_length=1, max_length=2000)
    scan_id: str | None = Field(default=None, max_length=36)
    locale: Locale = "ru"


@app.post(PREFIX + "/assistant", dependencies=[Depends(require_admin)])
async def assistant(body: AssistantBody):
    general = {
        "ru": "Выберите завершённую проверку: я объясню её признаки и приведу источник. Не передавайте коды подтверждения и пароли; проверяйте адрес организации через её официальное приложение. Оценка SafeNet предварительная и не доказывает мошенничество.",
        "kk": "Аяқталған тексеруді таңдаңыз: белгілерін түсіндіріп, дереккөзін көрсетемін. Растау кодтары мен құпиясөздерді бермеңіз; ұйымның мекенжайын ресми қолданба арқылы тексеріңіз. SafeNet бағасы бастапқы, алаяқтықты дәлелдемейді.",
        "en": "Select a completed assessment so I can explain its evidence and source. Do not share verification codes or passwords; check organizations through their official apps. A SafeNet score is preliminary, not proof of fraud.",
    }
    if not body.scan_id:
        return {"answer": general[body.locale], "provider": "evidence_assistant", "citations": [], "status": "rules_only"}
    scan = get_scan(body.scan_id)
    if not scan["analysis"]:
        raise HTTPException(409, "This check has no assessment yet")
    from .llm import explain_with_llm
    result = await explain_with_llm(scan["analysis"], scan["text"], question=body.question, locale=body.locale)
    if result.get("status") == "completed":
        return {"answer": result["explanation"], "provider": result["provider"], "citations": result.get("citations", []), "status": "completed"}
    analysis = scan["analysis"]
    answer = analysis["summary"] + "\n\n" + "\n".join(f"• {item['label']}: «{item.get('quote', '')}»" for item in analysis.get("evidence", []))
    answer += "\n\n" + "\n".join(analysis.get("recommendations", []))
    return {"answer": answer, "provider": "evidence_assistant", "citations": [scan["url"]] if scan["url"] else [], "status": "rules_only" if result.get("status") == "disabled" else "llm_unavailable"}


@app.get(PREFIX + "/settings")
def get_settings():
    cap = capabilities()
    return {"capabilities": cap, "retention_days": settings.retention_days, "mode": "live", "queue": settings.queue, "llm": cap["llm"], "browser": cap["browser"]}


@app.websocket("/events")
async def events(websocket: WebSocket, mode: str = "live"):
    if mode not in ("live", "demo") or websocket.headers.get("origin", "").rstrip("/") not in settings.origins:
        await websocket.close(code=1008)
        return
    await websocket.accept()
    try:
        while True:
            snapshot = await asyncio.to_thread(overview, mode)
            await websocket.send_json({"type": "snapshot", "data": snapshot})
            await asyncio.sleep(2)
    except (WebSocketDisconnect, RuntimeError):
        pass


app.include_router(media_router)
app.include_router(networks_router)

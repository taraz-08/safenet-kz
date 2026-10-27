import asyncio
import logging
import re
import threading
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from urllib.parse import urlsplit
from sqlalchemy import select, update, func, delete
from .discovery_urls import public_content_urls
from .settings import settings
from .models import Agent, ScanTask, ScannedContent, RiskAssessment, Evidence, Report, AuditLog, utcnow
from .store import Session, audit

logger = logging.getLogger("safenet.runner")
_executor = ThreadPoolExecutor(max_workers=4, thread_name_prefix="safenet-agent")
_stop = threading.Event()
_thread = None
_schedule_lock = threading.Lock()
_lifecycle_lock = threading.Lock()
_startup_recovered = False


def platform_for(url):
    host = (urlsplit(url).hostname or "").lower()
    for platform, roots in {"tiktok": ("tiktok.com",), "instagram": ("instagram.com",), "youtube": ("youtube.com", "youtu.be"), "threads": ("threads.net", "threads.com"), "telegram": ("t.me",)}.items():
        if any(host == root or host.endswith("." + root) for root in roots):
            return platform
    return "web"


def redact(text):
    # Retain wording needed for review, not full payment card or phone numbers.
    text = re.sub(r"(?<!\d)(?:\d[ -]?){13,19}(?!\d)", "[payment details redacted]", text)
    text = re.sub(r"(?<!\w)\+?[78][ ()-]*\d{3}[ ()-]*\d{3}[ -]*\d{2}[ -]*\d{2}(?!\d)", "[phone redacted]", text)
    text = re.sub(r"\b(?:ИИН|ЖСН|IIN)\s*[:№-]?\s*\d{12}\b", "[identity number redacted]", text, flags=re.I)
    return text[:20000]


def dispatch(task_id):
    try:
        if settings.queue == "celery":
            from .worker import execute_scan
            execute_scan.delay(task_id)
        elif settings.queue == "local":
            _executor.submit(execute, task_id)
        else:
            raise RuntimeError("Unsupported queue configuration")
    except Exception:
        logger.exception("dispatch_failed", extra={"task_id": task_id})
        with Session.begin() as db:
            db.execute(update(ScanTask).where(ScanTask.id == task_id, ScanTask.status == "queued", ScanTask.cancel_requested == False).values(status="failed", stage="queue_unavailable", error="The task queue is unavailable. Check worker and broker health.", completed_at=utcnow()))
        audit("queue_unavailable", "Dispatch failed; no analysis was performed", task_id=task_id)


class ScanCancelled(Exception):
    pass


def _claim_running_write(db, task_id, stage):
    result = db.execute(update(ScanTask).where(ScanTask.id == task_id, ScanTask.status == "running", ScanTask.cancel_requested == False).values(stage=stage))
    return result.rowcount == 1


def _discover_monitor_sources(db, task, links):
    """Route fetched public links to enabled monitors without inheriting risk.

    Each platform admits <=10 new URLs per collected page and <=100 seeds total.
    Collection remains separately scheduled with its existing cooldown and DNS /
    access checks. Manual text, uploads and demo data cannot seed live monitoring.
    """
    if task.mode != "live" or not task.url or task.input_text or task.input_media:
        return
    for target in db.scalars(select(Agent).where(Agent.enabled == True).order_by(Agent.id).with_for_update()):
        seeds = public_content_urls(target.seeds, target.platform)
        additions = [url for url in public_content_urls(links, target.platform) if url not in seeds]
        additions = additions[:min(10, 100 - len(seeds))]
        target.seeds = seeds + additions
        for url in additions:
            db.add(AuditLog(
                stage="source_discovered", agent_id=target.id, task_id=task.id,
                message=f"Public link from {task.platform} source {task.url[:2048]}: {url}. "
                        "Awaiting separate collection; a link does not establish risk or common ownership.",
            ))


def execute(task_id):
    with Session.begin() as db:
        claimed = db.execute(update(ScanTask).where(ScanTask.id == task_id, ScanTask.status == "queued", ScanTask.cancel_requested == False).values(status="running", stage="starting", started_at=utcnow()))
        if claimed.rowcount != 1:
            return
        task = db.get(ScanTask, task_id)
        payload = {key: getattr(task, key) for key in ("url", "input_text", "input_media", "platform", "mode", "locale", "agent_id")}
        if task.agent_id:
            agent = db.get(Agent, task.agent_id)
            # Legacy queued tasks may predate seed filtering. Persist cleanup even
            # when collection later fails or the agent has since been stopped.
            agent.seeds = public_content_urls(agent.seeds, agent.platform)
            if not agent.enabled:
                task.status, task.stage, task.completed_at = "cancelled", "stopped", utcnow()
                return
            agent.status, agent.stage = "running", "starting"

    async def progress(event):
        stage = str(event.get("stage", "processing"))[:80]
        message = str(event.get("message", stage))[:1200]
        with Session.begin() as db:
            task = db.get(ScanTask, task_id)
            if not task or task.cancel_requested or task.status == "cancelled":
                raise ScanCancelled()
            if not _claim_running_write(db, task_id, stage):
                raise ScanCancelled()
            if task.agent_id:
                agent = db.get(Agent, task.agent_id)
                agent.stage = stage
        audit(stage, message, payload["agent_id"], task_id)

    async def process():
        from .analysis import analyze
        from .llm import explain_with_llm
        from .media import task_directory, process_media, assess_media, is_video_url, failure
        media = None
        if payload["input_media"]:
            title = {"ru": "Загруженное фото / видео / аудио", "kk": "Жүктелген фото / бейне / аудио", "en": "Uploaded image / video / audio"}.get(payload["locale"], "Uploaded media")
            content = {"status": "completed", "url": payload["url"], "title": title, "text": "", "links": [], "metadata": {"origin": "uploaded_media" if payload["mode"] == "live" else "synthetic_media", "independently_fetched": False, "content_scope": "uploaded_media_speech_and_sampled_frames"}}
            media = await process_media(task_directory(task_id) / "input.bin", task_id, progress, redact)
            if media.get("has_image"):
                content["title"] = {"ru": "Проверка загруженного изображения", "kk": "Жүктелген суретті тексеру", "en": "Uploaded image analysis"}.get(payload["locale"], "Uploaded image analysis")
        elif payload["input_text"]:
            await progress({"stage": "analyzing", "message": "Analyzing user-supplied text"})
            content = {"status": "completed", "url": payload["url"], "title": "Manual text analysis" if payload["mode"] == "live" else "Synthetic example", "text": payload["input_text"], "links": [], "metadata": {"origin": "manual" if payload["mode"] == "live" else "synthetic", "independently_fetched": False}}
        else:
            from .collectors import collect
            await progress({"stage": "opening", "message": f"Opening public {payload['platform']} URL"})
            content = await collect(payload["url"], platform=payload["platform"], on_event=progress)
            if is_video_url(payload["url"]):
                if not settings.media_enabled:
                    media = failure("Media processing is disabled on this server; analyze the file in the local SafeNet application.")
                elif content.get("status") == "blocked":
                    media = failure(content.get("reason") or "The platform restricts public access. Upload the video for analysis.")
                else:
                    from .media_fetch import acquire_public_media
                    await progress({"stage": "fetching_media", "message": "Checking for an accessible public video file"})
                    acquisition = await acquire_public_media(payload["url"], task_directory(task_id, create=True) / "input.mp4", on_event=progress)
                    if acquisition.get("status") == "completed":
                        media = await process_media(acquisition["path"], task_id, progress, redact)
                        acquired_metadata = acquisition.get("metadata", {})
                        content.setdefault("metadata", {})["media_source"] = {"source_url": payload["url"], "independently_fetched": True, "media_kind": acquired_metadata.get("media_kind", "video"), "coverage": acquired_metadata.get("coverage", "public_video")}
                    else:
                        media = failure(acquisition.get("reason") or "The public page does not expose a downloadable video. Upload a file to analyze its contents.")
        if media is not None:
            content.setdefault("metadata", {})["media"] = media
        if content.get("status") != "completed" and not (media and media.get("status") in {"completed", "partial"}):
            return content, None
        content["text"] = redact(content.get("text", ""))
        await progress({"stage": "analyzing", "message": "Analyzing available text and source links"})
        if media is not None:
            result, context = assess_media(content["text"], media, url=payload["url"], links=content.get("links", []), locale=payload["locale"])
            if result is None:
                content["reason"] = media.get("reason") or "No speech, OCR or page text could be analyzed. No score was assigned."
                return content, None
            if media.get("status") in {"completed", "partial"}:
                content["status"] = "completed"
                content["metadata"]["content_scope"] = ("uploaded_image_ocr_and_visual_observations" if payload["input_media"] else "public_preview_image_ocr_and_visual_observations") if media.get("has_image") else ("uploaded_media_speech_and_sampled_frames" if payload["input_media"] else "public_video_speech_and_sampled_frames")
                content["metadata"]["limitations"] = [x for x in content["metadata"].get("limitations", []) if "Video, audio, transcripts" not in x]
            content["text"] = context
        else:
            result = analyze(content["text"], url=content.get("url") or payload["url"], links=content.get("links", []), locale=payload["locale"])
        llm = await explain_with_llm(result, content["text"], locale=payload["locale"])
        result["llm"] = llm
        await progress({"stage": "saving", "message": "Saving assessment and quoted evidence"})
        return content, result

    try:
        content, result = asyncio.run(asyncio.wait_for(process(), timeout=600 if payload["input_media"] or payload["platform"] in {"instagram", "tiktok"} else 120))
        with Session.begin() as db:
            task = db.get(ScanTask, task_id)
            if not task or task.cancel_requested:
                raise ScanCancelled()
            # Claim the final write under the same transaction as the evidence.
            # Stop may have committed after the SELECT above; a stale ORM object
            # must never resurrect a cancelled task.
            if not _claim_running_write(db, task_id, "committing"):
                raise ScanCancelled()
            task.completed_at = utcnow()
            metadata = content.get("metadata") or {}
            if result is not None or metadata.get("media"):
                metadata.update({"source_url": content.get("url") or task.url, "collected_at": utcnow().isoformat(), "content_scope": metadata.get("content_scope", "available page text only"), "screenshot_available": False})
                db.add(ScannedContent(task_id=task.id, title=redact(str(content.get("title", "")))[:500], text=content.get("text", ""), links=content.get("links", [])[:100], source_metadata=metadata))
            if result is None:
                task.status = "blocked" if content.get("status") == "blocked" else "failed"
                task.stage, task.error = task.status, str(content.get("reason") or "Public content could not be obtained")[:1200]
            else:
                task.status, task.stage = "completed", "completed"
                risk = RiskAssessment(task_id=task.id, score=result["score"], level=result["level"], category=result["category"], analysis=result)
                db.add(risk)
                db.flush()
                for item in result.get("evidence", []):
                    db.add(Evidence(assessment_id=risk.id, code=item["code"], quote=item.get("quote", ""), label=item["label"], weight=item["weight"], source_url=item.get("source_url") or task.url))
            if result:
                # Lock target agents in one order before updating this agent's
                # counters, avoiding opposite lock orders in concurrent workers.
                _discover_monitor_sources(db, task, content.get("links", []))
            if task.agent_id:
                agent = db.get(Agent, task.agent_id)
                if agent.enabled:
                    agent.status = "idle" if result else task.status
                    agent.stage, agent.last_error = task.stage, task.error
                    if task.status == "blocked":
                        agent.next_run_at = utcnow() + timedelta(seconds=max(900, agent.interval_seconds))
                if result:
                    agent.checked += 1
                    agent.flagged += int(result["score"] >= 30)
            db.add(AuditLog(stage="completed" if result else "unavailable", message="Assessment saved" if result else "Content unavailable; no risk score assigned", agent_id=payload["agent_id"], task_id=task_id))
    except ScanCancelled:
        with Session.begin() as db:
            task = db.get(ScanTask, task_id)
            if task and task.cancel_requested:
                task.status, task.stage, task.completed_at = "cancelled", "stopped", utcnow()
        audit("discarded", "Task is no longer active; late result discarded", payload["agent_id"], task_id)
    except Exception as error:
        logger.exception("scan_failed", extra={"task_id": task_id})
        with Session.begin() as db:
            task = db.get(ScanTask, task_id)
            if task:
                if task.cancel_requested:
                    task.status, task.stage, task.completed_at = "cancelled", "stopped", utcnow()
                    return
                if not _claim_running_write(db, task_id, "failing"):
                    return
                task.status, task.stage, task.completed_at = "failed", "failed", utcnow()
                task.error = "Collection or analysis failed (" + type(error).__name__ + "). No score was assigned."
                if task.agent_id:
                    agent = db.get(Agent, task.agent_id)
                    if agent.enabled:
                        agent.status, agent.stage, agent.last_error = "failed", "failed", task.error
        audit("failed", "Collection or analysis did not complete", payload["agent_id"], task_id)


def _recover_local_tasks():
    """Only at the first scheduler start in this single-worker API process.

    The old thread queue no longer exists after a process restart. Keep task
    identity and creation time; schedule() will replay each eligible task once.
    Never call this while an existing process's executor still owns the tasks.
    """
    with Session.begin() as db:
        for task in db.scalars(select(ScanTask).where(ScanTask.status.in_(["queued", "running"]))):
            agent = db.get(Agent, task.agent_id) if task.agent_id else None
            if task.cancel_requested or (task.agent_id and (not agent or not agent.enabled)):
                task.cancel_requested = True
                task.status, task.stage, task.completed_at = "cancelled", "stopped", utcnow()
                message = "Interrupted task cancelled: cancellation requested or monitor stopped"
            else:
                task.status, task.stage = "queued", "recovery_pending"
                task.started_at, task.completed_at, task.error = None, None, None
                message = "Interrupted local task recovered; awaiting replay under the existing monitor cooldown"
            db.add(AuditLog(stage=task.stage, message=message, agent_id=task.agent_id, task_id=task.id))


def _resume_recovered_tasks(db, ids):
    for task in db.scalars(select(ScanTask).where(ScanTask.status == "queued", ScanTask.stage == "recovery_pending").order_by(ScanTask.created_at, ScanTask.id).with_for_update()):
        agent = db.get(Agent, task.agent_id) if task.agent_id else None
        if task.cancel_requested or (task.agent_id and (not agent or not agent.enabled)):
            task.cancel_requested = True
            task.status, task.stage, task.completed_at = "cancelled", "stopped", utcnow()
            continue
        if agent and agent.status == "blocked" and agent.next_run_at and agent.next_run_at.replace(tzinfo=utcnow().tzinfo) > utcnow():
            continue
        task.stage = "recovered"
        # Lease begins when resubmitted, not at the original pre-restart date.
        # execute() replaces this timestamp when it claims the actual work.
        task.started_at = utcnow()
        if agent:
            agent.status, agent.stage = "queued", "recovered"
        ids.append(task.id)


def schedule():
    if not _schedule_lock.acquire(blocking=False):
        return
    ids = []
    try:
        with Session.begin() as db:
            if settings.queue == "local":
                _resume_recovered_tasks(db, ids)
            pending = db.scalar(select(func.count()).select_from(ScanTask).where(ScanTask.status.in_(["queued", "running"])))
            for agent in db.scalars(select(Agent).where(Agent.enabled == True).with_for_update(skip_locked=True)):
                seeds = public_content_urls(agent.seeds, agent.platform)
                if seeds != agent.seeds:
                    agent.seeds = seeds
                if db.scalar(select(ScanTask.id).where(ScanTask.agent_id == agent.id, ScanTask.status.in_(["queued", "running"])).limit(1)):
                    continue
                if not agent.seeds:
                    agent.status, agent.stage = "idle", "waiting_for_seed"
                    continue
                if pending >= settings.max_tasks:
                    continue
                if agent.next_run_at and agent.next_run_at.replace(tzinfo=utcnow().tzinfo) > utcnow():
                    continue
                task = ScanTask(url=agent.seeds[agent.source_cursor % len(agent.seeds)], platform=agent.platform, agent_id=agent.id, mode="live")
                agent.source_cursor += 1
                db.add(task)
                db.flush()
                ids.append(task.id)
                agent.status, agent.stage = "queued", "queued"
                agent.last_run_at, agent.next_run_at = utcnow(), utcnow() + timedelta(seconds=agent.interval_seconds)
                pending += 1
        for task_id in ids:
            dispatch(task_id)
    finally:
        _schedule_lock.release()


def cleanup():
    from .media import remove_media
    cutoff = utcnow() - timedelta(days=max(1, settings.retention_days))
    with Session.begin() as db:
        expired_ids = list(db.scalars(select(ScanTask.id).where(ScanTask.created_at < cutoff, ScanTask.status.not_in(["queued", "running"]))))
        db.execute(delete(ScanTask).where(ScanTask.created_at < cutoff, ScanTask.status.not_in(["queued", "running"])))
        db.execute(delete(AuditLog).where(AuditLog.at < cutoff))
        stale = utcnow() - timedelta(minutes=12)
        db.execute(update(ScanTask).where(func.coalesce(ScanTask.started_at, ScanTask.created_at) < stale, ScanTask.status.in_(["running", "queued"]), ScanTask.stage != "recovery_pending").values(status="failed", stage="worker_interrupted", error="Queue or worker did not finish within the lease period. Retry the check.", completed_at=utcnow()))
    for task_id in expired_ids:
        remove_media(task_id)


def start_scheduler():
    global _thread, _startup_recovered
    if not settings.scheduler_enabled or settings.queue != "local":
        return
    def loop():
        ticks = 0
        while not _stop.is_set():
            try:
                schedule()
                if ticks % 360 == 0:
                    cleanup()
            except Exception:
                logger.exception("scheduler_failed")
            ticks += 1
            _stop.wait(10)
    with _lifecycle_lock:
        if _thread and _thread.is_alive():
            return
        if not _startup_recovered:
            with _schedule_lock:
                _recover_local_tasks()
            _startup_recovered = True
        _stop.clear()
        _thread = threading.Thread(target=loop, daemon=True, name="safenet-scheduler")
        _thread.start()


def stop_scheduler():
    with _lifecycle_lock:
        _stop.set()
        if _thread:
            _thread.join(timeout=2)

"""Authenticated, streaming bounded uploads. No client paths are accepted."""
from uuid import uuid4
from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse
from starlette.datastructures import UploadFile
from starlette.formparsers import MultiPartException
from sqlalchemy import select, func
from .auth import require_admin
from .settings import settings
from .media import MAX_BYTES, task_directory, remove_media
from .media_worker import image_format
from .models import ScanTask, ScannedContent
from .store import Session, scan_json, audit
from . import runner

UPLOAD_PATH = "/api/v1/media/scans"
MAX_REQUEST = MAX_BYTES + 1024 * 1024
router = APIRouter()


class UploadLimitMiddleware:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or scope.get("path") != UPLOAD_PATH or scope.get("method") != "POST":
            return await self.app(scope, receive, send)
        request = Request(scope)
        try:
            require_admin(request)
        except HTTPException as error:
            return await JSONResponse({"detail": error.detail}, status_code=error.status_code)(scope, receive, send)
        size = request.headers.get("content-length", "")
        if size.isdigit() and int(size) > MAX_REQUEST:
            return await JSONResponse({"detail": "Media request exceeds 65 MiB"}, status_code=413)(scope, receive, send)
        total, exceeded, started = 0, False, False
        async def bounded_receive():
            nonlocal total, exceeded
            message = await receive()
            if message["type"] == "http.request":
                total += len(message.get("body", b""))
                if total > MAX_REQUEST:
                    exceeded = True
                    # Starlette closes multipart spool files on this exception.
                    raise MultiPartException("Media request exceeds 65 MiB")
            return message
        async def bounded_send(message):
            nonlocal started
            if message["type"] == "http.response.start":
                started = True
                if exceeded:
                    message = dict(message, status=413)
            await send(message)
        try:
            await self.app(scope, bounded_receive, bounded_send)
        except MultiPartException:
            if started:
                raise
            await JSONResponse({"detail": "Media request exceeds 65 MiB"}, status_code=413)(scope, receive, send)


def supported_header(data):
    if image_format(data):
        return True
    return bool(data.startswith((b"ID3", b"fLaC", b"OggS", b"\x1a\x45\xdf\xa3")) or (data[:4] == b"RIFF" and data[8:12] in (b"WAVE", b"AVI ")) or data[4:8] == b"ftyp" or (len(data) > 2 and data[0] == 255 and data[1] & 0xE0 == 0xE0))


@router.post(UPLOAD_PATH, status_code=202, dependencies=[Depends(require_admin)])
async def upload_media(request: Request):
    if not settings.media_enabled:
        raise HTTPException(503, "Media processing is disabled")
    task_id = str(uuid4())
    committed = False
    try:
        async with request.form(max_files=1, max_fields=3, max_part_size=4096) as form:
            file = form.get("file")
            mode, locale = form.get("mode", "live"), form.get("locale", "ru")
            source_url = form.get("source_url", "")
            if not isinstance(file, UploadFile) or mode not in ("live", "demo") or locale not in ("ru", "kk", "en") or not isinstance(source_url, str):
                raise HTTPException(422, "Supply a media file and valid mode/locale")
            source_url = source_url.strip()
            if source_url:
                from .safe_fetch import validate_url, FetchError
                try:
                    if len(source_url) > 2048:
                        raise ValueError()
                    await validate_url(source_url)
                except (ValueError, OSError, FetchError) as error:
                    raise HTTPException(422, "Invalid public source URL") from error
            with Session() as db:
                count = db.scalar(select(func.count()).select_from(ScanTask).where(ScanTask.status.in_(["queued", "running"])))
                if count >= settings.max_tasks:
                    raise HTTPException(429, "Queue is full")
            path = task_directory(task_id, create=True) / "input.bin"
            size = 0
            with path.open("xb") as output:
                while chunk := await file.read(256 * 1024):
                    if size == 0 and not supported_header(chunk):
                        raise HTTPException(415, "Unsupported media container. Use JPEG, PNG, WebP, MP4, MOV, WebM, MP3, WAV, M4A, FLAC or OGG")
                    size += len(chunk)
                    if size > MAX_BYTES:
                        raise HTTPException(413, "Media file exceeds 64 MiB")
                    output.write(chunk)
            if not size:
                raise HTTPException(422, "Media file is empty")
            with Session.begin() as db:
                task = ScanTask(id=task_id, url=source_url, input_media={"kind": "upload", "bytes": size}, platform=runner.platform_for(source_url) if source_url else "manual", mode=mode, locale=locale)
                db.add(task)
                db.flush()
                result = scan_json(db, task)
            committed = True
        audit("queued", "Operator-uploaded media queued; source attribution is not independently verified", task_id=task_id)
        runner.dispatch(task_id)
        return result
    finally:
        if not committed:
            remove_media(task_id)


@router.get("/api/v1/scans/{scan_id}/frames/{index}", dependencies=[Depends(require_admin)])
def get_frame(scan_id: str, index: int):
    if index not in range(6):
        raise HTTPException(404, "Frame not found")
    try:
        path = task_directory(scan_id) / f"frame-{index}.jpg"
    except ValueError:
        raise HTTPException(404, "Frame not found")
    with Session() as db:
        content = db.scalar(select(ScannedContent).where(ScannedContent.task_id == scan_id))
        if not content or not path.is_file():
            raise HTTPException(404, "Frame not found")
    return FileResponse(path, media_type="image/jpeg", headers={"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"})

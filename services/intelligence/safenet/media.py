"""Bounded local media orchestration and evidence fusion; no remote decoding."""
import asyncio
import base64
import importlib.util
import json
import math
import os
from pathlib import Path
import shutil
import signal
import sys
import threading
import time
from uuid import UUID
from filelock import FileLock, Timeout as LockTimeout
from .settings import settings, PROJECT_ROOT

MAX_BYTES = 64 * 1024 * 1024
MAX_SECONDS = 120
REPO = PROJECT_ROOT
_worker_slot = threading.BoundedSemaphore(1)


def task_directory(task_id, *, create=False):
    identity = str(UUID(str(task_id)))
    root = Path(settings.media_root).resolve()
    directory = root / identity
    if directory.resolve().parent != root:
        raise ValueError("Invalid media directory")
    if create:
        directory.mkdir(parents=True, exist_ok=True)
    return directory


def remove_media(task_id):
    directory = task_directory(task_id)
    if directory.exists():
        shutil.rmtree(directory)


def media_capabilities():
    decoder = settings.media_enabled and importlib.util.find_spec("av") is not None
    whisper = decoder and importlib.util.find_spec("faster_whisper") is not None and (Path(settings.whisper_model) / "model.bin").is_file()
    ocr = decoder and bool(shutil.which("node")) and (REPO / "node_modules/tesseract.js").is_dir() and all((REPO / f"public/ocr/{lang}.traineddata.gz").is_file() for lang in ("eng", "rus", "kaz"))
    return {"video_analysis": bool(ocr), "audio_transcription": bool(whisper), "media_processing": {
        "enabled": settings.media_enabled, "decoder": bool(decoder), "ocr": bool(ocr), "speech": bool(whisper),
        "visual_model": settings.vision_model if settings.vision_url else None, "visual_model_status": "configured_not_probed" if settings.vision_url else "disabled",
        "max_bytes": MAX_BYTES, "max_seconds": MAX_SECONDS, "max_frames": 6,
        "public_download": "instagram_tiktok_public_video_or_verified_preview", "uploads": True, "image_analysis": bool(ocr),
        "limitations": ["Only accessible public media or operator-uploaded files are processed. A preview image does not cover the full video.", "Sampled frames may miss brief advertisements. Visual model observations require review."]}}


def is_video_url(url):
    from urllib.parse import urlsplit
    import re
    parts = urlsplit(url)
    host = (parts.hostname or "").lower()
    return bool((host in {"instagram.com", "www.instagram.com", "m.instagram.com"} and re.fullmatch(r"/(?:reel|reels|p|tv)/[\w-]+/?", parts.path)) or (host in {"tiktok.com", "www.tiktok.com", "m.tiktok.com"} and re.fullmatch(r"/@[^/]+/(?:video|photo)/\d+/?", parts.path)))


def failure(reason):
    return {"status": "unavailable", "reason": reason, "transcript": [], "frames": [], "audio": {"status": "unavailable", "reason": reason}, "visual": {"status": "unavailable", "reason": reason}, "limitations": [reason]}


def _number(value, maximum=MAX_SECONDS):
    try:
        number = float(value)
        return max(0, min(maximum, number)) if math.isfinite(number) else 0
    except (ValueError, TypeError):
        return 0


def clean_result(result, task_id, redact):
    """Never put local paths, large base64 blobs, or arbitrary worker output in DB."""
    output = {key: result[key] for key in ("status", "reason", "duration_seconds", "analyzed_seconds", "truncated", "has_audio", "has_video", "has_image", "audio", "visual", "limitations") if key in result}
    output["transcript"] = [{"start": _number(row.get("start")), "end": _number(row.get("end")), "text": redact(str(row.get("text", "")))[:2000]} for row in result.get("transcript", [])[:500] if isinstance(row, dict) and row.get("text")]
    frames = []
    for index, row in enumerate(result.get("frames", [])[:6]):
        if not isinstance(row, dict):
            continue
        frame = {"at": _number(row.get("at")), "text": redact(str(row.get("text", "")))[:4000], "observations": [redact(str(value))[:1000] for value in row.get("observations", [])[:12]], "ocr_confidence": _number(row.get("ocr_confidence"), 100), "visual_status": str(row.get("visual_status", "unavailable"))[:40]}
        thumbnail = row.get("thumbnail", "")
        if isinstance(thumbnail, str) and len(thumbnail) <= 2_000_000:
            try:
                data = base64.b64decode(thumbnail.split(",")[-1], validate=True)
                if data.startswith(b"\xff\xd8\xff"):
                    (task_directory(task_id, create=True) / f"frame-{index}.jpg").write_bytes(data)
                    frame["thumbnail_url"] = f"/api/v1/scans/{task_id}/frames/{index}"
            except (ValueError, OSError):
                pass
        frames.append(frame)
    output["frames"] = frames
    return output


def interrupted_result(checkpoint, task_id, redact):
    try:
        if checkpoint.is_file() and checkpoint.stat().st_size <= 16_000_000:
            saved = json.loads(checkpoint.read_text(encoding="utf-8"))
            saved["status"] = "partial"
            saved["reason"] = "processing_interrupted_partial"
            saved["limitations"] = list(dict.fromkeys(saved.get("limitations", []) + ["processing_interrupted_partial"]))
            return clean_result(saved, task_id, redact)
    except (ValueError, OSError, TypeError):
        pass
    return failure("Media analysis reached its time or output limit. No missing content was scored.")


async def process_media(path, task_id, progress, redact):
    if not settings.media_enabled:
        return failure("Media processing is disabled by the operator.")
    path = Path(path).resolve()
    if path.parent != task_directory(task_id).resolve() or not path.is_file() or path.stat().st_size > MAX_BYTES:
        return failure("Invalid or oversized local media file.")
    acquired = False
    process_lock = FileLock(str(path.parent.parent / ".worker.lock"), thread_local=False)
    process_acquired = False
    process = None
    output_path = path.parent / "worker-result.json"
    checkpoint = path.parent / "worker-checkpoint.json"
    checkpoint.unlink(missing_ok=True)
    started = time.monotonic()
    try:
        while not process_acquired:
            if not acquired:
                acquired = _worker_slot.acquire(blocking=False)
            if acquired:
                try:
                    process_lock.acquire(timeout=0)
                    process_acquired = True
                except LockTimeout:
                    pass
            if not process_acquired:
                if time.monotonic() - started > 90:
                    return failure("The local media worker is busy. Retry this check shortly.")
                await progress({"stage": "waiting_media", "message": "Waiting for the local media worker"})
                await asyncio.sleep(3)
        await progress({"stage": "analyzing_media", "message": "Extracting speech and sampled video frames locally"})
        payload = {"path": str(path), "media_root": str(path.parent), "checkpoint_path": str(checkpoint), "whisper_model": settings.whisper_model, "vision_model": settings.vision_model, "ollama_url": settings.vision_url, "ocr_script": str(REPO / "services/intelligence/media-ocr.mjs")}
        with output_path.open("wb") as output:
            process = await asyncio.create_subprocess_exec(sys.executable, "-m", "safenet.media_worker", stdin=asyncio.subprocess.PIPE, stdout=output, stderr=asyncio.subprocess.DEVNULL, cwd=str(Path(__file__).resolve().parents[1]), creationflags=0x08000000 if os.name == "nt" else 0, start_new_session=os.name != "nt")
            process.stdin.write(json.dumps(payload).encode())
            await process.stdin.drain()
            process.stdin.close()
            waiter = asyncio.create_task(process.wait())
            deadline = time.monotonic() + min(360, max(15, settings.media_timeout_seconds))
            while not waiter.done():
                if time.monotonic() > deadline or output_path.stat().st_size > 16_000_000:
                    return interrupted_result(checkpoint, task_id, redact)
                await progress({"stage": "analyzing_media", "message": "Recognizing audio and frames; the result will include processing coverage"})
                try:
                    await asyncio.wait_for(asyncio.shield(waiter), timeout=5)
                except asyncio.TimeoutError:
                    pass
        if process.returncode != 0:
            if checkpoint.is_file():
                return interrupted_result(checkpoint, task_id, redact)
            return failure("The local media worker could not decode or analyze this file.")
        result = json.loads(output_path.read_text(encoding="utf-8"))
        return clean_result(result, task_id, redact)
    except (OSError, ValueError, TypeError):
        return failure("Media processing returned an invalid result or is not installed.")
    finally:
        try:
            if process and process.returncode is None:
                try:
                    if os.name == "nt":
                        killer = await asyncio.create_subprocess_exec("taskkill", "/PID", str(process.pid), "/T", "/F", stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL, creationflags=0x08000000)
                        await asyncio.wait_for(killer.wait(), timeout=5)
                    else:
                        os.killpg(process.pid, signal.SIGKILL)
                except (OSError, asyncio.TimeoutError):
                    try:
                        process.kill()
                    except OSError:
                        pass
                try:
                    await asyncio.wait_for(process.wait(), timeout=5)
                except (OSError, asyncio.TimeoutError):
                    pass
            try:
                output_path.unlink(missing_ok=True)
                checkpoint.unlink(missing_ok=True)
            except OSError:
                pass
        finally:
            try:
                if process_acquired:
                    process_lock.release()
            finally:
                if acquired:
                    _worker_slot.release()


def assess_media(page_text, media, *, url="", links=None, locale="ru"):
    """Use observed speech/OCR only. Repetition and model labels add no points."""
    from .analysis import analyze
    # A model's description is a review aid, never observed text or rule evidence.
    review_frames = []
    for index, frame in enumerate(media.get("frames", [])[:6]):
        observations = [item.strip()[:240] for item in frame.get("observations", [])
                        if isinstance(item, str) and item.strip()][:6]
        if observations:
            review_frames.append({"frame_index": index, "at": frame.get("at", 0),
                                  "observations": observations})
    has_visual = bool(media.get("has_image") or media.get("has_video") or media.get("frames"))
    candidates = []
    contexts = []
    sources = []
    def add(text, modality, start=None, end=None, segments=None):
        if not text.strip():
            return
        result = analyze(text, url=url, links=links, locale=locale)
        for item in result["evidence"]:
            item["modality"] = modality
            if start is not None:
                item.update(start_seconds=start, end_seconds=end)
                match = next((row for row in (segments or []) if item["quote"] in row[2]), None)
                if match:
                    item.update(start_seconds=match[0], end_seconds=match[1])
        candidates.append(result)
        contexts.append(text)
        sources.append({"text": text, "modality": modality, "start": start, "end": end, "segments": segments or []})
    add(page_text, "page_text")
    window = []
    for segment in media.get("transcript", []):
        start, end = _number(segment.get("start")), _number(segment.get("end"))
        if window and (start - window[-1][1] > 3 or end - window[0][0] > 30):
            add(" ".join(row[2] for row in window), "speech", window[0][0], window[-1][1], window)
            window = []
        window.append((start, end, segment["text"]))
    if window:
        add(" ".join(row[2] for row in window), "speech", window[0][0], window[-1][1], window)
    for frame in media.get("frames", []):
        add(frame.get("text", ""), "frame_text", frame["at"], frame["at"])
    # A quoted ad on screen must retain the warning spoken over the same scene
    # (and vice versa). Never extend that reduction to a later unrelated scene.
    for speech_index, speech in enumerate(sources):
        if speech["modality"] != "speech":
            continue
        for frame_index, frame in enumerate(sources):
            if frame["modality"] != "frame_text" or not speech["start"] - 1 <= frame["start"] <= speech["end"] + 1:
                continue
            combined = speech["text"] + "\n" + frame["text"]
            contextual = analyze(combined, url=url, links=links, locale=locale)
            if not any(row["code"].endswith("warning_context") for row in contextual["evidence"]):
                continue
            for index in (speech_index, frame_index):
                if candidates[index]["score"] <= contextual["score"]:
                    continue
                contextual_copy = dict(contextual, evidence=[dict(row) for row in contextual["evidence"]])
                for row in contextual_copy["evidence"]:
                    source = speech if row["quote"] in speech["text"] else frame
                    row.update(modality=source["modality"], start_seconds=source["start"], end_seconds=source["end"])
                    match = next((segment for segment in source["segments"] if row["quote"] in segment[2]), None)
                    if match:
                        row.update(start_seconds=match[0], end_seconds=match[1])
                candidates[index] = contextual_copy
                contexts[index] = combined
    if not candidates:
        # Zero is only the text/rules result. Visual coverage is reported separately.
        succeeded = media.get("audio", {}).get("status") in {"completed", "no_speech"} or media.get("visual", {}).get("status") in {"completed", "partial"}
        if not succeeded:
            return None, ""
        candidates = [analyze("", url=url, locale=locale)]
        contexts = [""]
    best_index = max(range(len(candidates)), key=lambda index: candidates[index]["score"])
    result = candidates[best_index]
    result["media_evidence"] = [dict(item) for candidate in candidates for item in candidate.get("evidence", [])][:60]
    li = ("ru", "kk", "en").index(locale) if locale in ("ru", "kk", "en") else 0
    if has_visual:
        notice = (("Нужна проверка кадров. Описания модели могут ошибаться и не добавляют баллы риска.",
                   "Кадрларды тексеру қажет. Модель сипаттамалары қате болуы мүмкін және тәуекел балын қоспайды.",
                   "Frames need review. Model descriptions may be wrong and add no risk points.") if review_frames else
                  ("Проверка изображения ограничена. OCR проверяет только текст; отсутствие текста не означает безопасность кадра.",
                   "Суретті тексеру шектеулі. OCR тек мәтінді тексереді; мәтіннің болмауы кадрдың қауіпсіздігін білдірмейді.",
                   "Visual coverage is limited. OCR checks text only; no text does not mean the frame is safe."))[li]
        result["visual_review_required"] = bool(review_frames)
        result["visual_review"] = {"status": "required" if review_frames else "coverage_limited",
                                   "reason": "model_observations_need_review" if review_frames else "visual_coverage_limited",
                                   "frames": review_frames, "notice": notice}
        result["limitations"].append(notice)
    result["limitations"].append(("Речь и текст на отдельных кадрах распознаны автоматически; возможны ошибки. Выбран максимальный балл одного источника: повторы не суммируются. Визуальные описания модели не увеличивают балл.", "Сөйлеу мен жеке кадр мәтіні автоматты танылды; қателер болуы мүмкін. Бір дереккөздің ең жоғары балы алынды; қайталау қосылмайды. Модельдің визуалды сипаттамалары баллды өсірмейді.", "Speech and sampled-frame OCR are machine recognized and may be wrong. The strongest single source is scored; repetitions and visual model descriptions add no points.")[li])
    result["limitations"].extend(media.get("limitations", [])[:12])
    result["method"] = "rules_media" if media.get("status") in {"completed", "partial"} else "rules"
    return result, contexts[best_index]

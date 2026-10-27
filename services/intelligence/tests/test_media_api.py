"""Real upload/routes/persistence; inference mocked to make failures deterministic."""
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock
import struct
from uuid import uuid4
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker
from safenet import app as api, runner, store, uploads, media, llm, collectors, media_fetch
from safenet.models import ScanTask, ScannedContent, Base

PROMO = "Казино pokerdom. Бонус по промокоду. Пополнение депозита."
WAV = b"RIFF" + struct.pack("<I", 40) + b"WAVEfmt " + bytes(28)


@pytest.fixture
def media_api(tmp_path, monkeypatch):
    engine = create_engine("sqlite:///" + str(tmp_path / "test.db"), connect_args={"check_same_thread": False})
    sessions = sessionmaker(engine, expire_on_commit=False)
    for module in (store, api, runner, uploads):
        monkeypatch.setattr(module, "Session", sessions)
    monkeypatch.setattr(store, "engine", engine)
    for key, value in {"scheduler_enabled": False, "local_admin": True, "media_enabled": True, "media_root": str(tmp_path / "media"), "max_tasks": 100}.items():
        monkeypatch.setattr(api.settings, key, value)
    dispatch = Mock()
    monkeypatch.setattr(runner, "dispatch", dispatch)
    monkeypatch.setattr(llm, "explain_with_llm", AsyncMock(return_value={"status": "disabled"}))
    Base.metadata.create_all(engine)
    with TestClient(api.app) as client:
        yield SimpleNamespace(client=client, Session=sessions, dispatch=dispatch, root=tmp_path / "media")
    engine.dispose()


def recognized(text=PROMO):
    return {"status": "completed", "has_audio": True, "has_video": False, "audio": {"status": "completed"}, "visual": {"status": "not_present"}, "transcript": [{"start": 2, "end": 8, "text": text}], "frames": [], "limitations": []}


def test_uploaded_speech_without_description_becomes_timestamped_evidence(media_api, monkeypatch):
    response = media_api.client.post("/api/v1/media/scans", files={"file": ("../../unsafe.wav", WAV)}, data={"mode": "demo"})
    assert response.status_code == 202
    identity = response.json()["id"]
    assert (media_api.root / identity / "input.bin").read_bytes() == WAV
    monkeypatch.setattr(media, "process_media", AsyncMock(return_value=recognized()))
    runner.execute(identity)
    result = media_api.client.get(f"/api/v1/scans/{identity}").json()
    assert result["status"] == "completed" and result["category"] == "casino" and result["score"] >= 60
    assert result["metadata"]["independently_fetched"] is False
    assert result["metadata"]["origin"] == "synthetic_media"
    assert all(row["modality"] == "speech" and row["start_seconds"] == 2 for row in result["analysis"]["evidence"])
    report = media_api.client.post("/api/v1/reports", json={"scan_id": identity}).json()["markdown"]
    assert "speech, 2.0" in report and "were not analyzed" not in report


def test_failed_inference_is_unscored_but_keeps_coverage(media_api, monkeypatch):
    identity = media_api.client.post("/api/v1/media/scans", files={"file": ("input.wav", WAV)}).json()["id"]
    monkeypatch.setattr(media, "process_media", AsyncMock(return_value=media.failure("Whisper missing")))
    runner.execute(identity)
    result = media_api.client.get(f"/api/v1/scans/{identity}").json()
    assert result["status"] == "failed" and result["score"] is None
    assert result["metadata"]["media"]["reason"] == "Whisper missing"


def test_public_permalink_processes_video_without_caption(media_api, monkeypatch):
    with media_api.Session.begin() as db:
        task = ScanTask(url="https://www.instagram.com/reel/abc123/", platform="instagram")
        db.add(task); db.flush(); identity = task.id
    monkeypatch.setattr(collectors, "collect", AsyncMock(return_value={"status": "unavailable", "text": "", "metadata": {}, "links": []}))
    acquire = AsyncMock(return_value={"status": "completed", "path": "unused-mocked-path"})
    monkeypatch.setattr(media_fetch, "acquire_public_media", acquire)
    monkeypatch.setattr(media, "process_media", AsyncMock(return_value=recognized()))
    runner.execute(identity)
    result = media_api.client.get(f"/api/v1/scans/{identity}").json()
    assert result["score"] >= 60 and result["metadata"]["media_source"]["independently_fetched"]
    assert acquire.call_args.args[1].suffix == ".mp4"


def test_public_gate_never_triggers_media_download(media_api, monkeypatch):
    with media_api.Session.begin() as db:
        task = ScanTask(url="https://www.instagram.com/reel/abc123/", platform="instagram")
        db.add(task); db.flush(); identity = task.id
    monkeypatch.setattr(collectors, "collect", AsyncMock(return_value={"status": "blocked", "reason": "Login required", "metadata": {}}))
    acquire = AsyncMock()
    monkeypatch.setattr(media_fetch, "acquire_public_media", acquire)
    runner.execute(identity)
    acquire.assert_not_called()
    result = media_api.client.get(f"/api/v1/scans/{identity}").json()
    assert result["status"] == "blocked" and result["score"] is None
    assert result["metadata"]["media"]["status"] == "unavailable"


def test_cloud_text_only_mode_does_not_download_media(media_api, monkeypatch):
    with media_api.Session.begin() as db:
        task = ScanTask(url="https://www.instagram.com/reel/abc123/", platform="instagram")
        db.add(task); db.flush(); identity = task.id
    monkeypatch.setattr(runner.settings, "media_enabled", False)
    monkeypatch.setattr(collectors, "collect", AsyncMock(return_value={"status": "completed", "text": PROMO, "metadata": {}, "links": []}))
    acquire = AsyncMock()
    monkeypatch.setattr(media_fetch, "acquire_public_media", acquire)
    runner.execute(identity)
    acquire.assert_not_called()
    result = media_api.client.get(f"/api/v1/scans/{identity}").json()
    assert result["status"] == "completed" and result["score"] >= 60
    assert result["metadata"]["media"]["status"] == "unavailable"


def test_upload_auth_checked_before_stream_and_cross_site_rejected(media_api, monkeypatch):
    monkeypatch.setattr(api.settings, "local_admin", False)
    assert media_api.client.post("/api/v1/media/scans", content=b"malformed").status_code == 401
    monkeypatch.setattr(api.settings, "local_admin", True)
    assert media_api.client.post("/api/v1/media/scans", headers={"origin": "https://evil.example"}, files={"file": ("input.wav", WAV)}).status_code == 403


def test_bad_media_and_limits_cleanup_files(media_api, monkeypatch):
    assert media_api.client.post("/api/v1/media/scans", files={"file": ("bad.mp4", b"#EXTM3U\nhttp://127.0.0.1/")}).status_code == 415
    monkeypatch.setattr(uploads, "MAX_BYTES", 20)
    assert media_api.client.post("/api/v1/media/scans", files={"file": ("big.wav", WAV)}).status_code == 413
    assert not list(media_api.root.glob("*/input.bin"))
    monkeypatch.setattr(uploads, "MAX_REQUEST", 100)
    assert media_api.client.post("/api/v1/media/scans", content=b"x" * 101).status_code == 413


def test_chunked_request_limit_without_content_length(media_api, monkeypatch):
    monkeypatch.setattr(uploads, "MAX_REQUEST", 200)
    headers = {"Content-Type": "multipart/form-data; boundary=test"}
    data = b'--test\r\nContent-Disposition: form-data; name="file"; filename="file.wav"\r\nContent-Type: audio/wav\r\n\r\n' + WAV + bytes(200) + b"\r\n--test--\r\n"
    response = media_api.client.post("/api/v1/media/scans", headers=headers, content=iter([data[:150], data[150:]]))
    assert response.status_code == 413


def test_ocr_alone_flags_and_visual_model_alone_does_not():
    result, _ = media.assess_media("", {"frames": [{"at": 5, "text": PROMO}], "status": "completed"})
    assert result["category"] == "casino" and result["evidence"][0]["modality"] == "frame_text"
    result, _ = media.assess_media("", {"frames": [{"at": 5, "text": "", "observations": [PROMO]}], "visual": {"status": "unavailable"}, "status": "partial"})
    assert result is None


def test_warning_and_separated_contexts_do_not_false_flag():
    result, _ = media.assess_media("", recognized("Предупреждение: мошенники предлагают казино и бонус по промокоду."))
    assert result["score"] < 30
    separated = recognized()
    separated["transcript"] = [{"start": 0, "end": 2, "text": "История казино"}, {"start": 40, "end": 45, "text": "Бонус по промокоду в магазине"}]
    result, _ = media.assess_media("", separated)
    assert result["score"] == 0


def test_repeated_frames_do_not_add_risk_and_paths_cannot_escape(media_api):
    frame = {"at": 3, "text": PROMO}
    once, _ = media.assess_media("", {"status": "completed", "frames": [frame]})
    repeated, _ = media.assess_media("", {"status": "completed", "frames": [frame] * 6})
    assert repeated["score"] == once["score"]
    with pytest.raises(ValueError):
        media.task_directory("../../outside")
    assert media_api.client.get(f"/api/v1/scans/{uuid4()}/frames/99").status_code == 404


def test_overlapping_spoken_warning_dampens_quoted_visual_ad_only_in_that_scene():
    clip = recognized("Это предупреждение о мошенничестве. Не верьте рекламе.")
    clip["frames"] = [{"at": 5, "text": PROMO}]
    result, _ = media.assess_media("", clip)
    assert result["score"] < 30
    warning = next(row for row in result["evidence"] if row["code"].endswith("warning_context"))
    assert warning["modality"] == "speech" and warning["start_seconds"] == 2
    clip["frames"].append({"at": 50, "text": PROMO})
    assert media.assess_media("", clip)[0]["score"] >= 60


def test_mobile_and_legacy_video_permalinks_trigger_media_acquisition():
    assert media.is_video_url("https://m.instagram.com/reel/abc123/")
    assert media.is_video_url("https://www.instagram.com/tv/abc123/")
    assert not media.is_video_url("https://instagram.com.evil.example/reel/abc123/")


def test_speech_evidence_uses_its_segment_not_the_entire_clip():
    clip = recognized()
    clip["transcript"] = [{"start": 0, "end": 2, "text": "Казино pokerdom."}, {"start": 2, "end": 5, "text": "Бонус по промокоду."}]
    result, _ = media.assess_media("", clip)
    assert result["score"] >= 60
    assert [(row["start_seconds"], row["end_seconds"]) for row in result["evidence"]] == [(0, 2), (2, 5)]


def test_timeout_checkpoint_keeps_only_observed_evidence(media_api):
    import json
    identity = str(uuid4())
    directory = media.task_directory(identity, create=True)
    checkpoint = directory / "worker-checkpoint.json"
    checkpoint.write_text(json.dumps(recognized()), encoding="utf-8")
    recovered = media.interrupted_result(checkpoint, identity, runner.redact)
    assert recovered["status"] == "partial" and recovered["reason"] == "processing_interrupted_partial"
    assert media.assess_media("", recovered)[0]["score"] >= 60
    checkpoint.write_text("{unfinished", encoding="utf-8")
    assert media.interrupted_result(checkpoint, identity, runner.redact)["status"] == "unavailable"


def test_cleanup_permission_failure_cannot_lock_the_worker(media_api, monkeypatch):
    import asyncio
    import json
    from pathlib import Path
    from filelock import FileLock
    identity = str(uuid4())
    directory = media.task_directory(identity, create=True)
    path = directory / "input.bin"
    path.write_bytes(WAV)
    process = SimpleNamespace(returncode=0, stdin=SimpleNamespace(write=Mock(), drain=AsyncMock(), close=Mock()), wait=AsyncMock(return_value=0))
    async def launch(*args, **kwargs):
        kwargs["stdout"].write(json.dumps(recognized()).encode())
        kwargs["stdout"].flush()
        return process
    unlink = Path.unlink
    def fail_cleanup(self, *args, **kwargs):
        if self.name == "worker-result.json":
            raise PermissionError("simulated scanner file lock")
        return unlink(self, *args, **kwargs)
    monkeypatch.setattr(media.asyncio, "create_subprocess_exec", launch)
    monkeypatch.setattr(Path, "unlink", fail_cleanup)
    result = asyncio.run(media.process_media(path, identity, AsyncMock(), runner.redact))
    assert result["status"] == "completed"
    assert media._worker_slot.acquire(blocking=False)
    media._worker_slot.release()
    lock = FileLock(str(media_api.root / ".worker.lock"))
    lock.acquire(timeout=0)
    lock.release()


@pytest.mark.parametrize("fmt", ["JPEG", "PNG", "WEBP"])
def test_image_upload_uses_bytes_not_filename_or_mime(media_api, fmt):
    import io
    from PIL import Image
    output = io.BytesIO()
    Image.new("RGB", (20, 20), "white").save(output, format=fmt)
    data = output.getvalue()
    response = media_api.client.post("/api/v1/media/scans", files={"file": ("../../misleading.bin", data, "text/plain")}, data={"mode": "demo"})
    assert response.status_code == 202
    identity = response.json()["id"]
    assert (media_api.root / identity / "input.bin").read_bytes() == data
    media_api.dispatch.assert_called_once_with(identity)


@pytest.mark.parametrize("data", [b'<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>', b"GIF89a" + bytes(40), b"RIFF" + bytes(4) + b"FAKE" + bytes(32)])
def test_svg_gif_and_fake_webp_rejected_even_named_png(media_api, data):
    response = media_api.client.post("/api/v1/media/scans", files={"file": ("screenshot.png", data, "image/png")})
    assert response.status_code == 415
    media_api.dispatch.assert_not_called()
    assert not list(media_api.root.glob("*/input.bin"))


def test_clean_image_preserves_type_without_creating_video_duration(media_api):
    result = media.clean_result({"status": "completed", "has_image": True, "has_video": False,
        "has_audio": False, "duration_seconds": None, "analyzed_seconds": 0,
        "audio": {"status": "not_present"}, "visual": {"status": "completed"},
        "frames": [], "transcript": [], "limitations": []}, str(uuid4()), lambda text: text)
    assert result["has_image"] and result["duration_seconds"] is None
    assert result["has_video"] is False


def test_photo_upload_decode_ocr_persist_and_protected_thumbnail(media_api, monkeypatch):
    import io
    from PIL import Image
    from safenet import media_worker
    output = io.BytesIO()
    Image.new("RGB", (32, 32), "white").save(output, format="PNG")
    response = media_api.client.post("/api/v1/media/scans", files={"file": ("photo.png", output.getvalue())}, data={"mode": "demo"})
    identity = response.json()["id"]
    def ocr(frames, script, deadline):
        frames[0].update(text=PROMO, ocr_confidence=.95)
        return media_worker._state("completed", model="test OCR")
    monkeypatch.setattr(media_worker, "_ocr", ocr)
    async def process(path, task_id, progress, redact):
        result = media_worker.process({"path": str(path), "vision_model": None})
        return media.clean_result(result, task_id, redact)
    monkeypatch.setattr(media, "process_media", process)
    runner.execute(identity)
    result = media_api.client.get(f"/api/v1/scans/{identity}").json()
    assert result["score"] >= 60 and result["category"] == "casino"
    assert result["metadata"]["independently_fetched"] is False
    coverage = result["metadata"]["media"]
    assert coverage["has_image"] and not coverage["has_video"]
    assert result["metadata"]["content_scope"] == "uploaded_image_ocr_and_visual_observations"
    assert "image" in result["title"].lower() or "изображения" in result["title"].lower()
    assert coverage["duration_seconds"] is None and len(coverage["frames"]) == 1
    assert all(row["modality"] == "frame_text" for row in result["analysis"]["evidence"])
    preview = media_api.client.get(f"/api/v1/scans/{identity}/frames/0")
    assert preview.status_code == 200 and preview.headers["content-type"] == "image/jpeg"
    monkeypatch.setattr(api.settings, "local_admin", False)
    assert media_api.client.get(f"/api/v1/scans/{identity}/frames/0").status_code == 401


def test_corrupt_photo_upload_cannot_become_zero_risk(media_api, monkeypatch):
    from safenet import media_worker
    response = media_api.client.post("/api/v1/media/scans", files={"file": ("photo.png", b"\x89PNG\r\n\x1a\ncorrupt")}, data={"mode": "demo"})
    identity = response.json()["id"]
    async def process(path, task_id, progress, redact):
        return media.clean_result(media_worker.process({"path": str(path), "vision_model": None}), task_id, redact)
    monkeypatch.setattr(media, "process_media", process)
    runner.execute(identity)
    result = media_api.client.get(f"/api/v1/scans/{identity}").json()
    assert result["score"] is None and result["status"] == "failed"
    assert result["metadata"]["media"]["visual"]["status"] == "unavailable"

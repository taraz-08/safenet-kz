"""Offline media boundary tests. Real PyAV fixtures, patched model inference."""
import asyncio
import base64
from fractions import Fraction
import io
import json
import math
import os
from pathlib import Path
import subprocess
import sys
import time
from types import SimpleNamespace
import wave

import httpx
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from safenet import media_worker as worker


def test_docker_shallow_path_can_import_without_optional_dependencies():
    source = Path(worker.__file__).read_text(encoding="utf-8")
    namespace = {"__file__": "/app/safenet/media_worker.py", "__name__": "safenet.media_worker"}
    exec(compile(source, namespace["__file__"], "exec"), namespace)
    assert namespace["ROOT"] == Path("/app")
    assert namespace["DEFAULT_OCR_SCRIPT"] == Path("/app/media-ocr.mjs").resolve()


@pytest.fixture
def media_libraries():
    return pytest.importorskip("av"), pytest.importorskip("numpy")


def make_clip(path, av, np, *, seconds=3, audio=True, video=True, audio_offset=0):
    """Lossless tiny local Matroska, without ffmpeg executables or fixtures."""
    with av.open(str(path), "w", format="matroska") as output:
        if video:
            visual = output.add_stream("ffv1", rate=4)
            visual.width, visual.height, visual.pix_fmt = 320, 180, "yuv420p"
            visual.codec_context.thread_count = 2
        if audio:
            sound = output.add_stream("pcm_s16le", rate=48000)
            sound.layout = "mono"
        for index in range(math.ceil(seconds * 4)):
            if video:
                pixels = np.full((180, 320, 3), index % 200, dtype=np.uint8)
                frame = av.VideoFrame.from_ndarray(pixels, format="rgb24")
                frame.pts, frame.time_base = index, Fraction(1, 4)
                for packet in visual.encode(frame):
                    output.mux(packet)
            if audio and index / 4 >= audio_offset:
                values = np.full((1, 12000), 1000, dtype=np.int16)
                frame = av.AudioFrame.from_ndarray(values, format="s16", layout="mono")
                frame.sample_rate, frame.pts, frame.time_base = 48000, index * 12000, Fraction(1, 48000)
                for packet in sound.encode(frame):
                    output.mux(packet)
        if video:
            for packet in visual.encode():
                output.mux(packet)
        if audio:
            for packet in sound.encode():
                output.mux(packet)
    return path


@pytest.fixture
def clip(tmp_path, media_libraries):
    return make_clip(tmp_path / "fixture.mkv", *media_libraries)


@pytest.fixture
def offline_inference(monkeypatch):
    calls = []

    def transcribe(path, model, seconds, deadline, *, on_segment=None):
        with wave.open(str(path), "rb") as audio:
            assert audio.getframerate() == 16000
            assert audio.getnchannels() == 1
            assert audio.getsampwidth() == 2
            assert audio.getnframes() == round(seconds * 16000)
            assert audio.getnframes() <= 120 * 16000
        calls.append(path)
        segments = [{"start": 0.1, "end": min(seconds, 1.0), "text": "Привет. Сәлем. Hello."}]
        if on_segment is not None:
            on_segment(dict(segments[0]), "stub")
        return segments, worker._state("completed", model="stub"), []

    monkeypatch.setattr(worker, "_transcribe", transcribe)
    monkeypatch.setattr(worker, "_ocr", lambda frames, script, deadline: worker._state("completed", model="stub"))
    monkeypatch.setattr(worker, "_vision", lambda *a: worker._state(reason="offline_vision"))
    return calls


def test_real_clip_contract_and_temp_cleanup(clip, offline_inference):
    result = worker.process({"path": str(clip), "media_root": str(clip.parent), "vision_model": None})
    assert result["status"] == "completed", result
    assert result["has_audio"] and result["has_video"]
    assert result["duration_seconds"] == pytest.approx(3, abs=0.02)
    assert result["analyzed_seconds"] == pytest.approx(3, abs=0.02)
    assert not result["truncated"]
    assert result["transcript"][0]["text"] == "Привет. Сәлем. Hello."
    assert len(result["frames"]) == 6
    assert [f["at"] for f in result["frames"]] == pytest.approx([0, .5, 1, 1.5, 2, 2.5])
    assert result["visual"]["status"] == "completed"
    from PIL import Image
    for frame in result["frames"]:
        assert "_ocr_image" not in frame
        with Image.open(io.BytesIO(base64.b64decode(frame["thumbnail"]))) as image:
            assert image.format == "JPEG" and max(image.size) <= 512
    assert all(not path.exists() for path in offline_inference)


def test_long_clip_reports_truncation_and_spread(tmp_path, media_libraries, offline_inference):
    path = make_clip(tmp_path / "long.mkv", *media_libraries, seconds=122)
    result = worker.process({"path": str(path), "vision_model": None})
    assert result["status"] == "partial"
    assert result["truncated"] and result["duration_seconds"] == pytest.approx(122, abs=.1)
    assert result["analyzed_seconds"] == 120
    assert len(result["frames"]) == 6
    assert result["frames"][-1]["at"] >= 100
    assert all(0 <= f["at"] < 120 for f in result["frames"])


def test_audio_offsets_become_silence_not_shifted_speech(tmp_path, media_libraries):
    path = make_clip(tmp_path / "offset.mkv", *media_libraries, audio_offset=1)
    output = tmp_path / "decoded.wav"
    seconds, truncated, reason = worker._extract_audio(path, output, time.monotonic() + 20)
    assert seconds == pytest.approx(3, abs=.01) and not truncated and reason is None
    with wave.open(str(output)) as decoded:
        assert decoded.readframes(16000) == b"\x00\x00" * 16000
        assert any(decoded.readframes(16000))


@pytest.mark.parametrize("audio,video", [(True, False), (False, True)])
def test_missing_track_is_not_a_runtime_failure(tmp_path, media_libraries, offline_inference, audio, video):
    path = make_clip(tmp_path / "single.mkv", *media_libraries, audio=audio, video=video)
    result = worker.process({"path": str(path), "vision_model": None})
    assert result["status"] == "completed", result
    assert result["has_audio"] is audio and result["has_video"] is video
    assert result["visual" if audio else "audio"]["status"] == "not_present"


@pytest.mark.parametrize("path", ["https://example.test/video.mp4", "file:///tmp/private.wav",
                                 "concat:a.wav|b.wav", "\\\\server\\share\\file.wav",
                                 "//server/share/file.wav", "C:/file.wav:private", "pipe:0"])
def test_nonlocal_inputs_never_reach_decoder(monkeypatch, path):
    monkeypatch.setattr(worker, "_open_media", lambda *a: pytest.fail("decoder was called"))
    result = worker.process({"path": path})
    assert result["status"] == "unavailable"
    assert result["limitations"] == ["local_files_only"]


def test_root_escape_and_oversize_rejected_before_decode(tmp_path, monkeypatch):
    path = tmp_path / "test.wav"
    path.write_bytes(b"1234")
    root = tmp_path / "media"
    root.mkdir()
    monkeypatch.setattr(worker, "_open_media", lambda *a: pytest.fail("decoder was called"))
    assert "outside_media_root" in worker.process({"path": str(path), "media_root": str(root)})["limitations"]
    monkeypatch.setattr(worker, "MAX_BYTES", 3)
    assert "invalid_media_size_or_type" in worker.process({"path": str(path)})["limitations"]


def test_symlink_escape_is_rejected(tmp_path):
    root = tmp_path / "root"
    root.mkdir()
    outside = tmp_path / "outside.wav"
    outside.write_bytes(b"test")
    link = root / "inside.wav"
    try:
        link.symlink_to(outside)
    except OSError:
        pytest.skip("Symlink creation unavailable on this Windows account")
    assert "outside_media_root" in worker.process({"path": str(link), "media_root": str(root)})["limitations"]


def test_disguised_playlist_is_not_demuxed(tmp_path, media_libraries):
    path = tmp_path / "playlist.mp4"
    path.write_text("#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXTINF:1,\nhttp://127.0.0.1:1/private.ts\n#EXT-X-ENDLIST\n")
    result = worker.process({"path": str(path)})
    assert result["status"] == "unavailable"
    assert result["frames"] == [] and result["transcript"] == []


def test_pixel_cap_is_enforced_before_decoding(clip, monkeypatch, offline_inference):
    monkeypatch.setattr(worker, "MAX_PIXELS", 100)
    result = worker.process({"path": str(clip), "vision_model": None})
    assert result["visual"]["status"] == "unavailable"
    assert not result["frames"]
    # libav may reject the oversized codec during header probing, before it
    # exposes dimensions to Python. Both paths must refuse frame allocation.
    assert {"decoded_pixel_limit", "video_decode_failed"} & set(result["limitations"])
    assert result["audio"]["status"] == "completed"


def test_decode_error_preserves_previous_frames(clip, monkeypatch, offline_inference):
    original = worker._decoded

    def broken(container, stream, deadline):
        for index, frame in enumerate(original(container, stream, deadline)):
            if stream.type == "video" and index == 3:
                raise RuntimeError("secret path and media must not leak")
            yield frame

    monkeypatch.setattr(worker, "_decoded", broken)
    result = worker.process({"path": str(clip), "vision_model": None})
    assert result["status"] == "partial"
    assert len(result["frames"]) == 2
    assert result["visual"]["status"] == "partial"
    assert "video_decode_failed" in result["limitations"]
    assert "secret" not in json.dumps(result)


@pytest.fixture
def stub_model(tmp_path, monkeypatch):
    model_path = tmp_path / "test-model"
    model_path.mkdir()
    for name in ("model.bin", "config.json", "tokenizer.json"):
        (model_path / name).write_text("test")
    calls = {}
    segments = []

    class Model:
        def __init__(self, path, **options):
            calls["load"] = options

        def transcribe(self, path, **options):
            calls["transcribe"] = options
            return iter(segments), SimpleNamespace(language="kk")

    monkeypatch.setitem(sys.modules, "faster_whisper", SimpleNamespace(WhisperModel=Model))
    return model_path, calls, segments


def segment(text, start=.1, end=.9, no_speech_prob=.1, avg_logprob=-.2):
    return SimpleNamespace(text=text, start=start, end=end,
                           no_speech_prob=no_speech_prob, avg_logprob=avg_logprob)


def test_whisper_filters_hallucinations_and_keeps_multilingual_times(stub_model, tmp_path):
    path, calls, segments = stub_model
    segments.extend([segment("Привет"), segment("Сәлем", start=1, end=2),
                     segment("Hello", start=2, end=3), segment("silence quote", no_speech_prob=.9),
                     segment("unlikely quote", avg_logprob=-1.5), segment("bad timestamp", end=float("nan"))])
    result, state, limitations = worker._transcribe(tmp_path / "stub.wav", str(path), 3, time.monotonic() + 10)
    assert [s["text"] for s in result] == ["Привет", "Сәлем", "Hello"]
    assert result[-1]["start"] == 2 and result[-1]["end"] == 3
    assert result[0]["confidence"] == pytest.approx(math.exp(-.2), abs=.001)
    assert state["status"] == "completed" and "low_confidence_speech_omitted" in limitations
    assert calls["load"] == {"device": "cpu", "compute_type": "int8", "cpu_threads": 2,
                             "num_workers": 1, "local_files_only": True}
    assert calls["transcribe"]["language"] is None
    assert calls["transcribe"]["multilingual"] and calls["transcribe"]["vad_filter"]
    assert calls["transcribe"]["condition_on_previous_text"] is False


def test_empty_speech_is_success_not_unavailable(stub_model, tmp_path):
    path, _, _ = stub_model
    result, state, _ = worker._transcribe(tmp_path / "stub.wav", str(path), 1, time.monotonic() + 10)
    assert result == [] and state["status"] == "no_speech"


def test_empty_ocr_and_speech_are_completed_observations(clip, offline_inference, monkeypatch):
    monkeypatch.setattr(worker, "_transcribe", lambda *a: ([], worker._state("no_speech"), []))
    result = worker.process({"path": str(clip), "vision_model": None})
    assert result["status"] == "completed" and result["audio"]["status"] == "no_speech"
    assert result["visual"]["status"] == "completed"
    assert not result["transcript"] and all(not f["text"] for f in result["frames"])


def test_failed_vision_keeps_successful_ocr_status(clip, offline_inference):
    result = worker.process({"path": str(clip)})
    assert result["status"] == "partial" and result["visual"]["status"] == "partial"
    assert result["limitations"].count("offline_vision") == 1


def test_vision_alone_is_not_successful_ocr(clip, offline_inference, monkeypatch):
    monkeypatch.setattr(worker, "_ocr", lambda *a: worker._state(reason="ocr_failed"))

    def vision(frame, *args):
        frame["observations"] = ["A red rectangle."]
        return worker._state("completed")

    monkeypatch.setattr(worker, "_vision", vision)
    result = worker.process({"path": str(clip)})
    assert result["visual"]["status"] == "unavailable"
    assert all(f["text"] == "" and f["observations"] == ["A red rectangle."] for f in result["frames"])


def test_ocr_filters_low_confidence_output(clip, monkeypatch):
    frames = [{"text": "", "_ocr_image": "test"}, {"text": "", "_ocr_image": "test"}]
    script = worker.ROOT / "services/intelligence/media-ocr.mjs"
    monkeypatch.setattr(worker.shutil, "which", lambda _: "node")
    monkeypatch.setattr(worker, "_bounded_child", lambda *a: {
        "status": "completed", "frames": [{"text": "weak guess", "confidence": .59},
                                             {"text": "observed", "confidence": .9}]})
    state = worker._ocr(frames, str(script), time.monotonic() + 10)
    assert state["status"] == "completed"
    assert frames[0]["text"] == "" and frames[1]["text"] == "observed"
    assert frames[1]["ocr_confidence"] == .9


@pytest.mark.parametrize("endpoint", ["http://example.test:11434", "http://127.0.0.1.evil.test:11434",
                                     "http://user:secret@127.0.0.1:11434", "http://127.0.0.1:11434/proxy",
                                     "file:///tmp/model", "http://localhost:11434?secret=1"])
def test_vision_only_allows_literal_loopback(endpoint):
    with pytest.raises(worker.MediaError, match="ollama_loopback_required"):
        worker._ollama_endpoint(endpoint)


def install_vision_transport(monkeypatch, handler):
    client = httpx.AsyncClient

    def create(**options):
        assert options["trust_env"] is False and options["follow_redirects"] is False
        return client(transport=httpx.MockTransport(handler), **options)

    monkeypatch.setattr(httpx, "AsyncClient", create)


def test_vision_schema_bounds_and_separate_descriptions(monkeypatch):
    def handler(request):
        data = json.loads(request.content)
        assert request.url == "http://127.0.0.1:11434/api/chat"
        assert data["think"] is False and data["stream"] is False
        assert data["format"]["additionalProperties"] is False
        assert data["options"]["num_thread"] == 2
        assert data["options"]["num_predict"] <= 256
        assert data["messages"][0]["images"] == ["jpeg"]
        return httpx.Response(200, json={"done": True, "message": {
            "content": json.dumps({"observations": ["A blue square."]})}})

    install_vision_transport(monkeypatch, handler)
    frame = {"thumbnail": "jpeg", "text": "OCR only", "observations": []}
    state = worker._vision(frame, "http://127.0.0.1:11434/api/chat", "test", time.monotonic() + 10)
    assert state["status"] == "completed"
    assert frame["text"] == "OCR only" and frame["observations"] == ["A blue square."]


@pytest.mark.parametrize("content", [{"observations": [], "risk_score": 100},
                                    {"observations": ['The words "guaranteed profit" appear.']},
                                    {"observations": ["x" * 241]}, {"observations": "not an array"}])
def test_vision_rejects_quotes_and_unexpected_fields(monkeypatch, content):
    install_vision_transport(monkeypatch, lambda request: httpx.Response(200, json={
        "done": True, "message": {"content": json.dumps(content)}}))
    frame = {"thumbnail": "jpeg", "text": "", "observations": []}
    state = worker._vision(frame, "http://127.0.0.1:11434/api/chat", "test", time.monotonic() + 10)
    assert state["status"] == "unavailable" and frame["observations"] == []
    assert frame["text"] == ""


def test_vision_has_wall_clock_timeout(monkeypatch):
    async def slow(*args):
        await asyncio.sleep(10)

    monkeypatch.setattr(worker, "_vision_request", slow)
    monkeypatch.setattr(worker, "VISION_SECONDS", .02)
    started = time.monotonic()
    state = worker._vision({"thumbnail": "jpeg"}, "unused", "test", started + 10)
    assert state["reason"] == "vision_timeout" and time.monotonic() - started < 1


def test_child_timeout_and_output_limit():
    with pytest.raises(worker.MediaError, match="ocr_timeout"):
        worker._bounded_child([sys.executable, "-c", "import time; time.sleep(10)"], b"{}", .1)
    with pytest.raises(worker.MediaError, match="ocr_output_limit"):
        worker._bounded_child([sys.executable, "-c", "import sys; sys.stdout.write('x'*100000)"], b"{}", 5)


@pytest.mark.parametrize("payload", [b"not-json", b"[]", b"{" + b"x" * 20000])
def test_cli_always_emits_single_safe_json(payload):
    process = subprocess.run([sys.executable, "-m", "safenet.media_worker"], input=payload,
                             stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                             cwd=Path(__file__).resolve().parents[1], timeout=20)
    assert process.returncode == 0 and process.stderr == b""
    assert process.stdout.count(b"\n") == 1
    result = json.loads(process.stdout)
    assert result["status"] == "unavailable"
    assert set(result) == {"status", "duration_seconds", "analyzed_seconds", "truncated",
                           "has_audio", "has_video", "has_image", "transcript", "frames", "audio", "visual", "limitations"}


def checkpoint_request(clip, **options):
    return {"path": str(clip), "media_root": str(clip.parent),
            "checkpoint_path": str(clip.parent / worker.CHECKPOINT_NAME), **options}


def test_checkpoint_updates_after_audio_ocr_and_each_vision_frame(clip, offline_inference, monkeypatch):
    path = clip.parent / worker.CHECKPOINT_NAME
    vision_calls = []

    def ocr(frames, script, deadline):
        snapshot = json.loads(path.read_text())
        assert snapshot["status"] == "partial" and worker.INTERRUPTED in snapshot["limitations"]
        assert snapshot["audio"]["status"] == "completed" and snapshot["transcript"]
        assert snapshot["frames"] == []
        for frame in frames:
            frame["text"], frame["ocr_confidence"] = "Observed text", .9
        return worker._state("completed", model="test-ocr")

    def vision(frame, *args):
        snapshot = json.loads(path.read_text())
        assert snapshot["status"] == "partial" and worker.INTERRUPTED in snapshot["limitations"]
        assert snapshot["visual"]["status"] == "partial"
        assert all(f["text"] == "Observed text" and f["ocr_confidence"] == .9 for f in snapshot["frames"])
        assert all("_ocr_image" not in f and f["thumbnail"] for f in snapshot["frames"])
        assert sum(f["visual_status"] == "completed" for f in snapshot["frames"]) == len(vision_calls)
        if vision_calls:
            assert snapshot["frames"][len(vision_calls) - 1]["observations"] == ["A rectangle."]
        vision_calls.append(frame["at"])
        frame["observations"] = ["A rectangle."]
        return worker._state("completed", model="test-vision")

    monkeypatch.setattr(worker, "_ocr", ocr)
    monkeypatch.setattr(worker, "_vision", vision)
    result = worker.process(checkpoint_request(clip))
    assert result["status"] == "completed", result
    assert len(vision_calls) == 6
    assert json.loads(path.read_text()) == result
    assert worker.INTERRUPTED not in result["limitations"]
    assert not list(clip.parent.glob(".worker-checkpoint-*.tmp"))


def test_checkpoint_speech_hook_persists_only_accepted_segments(clip, stub_model, monkeypatch):
    model_path, _, segments = stub_model
    segments.extend([segment("accepted"), segment("rejected", no_speech_prob=.99),
                     segment("accepted too", start=1, end=2)])
    snapshots = []
    original = worker._Checkpoint.write

    def capture(checkpoint, result, **options):
        original(checkpoint, result, **options)
        snapshots.append(json.loads(checkpoint.path.read_text()))

    monkeypatch.setattr(worker._Checkpoint, "write", capture)
    monkeypatch.setattr(worker, "_ocr", lambda *args: worker._state("completed"))
    result = worker.process(checkpoint_request(clip, whisper_model=str(model_path), vision_model=""))
    assert result["status"] == "completed"
    speech = [s for s in snapshots if s["audio"]["reason"] == worker.INTERRUPTED]
    assert [len(s["transcript"]) for s in speech] == [1, 2]
    assert [s["analyzed_seconds"] for s in speech] == [.9, 2]
    assert all(s["status"] == "partial" and worker.INTERRUPTED in s["limitations"] for s in speech)
    assert all("rejected" not in json.dumps(s) for s in snapshots)


@pytest.mark.parametrize("target", ["outside", "nested", "wrong_name", "url", "no_root", "wrong_input_parent"])
def test_checkpoint_never_writes_outside_direct_media_directory(clip, monkeypatch, target):
    request = checkpoint_request(clip)
    root = clip.parent
    if target == "outside":
        request["checkpoint_path"] = str(root.parent / worker.CHECKPOINT_NAME)
    elif target == "nested":
        (root / "nested").mkdir()
        request["checkpoint_path"] = str(root / "nested" / worker.CHECKPOINT_NAME)
    elif target == "wrong_name":
        request["checkpoint_path"] = str(root / "other.json")
    elif target == "url":
        request["checkpoint_path"] = "file:///tmp/worker-checkpoint.json"
    elif target == "no_root":
        request.pop("media_root")
    else:
        request["media_root"] = str(root.parent)
    monkeypatch.setattr(worker, "_open_media", lambda *a: pytest.fail("invalid checkpoint reached decoding"))
    monkeypatch.setattr(worker.tempfile, "mkstemp", lambda *a, **kw: pytest.fail("invalid checkpoint created a file"))
    result = worker.process(request)
    assert result["status"] == "unavailable"
    assert result["limitations"] == ["invalid_checkpoint_path"]


def test_checkpoint_rejects_leaf_symlink(clip):
    outside = clip.parent / "outside.json"
    outside.write_text("unchanged")
    target = clip.parent / worker.CHECKPOINT_NAME
    try:
        target.symlink_to(outside)
    except OSError:
        pytest.skip("Symlink creation unavailable on this Windows account")
    result = worker.process(checkpoint_request(clip))
    assert "invalid_checkpoint_path" in result["limitations"]
    assert outside.read_text() == "unchanged"


def test_checkpoint_size_limit_and_replace_failure_preserve_last_valid_json(clip, monkeypatch):
    checkpoint = worker._Checkpoint(checkpoint_request(clip), clip.resolve())
    result = worker._result()
    checkpoint.write(result)
    original = checkpoint.path.read_bytes()
    with monkeypatch.context() as patch:
        patch.setattr(worker, "MAX_CHECKPOINT_BYTES", 128)
        with pytest.raises(worker.MediaError, match="checkpoint_output_limit"):
            checkpoint.write(result)
    assert checkpoint.path.read_bytes() == original
    assert not list(clip.parent.glob(".worker-checkpoint-*.tmp"))

    def deny_replace(source, destination):
        assert Path(source).parent == checkpoint.path.parent
        assert Path(destination) == checkpoint.path
        assert json.loads(Path(source).read_text())["status"] == "partial"
        assert checkpoint.path.read_bytes() == original
        raise PermissionError("sensitive path must not escape")

    monkeypatch.setattr(worker.os, "replace", deny_replace)
    with pytest.raises(PermissionError):
        checkpoint.write(result)
    assert checkpoint.path.read_bytes() == original
    assert not list(clip.parent.glob(".worker-checkpoint-*.tmp"))


def test_checkpoint_failure_does_not_abort_successful_analysis(clip, offline_inference, monkeypatch):
    def fail(*args, **kwargs):
        raise PermissionError("secret path")

    monkeypatch.setattr(worker._Checkpoint, "write", fail)
    result = worker.process(checkpoint_request(clip, vision_model=""))
    assert result["status"] == "completed" and result["transcript"]
    assert result["limitations"].count("checkpoint_write_failed") == 1
    assert "secret" not in json.dumps(result)


def test_checkpoint_is_optional_and_finished_truncation_is_not_interruption(clip, offline_inference, monkeypatch):
    path = clip.parent / worker.CHECKPOINT_NAME
    result = worker.process({"path": str(clip), "vision_model": ""})
    assert result["status"] == "completed" and not path.exists()
    checkpoint = worker._Checkpoint(checkpoint_request(clip), clip.resolve())
    result.update(status="partial", truncated=True)
    checkpoint.write(result, finished=True)
    snapshot = json.loads(path.read_text())
    assert snapshot["status"] == "partial" and snapshot["truncated"]
    assert worker.INTERRUPTED not in snapshot["limitations"]


def test_hard_killed_worker_leaves_readable_partial_speech_checkpoint(clip, stub_model, tmp_path):
    model_path, _, _ = stub_model
    # A real worker subprocess, PyAV and JSON protocol; only model inference is
    # replaced. It blocks between segments, reproducing native inference stalls.
    code = """
import sys, time
from types import SimpleNamespace
from safenet import media_worker
class Model:
    def __init__(self, *args, **kwargs): pass
    def transcribe(self, *args, **kwargs):
        def segments():
            yield SimpleNamespace(text='Recovered speech', start=.1, end=.9, no_speech_prob=.1, avg_logprob=-.2)
            time.sleep(60)
        return segments(), SimpleNamespace(language='en')
sys.modules['faster_whisper'] = SimpleNamespace(WhisperModel=Model)
media_worker.main()
"""
    request = checkpoint_request(clip, whisper_model=str(model_path), vision_model="")
    path = Path(request["checkpoint_path"])
    environment = {**os.environ, "TMP": str(tmp_path), "TEMP": str(tmp_path), "TMPDIR": str(tmp_path)}
    process = subprocess.Popen([sys.executable, "-B", "-c", code], stdin=subprocess.PIPE,
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=environment,
                               cwd=Path(__file__).resolve().parents[1],
                               creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    snapshot = None
    try:
        process.stdin.write(json.dumps(request).encode())
        process.stdin.close()
        deadline = time.monotonic() + 25
        while time.monotonic() < deadline and process.poll() is None:
            if path.exists():
                # Every visible checkpoint must already be a complete JSON file.
                current = json.loads(path.read_text())
                if current["transcript"]:
                    snapshot = current
                    break
            time.sleep(.02)
        assert snapshot is not None, "No segment checkpoint before the bounded wait expired"
    finally:
        if process.poll() is None:
            process.kill()
        process.wait(timeout=10)
        output, errors = process.stdout.read(), process.stderr.read()
        process.stdout.close()
        process.stderr.close()
    assert output == b"" and errors == b""
    assert snapshot == json.loads(path.read_text())
    assert snapshot["status"] == "partial" and worker.INTERRUPTED in snapshot["limitations"]
    assert snapshot["audio"]["status"] == "partial"
    assert snapshot["transcript"][0]["text"] == "Recovered speech"
    assert snapshot["analyzed_seconds"] == .9
    assert path.stat().st_size <= worker.MAX_CHECKPOINT_BYTES


@pytest.mark.parametrize("fmt", ["JPEG", "PNG", "WEBP"])
def test_still_image_signature_decode_ocr_and_no_fake_timeline(tmp_path, monkeypatch, fmt):
    from PIL import Image
    path = tmp_path / "input.bin"
    image = Image.new("RGB", (960, 600), "white")
    if fmt == "JPEG":
        exif = Image.Exif(); exif[274] = 6
        image.save(path, format=fmt, exif=exif)
    else:
        image.save(path, format=fmt)
    def ocr(frames, script, deadline):
        assert len(frames) == 1
        with Image.open(io.BytesIO(base64.b64decode(frames[0]["_ocr_image"]))) as decoded:
            assert decoded.format == "JPEG" and max(decoded.size) <= 1024
            assert not decoded.getexif()
            if fmt == "JPEG":
                assert decoded.height > decoded.width  # EXIF rotation applied, not copied.
        frames[0].update(text="Recognized screenshot text", ocr_confidence=.9)
        return worker._state("completed", model="test OCR")
    monkeypatch.setattr(worker, "_ocr", ocr)
    monkeypatch.setattr(worker, "_open_media", lambda *a: pytest.fail("Still images must not enter libav"))
    monkeypatch.setattr(worker, "_transcribe", lambda *a: pytest.fail("Images have no audio"))
    monkeypatch.setattr(worker, "_vision", lambda *a: pytest.fail("Vision explicitly disabled"))
    result = worker.process({"path": str(path), "vision_model": None})
    assert result["status"] == "completed" and result["has_image"]
    assert result["has_video"] is False and result["has_audio"] is False
    assert result["duration_seconds"] is None and result["analyzed_seconds"] == 0
    assert len(result["frames"]) == 1 and result["frames"][0]["text"] == "Recognized screenshot text"
    assert "_ocr_image" not in result["frames"][0]
    assert "container_duration_unavailable" not in result["limitations"]
    assert "visual_analysis_samples_at_most_six_frames" not in result["limitations"]


@pytest.mark.parametrize("fmt", ["PNG", "WEBP"])
def test_animated_image_rejected_before_inference(tmp_path, monkeypatch, fmt):
    from PIL import Image
    path = tmp_path / "input.bin"
    Image.new("RGB", (20, 20), "red").save(path, format=fmt, save_all=True,
        append_images=[Image.new("RGB", (20, 20), "blue")], duration=100, loop=0)
    monkeypatch.setattr(worker, "_ocr", lambda *a: pytest.fail("Animated images are unsupported"))
    result = worker.process({"path": str(path), "vision_model": None})
    assert result["status"] == "unavailable" and not result["frames"]
    assert "animated_image_not_supported" in result["limitations"]


def test_image_pixel_limit_precedes_decode(tmp_path, monkeypatch):
    from PIL import Image
    path = tmp_path / "input.bin"
    Image.new("RGB", (10, 10)).save(path, format="PNG")
    monkeypatch.setattr(worker, "MAX_PIXELS", 99)
    result = worker.process({"path": str(path), "vision_model": None})
    assert result["status"] == "unavailable" and not result["frames"]
    assert "decoded_pixel_limit" in result["limitations"]


def test_corrupt_image_is_unavailable_not_successful_empty(tmp_path):
    path = tmp_path / "input.bin"
    path.write_bytes(b"\x89PNG\r\n\x1a\n" + b"not an image")
    result = worker.process({"path": str(path), "vision_model": None})
    assert result["status"] == "unavailable" and not result["frames"]
    assert "image_decode_failed" in result["limitations"]


def test_image_failed_ocr_never_claims_visual_processing(tmp_path, monkeypatch):
    from PIL import Image
    path = tmp_path / "input.bin"
    Image.new("RGBA", (20, 20), (0, 0, 0, 0)).save(path, format="PNG")
    monkeypatch.setattr(worker, "_ocr", lambda *a: worker._state(reason="ocr_unavailable"))
    result = worker.process({"path": str(path), "vision_model": None})
    assert result["status"] != "completed"
    assert result["visual"]["status"] == "unavailable"
    assert result["frames"][0]["text"] == ""
    from PIL import Image
    with Image.open(io.BytesIO(base64.b64decode(result["frames"][0]["thumbnail"]))) as decoded:
        assert decoded.getpixel((0, 0)) == (255, 255, 255)

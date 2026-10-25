"""Local, memory-only audio transcription. JSON lines in/out; never downloads models."""
import base64
import importlib.util
import io
import json
import os
import sys
from pathlib import Path

os.environ["HF_HUB_OFFLINE"] = "1"
os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"
os.environ["OPENCV_IO_MAX_IMAGE_PIXELS"] = "6000000"
MODEL_PATH = Path(sys.argv[1]).resolve()
MODEL_FILES = ("model.bin", "config.json", "tokenizer.json", "vocabulary.txt")
model = None


def status():
    missing = [name for name in ("faster_whisper", "av", "numpy", "ctranslate2")
               if importlib.util.find_spec(name) is None]
    files = all((MODEL_PATH / name).is_file() for name in MODEL_FILES)
    reason = "dependency_unavailable" if missing else "model_missing" if not files else None
    return {"available": reason is None, "ready": reason is None, "loaded": model is not None,
            "reason": reason, "model": "small", "device": "cpu", "languages": ["ru", "kk", "en"],
            "qr": {"available": importlib.util.find_spec("cv2") is not None,
                   "engine": "OpenCV", "scope": "sampled_frame"}}


def decode_qr(message):
    """Decode QR contents in memory. A QR link is data and is never opened here."""
    if importlib.util.find_spec("cv2") is None:
        raise ValueError("qr_unavailable")
    import cv2
    import numpy as np
    cv2.setNumThreads(2)
    raw = base64.b64decode(message["data"], validate=True)
    if not raw or len(raw) > 1.5 * 1024 * 1024:
        raise ValueError("invalid_media")
    image = cv2.imdecode(np.frombuffer(raw, dtype=np.uint8), cv2.IMREAD_COLOR)
    if image is None or image.shape[0] * image.shape[1] > 6000000:
        raise ValueError("invalid_media")
    detector = cv2.QRCodeDetector()
    ok, values, corners, _ = detector.detectAndDecodeMulti(image)
    if not ok:
        value, points, _ = detector.detectAndDecode(image)
        values = [value] if value else []
        corners = points if value else None
    codes, seen = [], set()
    for index, value in enumerate(values[:8]):
        if not value or value in seen or len(value) > 2048:
            continue
        seen.add(value)
        item = {"text": value, "format": "QR_CODE"}
        if corners is not None:
            item["corners"] = corners[index].round(1).tolist()
        codes.append(item)
    return {"qr": codes, "available": True}


def audio_samples(raw):
    import av
    import numpy as np
    chunks, count = [], 0
    with av.open(io.BytesIO(raw)) as container:
        streams = [stream for stream in container.streams if stream.type == "audio"]
        if not streams:
            raise ValueError("no_audio_track")
        resampler = av.AudioResampler(format="s16", layout="mono", rate=16000)
        for frame in container.decode(streams[0]):
            for resampled in resampler.resample(frame):
                values = resampled.to_ndarray().flatten()
                count += values.size
                if count > 35 * 16000:
                    raise ValueError("audio_too_long")
                chunks.append(values)
        for resampled in resampler.resample(None):
            values = resampled.to_ndarray().flatten()
            count += values.size
            if count > 35 * 16000:
                raise ValueError("audio_too_long")
            chunks.append(values)
    if not chunks:
        raise ValueError("no_audio_track")
    return np.concatenate(chunks).astype(np.float32) / 32768.0


def transcribe(message):
    global model
    state = status()
    if not state["available"]:
        raise ValueError(state["reason"])
    raw = base64.b64decode(message["data"], validate=True)
    if not raw or len(raw) > 2 * 1024 * 1024:
        raise ValueError("invalid_media")
    samples = audio_samples(raw)
    if model is None:
        from faster_whisper import WhisperModel
        model = WhisperModel(str(MODEL_PATH), device="cpu", compute_type="int8",
                             cpu_threads=min(4, os.cpu_count() or 2), num_workers=1,
                             local_files_only=True)
    segments, info = model.transcribe(samples, beam_size=3, vad_filter=True,
                                      condition_on_previous_text=False,
                                      vad_parameters={"min_silence_duration_ms": 500})
    accepted = []
    for segment in segments:
        text = segment.text.strip()
        # Do not turn music/silence or low-probability hallucinations into evidence.
        if text and segment.no_speech_prob < 0.6 and segment.avg_logprob > -1.0:
            accepted.append({"text": text, "startMs": round(segment.start * 1000),
                             "endMs": round(segment.end * 1000)})
    return {"text": " ".join(item["text"] for item in accepted)[:10000],
            "segments": accepted, "language": info.language,
            "languageProbability": round(info.language_probability, 3)}


def emit(value):
    print(json.dumps(value, ensure_ascii=True), flush=True)


emit({"type": "ready", "status": status()})
for line in sys.stdin:
    message = None
    try:
        if len(line) > 3 * 1024 * 1024:
            raise ValueError("invalid_media")
        message = json.loads(line)
        if message.get("type") == "status":
            result = {"status": status()}
        elif message.get("type") == "transcribe":
            result = transcribe(message)
        elif message.get("type") == "decode_qr":
            result = decode_qr(message)
        else:
            raise ValueError("invalid_request")
        emit({"id": message.get("id"), "ok": True, **result})
    except Exception as error:
        # Do not print media, local paths or transcript fragments in process logs.
        known = {"dependency_unavailable", "model_missing", "invalid_media", "no_audio_track",
                 "audio_too_long", "invalid_request", "qr_unavailable"}
        code = str(error) if str(error) in known else "audio_failed"
        emit({"id": message.get("id") if isinstance(message, dict) else None,
              "ok": False, "code": code})
    finally:
        message = None
        line = None

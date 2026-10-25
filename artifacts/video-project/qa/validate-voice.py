"""Offline ASR quality check for the generated narration; no API uploads."""
import json
import os
import time
from pathlib import Path

os.environ['HF_HUB_OFFLINE'] = '1'
os.environ['HF_HUB_DISABLE_TELEMETRY'] = '1'
from faster_whisper import WhisperModel
import av

PROJECT = Path(__file__).resolve().parents[1]
ROOT = PROJECT.parents[1]
audio = PROJECT / 'assets' / 'voice-kk.mp3'
with av.open(str(audio)) as container:
    duration = container.duration / av.time_base
started = time.monotonic()
model = WhisperModel(str(ROOT / 'data/models/faster-whisper-small'), device='cpu',
                     compute_type='int8', cpu_threads=4, local_files_only=True)
segments, info = model.transcribe(str(audio), language='kk', task='transcribe',
                                 beam_size=5, word_timestamps=True,
                                 condition_on_previous_text=False, vad_filter=True)
items = []
for segment in segments:
    items.append({'start': segment.start, 'end': segment.end, 'text': segment.text.strip(),
                  'avg_logprob': segment.avg_logprob, 'no_speech_prob': segment.no_speech_prob,
                  'words': [{'start': word.start, 'end': word.end, 'word': word.word,
                             'probability': word.probability} for word in (segment.words or [])]})
result = {'source': 'assets/voice-kk.mp3', 'engine': 'faster-whisper 1.2.1', 'model': 'small',
          'device': 'cpu', 'compute_type': 'int8', 'language': 'kk', 'word_timestamps': True,
          'initial_prompt': None, 'duration': duration, 'elapsed_seconds': round(time.monotonic()-started, 2),
          'text': ' '.join(item['text'] for item in items), 'segments': items}
(PROJECT / 'qa' / 'voice-kk-asr.json').write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
print(json.dumps({key: value for key, value in result.items() if key != 'segments'}, ensure_ascii=True))

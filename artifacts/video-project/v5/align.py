"""Align the ElevenLabs voiceover with the scene texts.

faster-whisper gives word timestamps; each scene's narration is matched to the transcript by its word count,
so the cut points fall in the pauses between paragraphs. Writes voice/<name>.align.json.
Usage:  python align.py voice/gen1.mp3
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

from faster_whisper import WhisperModel

ROOT = Path(__file__).resolve().parent


def words_of(text: str) -> list[str]:
    return re.findall(r"[\w-]+", text.lower())


def main(audio: Path) -> None:
    scenes = json.loads((ROOT / 'scenes.json').read_text(encoding='utf-8'))['scenes']
    model = WhisperModel('small', device='cpu', compute_type='int8')
    segments, info = model.transcribe(str(audio), language='ru', word_timestamps=True, vad_filter=False, beam_size=5)
    words = [{'w': w.word.strip(), 's': round(w.start, 3), 'e': round(w.end, 3)} for seg in segments for w in seg.words]

    # Scene boundaries: walk the transcript, giving each scene as many words as its script has,
    # then snap the boundary to the largest gap within ±4 words (the paragraph pause).
    bounds, cursor = [], 0
    for index, scene in enumerate(scenes):
        count = len(words_of(scene['text']))
        end = min(len(words) - 1, cursor + count - 1)
        if index < len(scenes) - 1:
            window = range(max(cursor, end - 4), min(len(words) - 1, end + 4))
            end = max(window, key=lambda i: words[i + 1]['s'] - words[i]['e'])
        else:
            end = len(words) - 1
        bounds.append({'id': scene['id'], 'start': words[cursor]['s'], 'end': words[end]['e'],
                       'heard': ' '.join(w['w'] for w in words[cursor:end + 1])})
        cursor = end + 1
    out = {'audio': audio.name, 'duration': info.duration, 'scenes': bounds, 'words': words}
    target = audio.with_suffix('.align.json')
    target.write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding='utf-8')
    for b in bounds:
        print(f"{b['id']:10s} {b['start']:7.2f} – {b['end']:7.2f}  {b['heard'][:90]}")
    print('transcript words:', len(words), 'script words:', sum(len(words_of(s['text'])) for s in scenes))


if __name__ == '__main__':
    main(Path(sys.argv[1]).resolve())

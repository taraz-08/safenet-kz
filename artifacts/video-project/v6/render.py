"""SafeNet v6: supplied UI media + narration, streamed with PyAV/Pillow.

python render.py --preview       # contact sheet, SRT, metadata; no audio required
python render.py                 # complete 1080p30 H.264/AAC; validates every scene
See render-README.md for the input contract. Never captures or generates media.
"""
from __future__ import annotations

import argparse
import bisect
import hashlib
import json
import math
import re
from datetime import datetime, timezone
from fractions import Fraction
from functools import lru_cache
from pathlib import Path

import av
import numpy as np
from PIL import Image, ImageDraw, ImageFont, ImageOps

ROOT = Path(__file__).resolve().parent
W, H, FPS, RATE = 1920, 1080, 30, 48000
INK, TEAL, PAPER, MUTED = '#102f34', '#087e78', '#f3f7f5', '#58706f'
LEAD, TAIL = .35, .65
FONT_PATH = None
FONT_BOLD = None


def read_json(path):
    return json.loads(path.read_text(encoding='utf-8-sig'))


def asset(root, value):
    path = Path(value)
    return path.resolve() if path.is_absolute() else (root / path).resolve()


def configure_fonts(regular=None, bold=None):
    global FONT_PATH, FONT_BOLD
    candidates = [Path(regular)] if regular else [
        Path('C:/Windows/Fonts/segoeui.ttf'),
        Path('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'),
        Path('/System/Library/Fonts/Supplemental/Arial.ttf'),
    ]
    FONT_PATH = next((p for p in candidates if p.is_file()), None)
    if not FONT_PATH:
        raise ValueError('No Cyrillic font found. Supply --font /path/to/font.ttf.')
    guesses = [Path(bold)] if bold else [FONT_PATH.with_name('segoeuib.ttf'),
               FONT_PATH.with_name('DejaVuSans-Bold.ttf'), FONT_PATH]
    FONT_BOLD = next((p for p in guesses if p.is_file()), FONT_PATH)


@lru_cache(maxsize=32)
def font(size, bold=False):
    return ImageFont.truetype(str(FONT_BOLD if bold else FONT_PATH), size)


def wrap(text, face, width):
    draw = ImageDraw.Draw(Image.new('RGB', (1, 1)))
    lines, line = [], ''
    for word in text.split():
        # Split an oversized URL/word too, rather than drawing beyond the frame.
        pieces = []
        while word and draw.textlength(word, font=face) > width:
            n = max(1, int(len(word) * width / draw.textlength(word, font=face)))
            while n > 1 and draw.textlength(word[:n], font=face) > width:
                n -= 1
            pieces.append(word[:n])
            word = word[n:]
        pieces += [word] if word else []
        for piece in pieces:
            trial = (line + ' ' + piece).strip()
            if line and draw.textlength(trial, font=face) > width:
                lines.append(line)
                line = piece
            else:
                line = trial
    return lines + ([line] if line else [])


def fitted(text, width, size=48, minimum=26, rows=2):
    for n in range(size, minimum - 1, -2):
        face = font(n, True)
        lines = wrap(text, face, width)
        if len(lines) <= rows:
            return face, lines
    raise ValueError(f'Text is too long for a readable {rows}-line overlay: {text[:100]}')


def audio_chunks(path, start=0.0, end=None):
    """Decode/resample in bounded chunks. Cuts refer to decoded audio, not MP3 headers."""
    lo = round(start * RATE)
    hi = round(end * RATE) if end is not None else None
    position = 0
    with av.open(str(path)) as container:
        if not container.streams.audio:
            raise ValueError(f'No audio stream: {path}')
        resampler = av.AudioResampler(format='fltp', layout='stereo', rate=RATE)
        def resampled():
            for frame in container.decode(container.streams.audio[0]):
                yield from resampler.resample(frame)
            yield from resampler.resample(None)
        for frame in resampled():
            samples = frame.to_ndarray()
            count = samples.shape[1]
            a = max(0, lo - position)
            b = min(count, hi - position) if hi is not None else count
            if b > a:
                for offset in range(a, b, 4096):
                    yield np.ascontiguousarray(samples[:, offset:min(offset + 4096, b)])
            position += count
            if hi is not None and position >= hi:
                break


def audio_info(path, start=0.0, end=None):
    count, peak = 0, 0.0
    for samples in audio_chunks(path, start, end):
        count += samples.shape[1]
        peak = max(peak, float(np.max(np.abs(samples))))
    if not count or peak < 1e-7:
        raise ValueError(f'Empty or digitally silent narration: {path.name}')
    if end is not None and count < round((end - start) * RATE) - RATE // 20:
        raise ValueError(f'Alignment extends beyond narration: {path.name}, {start}..{end}')
    return count, peak


class Clip:
    """Forward-only decoder: retain one source frame, never all frames of a video."""
    def __init__(self, path):
        self.container = av.open(str(path))
        if not self.container.streams.video:
            self.container.close()
            raise ValueError(f'No video stream: {path}')
        self.stream = self.container.streams.video[0]
        self.decoder = iter(self.container.decode(self.stream))
        self.current = None
        self.next = next(self.decoder, None)
        if self.next is None:
            self.container.close()
            raise ValueError(f'Empty video: {path}')
        self.origin = float(self.next.time or 0)
        self.last_time = 0.0
        self.index = 0
        self.exhausted = False
        self.rate = float(self.stream.average_rate or FPS)

    def frame(self, t):
        while self.next is not None:
            at = float(self.next.time) - self.origin if self.next.time is not None else self.index / self.rate
            if self.current is not None and at > t:
                break
            # Resize before conversion to RGB to bound retained large source images.
            frame = self.next
            scale = min(1, W / frame.width, H / frame.height)
            self.current = frame.reformat(width=max(2, round(frame.width * scale)),
                                          height=max(2, round(frame.height * scale)), format='rgb24').to_image()
            self.last_time = at
            self.index += 1
            self.next = next(self.decoder, None)
        self.exhausted = self.next is None and t > self.last_time + 1 / self.rate
        return self.current

    def close(self):
        self.container.close()


def choose_visual(root, scene, flow_fallback):
    role = re.split('[-_]', scene['id'].lower())[-1]
    kind = scene.get('kind', 'flow' if role in ('intro', 'outro') else 'ui')
    if kind in ('title', 'titlecard'):
        return {'kind': 'titlecard', 'paths': [], 'fallback': False}
    if kind == 'flow' or scene.get('flow'):
        explicit = scene.get('flow')
        candidates = ([asset(root, explicit)] if isinstance(explicit, str) else [])
        candidates += [root / 'flow' / f"{scene['id']}.mp4", root / 'flow' / f'{role}.mp4']
        path = next((p for p in candidates if p.is_file()), None)
        fallback = False
        if not path and flow_fallback and role in ('intro', 'outro'):
            path = root.parent / 'v5' / 'flow' / ('intro-a.mp4' if role == 'intro' else 'intro-b.mp4')
            fallback = path.is_file()
        return {'kind': 'flow', 'paths': [path] if path and path.is_file() else [], 'fallback': fallback}
    clip = asset(root, scene['clip']) if scene.get('clip') else root / 'clips' / f"{scene['id']}.mp4"
    if clip.is_file():
        return {'kind': 'clip', 'paths': [clip], 'fallback': False}
    if scene.get('shots'):
        values = scene['shots'] if isinstance(scene['shots'], list) else [scene['shots']]
        paths = [asset(root, value) for value in values]
        absent = [str(p) for p in paths if not p.is_file()]
        if absent:
            raise ValueError('Explicit screenshots missing: ' + ', '.join(absent))
    else:
        paths = sorted(p for p in (root / 'shots').glob(f"{scene['id']}*")
                       if p.suffix.lower() in ('.png', '.jpg', '.jpeg', '.webp') and p.is_file())
    return {'kind': 'shots', 'paths': paths, 'fallback': False}


def subtitle_parts(text):
    parts = []
    for sentence in re.split(r'(?<=[.!?…])\s+', text.strip()):
        part = ''
        for word in sentence.split():
            if part and len(part) + len(word) + 1 > 84:
                parts.append(part)
                part = word
            else:
                part = (part + ' ' + word).strip()
        if part:
            parts.append(part)
    return parts


def normalized_words(data):
    words = data.get('words', []) if isinstance(data, dict) else []
    result = []
    for word in words:
        start, end = word.get('start', word.get('s')), word.get('end', word.get('e'))
        if start is not None and end is not None and float(end) > float(start):
            result.append({'start': float(start), 'end': float(end)})
    return sorted(result, key=lambda w: w['start'])


def scene_cues(scene, voice_duration, words):
    parts = subtitle_parts(scene['text'])
    weights = [max(1, len(p.split())) for p in parts]
    total, done, cues = sum(weights), 0, []
    for part, weight in zip(parts, weights):
        if words:
            a = min(len(words) - 1, int(done / total * len(words)))
            b = max(a, min(len(words) - 1, math.ceil((done + weight) / total * len(words)) - 1))
            start, end = words[a]['start'], words[b]['end']
        else:
            start, end = voice_duration * done / total, voice_duration * (done + weight) / total
        done += weight
        start, end = max(0, start), min(voice_duration, end)
        if end > start:
            cues.append({'start': LEAD + start, 'end': LEAD + end, 'text': part})
    for current, following in zip(cues, cues[1:]):
        current['end'] = min(current['end'], following['start'])
    return [c for c in cues if c['end'] > c['start']]


def plan(args):
    document = read_json(args.scenes)
    scenes = document.get('scenes') if isinstance(document, dict) else document
    if not isinstance(scenes, list) or not scenes:
        raise ValueError('scenes.json must be a nonempty array, or an object containing scenes: [...].')
    ids = set()
    alignment = read_json(args.alignment) if args.alignment else {}
    marks = alignment.get('scenes', []) if isinstance(alignment, dict) else alignment
    marks = {m['id']: m for m in marks}
    global_words = normalized_words(alignment)
    if bool(args.full_voice) != bool(args.alignment):
        raise ValueError('Use --full-voice and --alignment together.')
    timeline, missing, offset = [], [], 0
    for scene in scenes:
        if not isinstance(scene, dict) or not all(isinstance(scene.get(k), str) and scene[k].strip() for k in ('id', 'title', 'text')):
            raise ValueError('Each scene needs nonempty string id, title and text.')
        sid = scene['id']
        if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_-]{0,79}', sid) or sid in ids:
            raise ValueError(f'Invalid or duplicate scene id: {sid}')
        ids.add(sid)
        if args.scene and sid not in args.scene:
            continue
        visual = choose_visual(args.root, scene, not args.no_flow_fallback)
        if not visual['paths'] and visual['kind'] != 'titlecard':
            missing.append(f'{sid}: no screenshots/clip (expected shots/{sid}* or clips/{sid}.mp4; Flow uses flow/)')
        candidates = [asset(args.root, scene['audio'])] if scene.get('audio') else [
            args.root / folder / f'{sid}{ext}' for folder in ('inputvoice', 'voice') for ext in ('.mp3', '.wav', '.m4a')]
        audio_path = next((p for p in candidates if p.is_file()), None)
        start, end, words, samples, peak = 0.0, None, [], 0, None
        if audio_path:
            sidecar = audio_path.with_suffix('.align.json')
            if sidecar.is_file():
                words = normalized_words(read_json(sidecar))
        elif args.full_voice and sid in marks:
            audio_path = args.full_voice
            start, end = float(marks[sid]['start']), float(marks[sid]['end'])
            if not math.isfinite(start) or not math.isfinite(end) or not 0 <= start < end:
                raise ValueError(f'Invalid full-voice bounds for {sid}.')
            words = [{'start': max(0, w['start'] - start), 'end': min(end, w['end']) - start}
                     for w in global_words if start <= w['start'] < end]
        if audio_path:
            samples, peak = audio_info(audio_path, start, end)
            voice_duration = samples / RATE
        else:
            missing.append(f'{sid}: no narration (expected inputvoice/{sid}.mp3 or aligned full voice)')
            pace = document.get('voiceDirection', {}).get('targetWordsPerMinute', 150) if isinstance(document, dict) else 150
            voice_duration = max(2.5, len(scene['text'].split()) * 60 / float(pace))
        minimum = float(scene.get('duration', scene.get('durationSec', 0)))
        if not math.isfinite(minimum) or minimum < 0:
            raise ValueError(f'Invalid minimum duration for {sid}.')
        pause_after = float(scene.get('pauseAfterSec', TAIL))
        if not math.isfinite(pause_after) or pause_after < 0:
            raise ValueError(f'Invalid pauseAfterSec for {sid}.')
        count = math.ceil(max(minimum, LEAD + voice_duration + max(TAIL, pause_after)) * FPS)
        item = {'scene': scene, 'visual': visual, 'audio': audio_path, 'audioStart': start,
                'audioEnd': end, 'audioSamples': samples, 'audioPeak': peak,
                'frames': count, 'startFrame': offset, 'duration': count / FPS,
                'cues': scene_cues(scene, voice_duration, words),
                'subtitleTiming': 'word-timestamp distribution (review)' if words else 'estimated by script word count (review)'}
        timeline.append(item)
        offset += count
    if args.scene and set(args.scene) - ids:
        raise ValueError('Unknown --scene: ' + ', '.join(sorted(set(args.scene) - ids)))
    if not timeline:
        raise ValueError('No scenes selected.')
    if missing and not args.preview:
        raise ValueError('Full render refused; supply every required asset:\n  ' + '\n  '.join(missing))
    return timeline, missing


class Composition:
    def __init__(self, item, index, count, args):
        self.item, self.args = item, args
        self.index, self.count = index, count
        self.clip = None
        self.shot = None
        self.shot_index = None
        visual = item['visual']
        if visual['paths'] and visual['kind'] in ('clip', 'flow'):
            self.clip = Clip(visual['paths'][0])

    def frame(self, t):
        item, scene, visual = self.item, self.item['scene'], self.item['visual']
        image = Image.new('RGB', (W, H), PAPER)
        draw = ImageDraw.Draw(image)
        draw.rectangle((0, 0, 12, H), fill=TEAL)
        draw.text((56, 27), 'SAFENET KZ  /  ПРЕЗЕНТАЦИЯ', font=font(24, True), fill=TEAL)
        draw.text((W - 56, 27), f'{self.index + 1:02} / {self.count:02}', anchor='ra', font=font(24), fill=MUTED)
        face, rows = fitted(scene['title'], W - 112)
        for n, row in enumerate(rows):
            draw.text((56, 67 + n * (face.size + 4)), row, font=face, fill=INK)
        box = (56, 174, W - 56, 888)
        bw, bh = box[2] - box[0], box[3] - box[1]
        draw.rounded_rectangle(box, radius=16, fill='#e3eeeb', outline='#d3e3df', width=2)
        paths = visual['paths']
        label = {'shots': 'Скриншоты работающего сайта', 'clip': 'Запись работающего сайта',
                 'flow': 'Иллюстрация · Google Flow', 'titlecard': 'Титр · SafeNet KZ'}[visual['kind']]
        if self.clip:
            raw = self.clip.frame(t)
            fitted_image = ImageOps.contain(raw, (bw - 12, bh - 12), Image.Resampling.BICUBIC)
            image.paste(fitted_image, (box[0] + (bw - fitted_image.width) // 2, box[1] + (bh - fitted_image.height) // 2))
            if self.clip.exhausted and visual['kind'] == 'clip':
                label = 'Стоп-кадр записи работающего сайта'
        elif paths:
            position = min(len(paths) - 1, int(t / item['duration'] * len(paths)))
            if position != self.shot_index:
                with Image.open(paths[position]) as source:
                    self.shot = ImageOps.exif_transpose(source).convert('RGB')
                    self.shot.thumbnail((W * 2, H * 2), Image.Resampling.LANCZOS)
                self.shot_index = position
            local = (t / item['duration'] * len(paths)) % 1
            # Small movement inside the panel: preserve every screenshot edge.
            scale = .975 + .02 * (local * local * (3 - 2 * local))
            picture = ImageOps.contain(self.shot, (round((bw - 12) * scale), round((bh - 12) * scale)), Image.Resampling.BICUBIC)
            x = box[0] + round((bw - picture.width) * (.45 + .1 * local))
            y = box[1] + (bh - picture.height) // 2
            image.paste(picture, (x, y))
        elif visual['kind'] == 'titlecard':
            draw.text((W // 2, 365), 'SafeNet KZ', anchor='mt', font=font(112, True), fill=INK)
            draw.text((W // 2, 515), 'Признаки риска. Решение — за человеком.', anchor='mt', font=font(40), fill=TEAL)
        else:
            label = 'ПРЕВЬЮ · МАТЕРИАЛЫ ОТСУТСТВУЮТ'
            draw.text((W // 2, 410), 'Нет изображения для этой сцены', anchor='mt', font=font(44, True), fill=INK)
            draw.text((W // 2, 480), f"Добавьте shots/{scene['id']}* или clips/{scene['id']}.mp4", anchor='mt', font=font(27), fill=MUTED)
        draw = ImageDraw.Draw(image)
        source = str(scene.get('source', self.args.source))
        date = str(scene.get('date', scene.get('capturedAt', self.args.capture_date)))
        provenance = f'{label}  •  {date}'
        face, lines = fitted(provenance, W - 112, size=24, minimum=18, rows=1)
        draw.text((56, 900), lines[0], font=face, fill=TEAL)
        face, lines = fitted(source, W - 112, size=21, minimum=16, rows=1)
        draw.text((56, 932), lines[0], font=face, fill=MUTED)
        cue = next((c for c in item['cues'] if c['start'] <= t < c['end']), None)
        if cue:
            face, lines = fitted(cue['text'], W - 176, size=36, minimum=26, rows=2)
            draw.rounded_rectangle((48, 965, W - 48, 1061), radius=15, fill=INK)
            for n, line in enumerate(lines):
                draw.text((W // 2, 969 + n * (face.size + 6)), line, anchor='mt', font=face, fill='white')
        if self.args.preview:
            draw.rectangle((W - 460, 129, W - 56, 165), fill=INK)
            draw.text((W - 258, 131), 'ПРЕВЬЮ · НЕ ФИНАЛЬНЫЙ РОЛИК', anchor='mt', font=font(19, True), fill='white')
        draw.rectangle((0, H - 5, round(W * (self.index + t / item['duration']) / self.count), H), fill=TEAL)
        return image

    def close(self):
        if self.clip:
            self.clip.close()


def silence(count):
    while count > 0:
        n = min(4096, count)
        yield np.zeros((2, n), dtype=np.float32)
        count -= n


def soundtrack(timeline):
    for item in timeline:
        total = item['frames'] * RATE // FPS
        lead = round(LEAD * RATE)
        yield from silence(lead)
        received = 0
        fade = RATE // 100  # 10ms de-click, without trimming narration.
        for chunk in audio_chunks(item['audio'], item['audioStart'], item['audioEnd']):
            positions = np.arange(received, received + chunk.shape[1])
            gain = np.minimum(1, np.minimum(positions / fade, (item['audioSamples'] - 1 - positions) / fade))
            received += chunk.shape[1]
            yield np.ascontiguousarray(np.clip(chunk * np.maximum(0, gain)[None, :] * .96, -1, 1), dtype=np.float32)
        if received != item['audioSamples']:
            raise ValueError(f"Narration changed during render: {item['scene']['id']}")
        yield from silence(total - lead - received)


def srt_text(timeline):
    def stamp(seconds):
        ms = round(seconds * 1000)
        return f'{ms // 3600000:02}:{ms // 60000 % 60:02}:{ms // 1000 % 60:02},{ms % 1000:03}'
    records = []
    for item in timeline:
        offset = item['startFrame'] / FPS
        for cue in item['cues']:
            records.append(f"{len(records) + 1}\n{stamp(offset + cue['start'])} --> {stamp(offset + cue['end'])}\n{cue['text']}")
    return '\n\n'.join(records) + '\n'


def file_info(path):
    digest = hashlib.sha256()
    with path.open('rb') as source:
        while block := source.read(1024 * 1024):
            digest.update(block)
    return {'path': str(path.resolve()), 'bytes': path.stat().st_size, 'sha256': digest.hexdigest()}


def encode(path, timeline, args):
    """One-pass incremental encode; only a scene decoder and small audio chunks live in RAM."""
    temporary = path.with_suffix('.partial.mp4')
    container = av.open(str(temporary), mode='w', options={'movflags': '+faststart'})
    video = container.add_stream('libx264', rate=FPS)
    video.width, video.height, video.pix_fmt = W, H, 'yuv420p'
    video.options = {'crf': str(args.crf), 'preset': args.preset, 'profile': 'high'}
    video.codec_context.thread_count = args.threads
    audio = container.add_stream('aac', rate=RATE)
    audio.layout, audio.bit_rate = 'stereo', 192000
    chunks = iter(soundtrack(timeline))
    pending = np.zeros((2, 0), dtype=np.float32)
    audio_position = 0
    previous_image = None
    transition_frames = round(.4 * FPS)
    try:
        for scene_index, item in enumerate(timeline):
            composition = Composition(item, scene_index, len(timeline), args)
            print(f"Scene {scene_index + 1}/{len(timeline)}: {item['scene']['id']} ({item['duration']:.2f}s)", flush=True)
            try:
                for frame_index in range(item['frames']):
                    index = item['startFrame'] + frame_index
                    picture = composition.frame(frame_index / FPS)
                    if previous_image is not None and frame_index < transition_frames:
                        progress = frame_index / max(1, transition_frames - 1)
                        smooth = progress * progress * (3 - 2 * progress)
                        picture = Image.blend(previous_image, picture, smooth)
                    frame = av.VideoFrame.from_image(picture)
                    frame.pts, frame.time_base = index, Fraction(1, FPS)
                    for packet in video.encode(frame):
                        container.mux(packet)
                    limit = (index + 1) * RATE // FPS
                    while audio_position < limit:
                        if not pending.shape[1]:
                            pending = next(chunks, None)
                            if pending is None:
                                raise ValueError('Narration ended before the planned video duration.')
                        size = min(1024, pending.shape[1], limit - audio_position)
                        af = av.AudioFrame.from_ndarray(np.ascontiguousarray(pending[:, :size]), format='fltp', layout='stereo')
                        pending = pending[:, size:]
                        af.sample_rate, af.pts, af.time_base = RATE, audio_position, Fraction(1, RATE)
                        for packet in audio.encode(af):
                            container.mux(packet)
                        audio_position += size
                    if frame_index and frame_index % (FPS * 10) == 0:
                        print(f'  {frame_index / FPS:.0f}/{item["duration"]:.0f}s', flush=True)
                previous_image = picture
            finally:
                composition.close()
        for stream in (video, audio):
            for packet in stream.encode(None):
                container.mux(packet)
    finally:
        chunks.close()
        container.close()
    temporary.replace(path)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--scenes', type=Path, default=ROOT / 'scenes.json')
    parser.add_argument('--preview', action='store_true', help='contact sheet + SRT + metadata only; missing media are explicit placeholders')
    parser.add_argument('--scene', action='append', help='render selected scene IDs in JSON order; repeat for several')
    parser.add_argument('--full-voice', type=Path)
    parser.add_argument('--alignment', type=Path, help='JSON scenes: [{id,start,end}], optional words: [{w,s,e}]')
    parser.add_argument('--output-dir', type=Path)
    parser.add_argument('--name', default='safenet-kz-jury-ru')
    parser.add_argument('--source', default='SafeNet KZ · предоставленные материалы')
    parser.add_argument('--capture-date', default='Дата съёмки не указана')
    parser.add_argument('--voice-provider', default='ElevenLabs (источник указан заказчиком)')
    parser.add_argument('--no-flow-fallback', action='store_true')
    parser.add_argument('--font')
    parser.add_argument('--font-bold')
    parser.add_argument('--crf', type=int, default=19)
    parser.add_argument('--preset', choices=['ultrafast', 'superfast', 'veryfast', 'faster', 'fast', 'medium'], default='veryfast')
    parser.add_argument('--threads', type=int, default=4)
    args = parser.parse_args()
    args.scenes = args.scenes.resolve()
    args.root = args.scenes.parent
    if not re.fullmatch(r'[A-Za-z0-9_-]+', args.name):
        parser.error('--name must contain only letters, digits, hyphens and underscores.')
    if not 0 <= args.crf <= 51 or not 1 <= args.threads <= 32:
        parser.error('--crf must be 0..51 and --threads 1..32.')
    configure_fonts(args.font, args.font_bold)
    timeline, missing = plan(args)
    # Validate image decoding / typography and make one representative frame per scene.
    # For large scene lists the sheet grows by scene count, never by video frame count.
    sheet = Image.new('RGB', (1920, math.ceil(len(timeline) / 3) * 392), PAPER)
    for i, item in enumerate(timeline):
        composition = Composition(item, i, len(timeline), args)
        try:
            thumb = composition.frame(min(item['duration'] * .45, LEAD + 5)).resize((640, 360), Image.Resampling.LANCZOS)
            x, y = i % 3 * 640, i // 3 * 392
            sheet.paste(thumb, (x, y))
            ImageDraw.Draw(sheet).text((x + 10, y + 365), item['scene']['id'], font=font(18), fill=INK)
        finally:
            composition.close()
    output = (args.output_dir or args.root / 'output').resolve()
    output.mkdir(parents=True, exist_ok=True)
    name = args.name + ('-preview' if args.preview else '')
    report = {'status': 'preview' if args.preview else 'prepared', 'createdAt': datetime.now(timezone.utc).isoformat(),
              'size': [W, H], 'fps': FPS, 'durationSeconds': sum(i['frames'] for i in timeline) / FPS,
              'videoCodec': 'h264', 'audioCodec': 'aac', 'audioRate': RATE, 'audioChannels': 2,
              'voiceProviderDeclared': args.voice_provider, 'missingAssets': missing,
              'visualPolicy': 'Supplied real UI only; no fabricated UI/cursor/actions. Flow is labelled illustration. Clip audio discarded; clips play 1x and hold final frame.',
              'subtitlePolicy': 'Script text split into cues; word timestamps are distributed when supplied, otherwise approximate. Review timing before delivery.',
              'transitionPolicy': '0.4-second smooth cross-dissolve from the prior scene final frame; continuous audio timeline with click-preventing edge fades.',
              'scenes': []}
    for item in timeline:
        scene = item['scene']
        report['scenes'].append({'id': scene['id'], 'title': scene['title'], 'start': item['startFrame'] / FPS,
                                'duration': item['duration'], 'frames': item['frames'], 'kind': item['visual']['kind'],
                                'visuals': [file_info(p) for p in item['visual']['paths']],
                                'flowV5Fallback': item['visual']['fallback'], 'source': scene.get('source', args.source),
                                'captureDateDeclared': scene.get('date', scene.get('capturedAt', args.capture_date)),
                                'audio': file_info(item['audio']) if item['audio'] else None,
                                'audioCut': [item['audioStart'], item['audioEnd']], 'audioPeak': item['audioPeak'],
                                'subtitleTiming': item['subtitleTiming']})
    (output / f'{name}.srt').write_text(srt_text(timeline), encoding='utf-8')
    sheet.save(output / f'{name}.contact-sheet.jpg', quality=93)
    metadata_path = output / f'{name}.render.json'
    metadata_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    if args.preview:
        print('Preview only. Missing assets:', len(missing))
        for warning in missing:
            print('  ' + warning)
    else:
        target = output / f'{name}.mp4'
        encode(target, timeline, args)
        report.update(status='complete', output=file_info(target))
        metadata_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
        print('Video:', target)
    print('Metadata:', metadata_path)


if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError, KeyError, TypeError) as error:
        raise SystemExit(f'Render stopped: {error}') from None

"""Render the SafeNet KZ jury video (Russian voiceover) with PyAV + Pillow.

Inputs in this folder:
  jury-scenes.json        scene order and narration script
  voice/gen1.mp3          voiceover of the whole script; voice/gen1.align.json has word timings per scene (align.py)
  frames/<scene>/         screencast of the running site (record.py)
  intro/clip.mp4          clip animated between the two keyframes intro/start.png → intro/end.png; the stills shown
                          before and after it are its own first and last frames, so still → motion → still has no seam
Usage:  python render_jury.py [--preview]
"""
from __future__ import annotations

import argparse
import bisect
import json
import math
import re
from fractions import Fraction
from functools import lru_cache
from pathlib import Path

import av
import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = Path(__file__).resolve().parent
OUT = ROOT / 'output'
W, H, FPS, RATE = 1920, 1080, 30, 48000

INK = (9, 33, 36)
TEAL = (11, 125, 116)
MINT = (156, 226, 210)
WHITE = (245, 247, 244)
MUTED = (185, 203, 199)
FONTS = {'regular': 'C:/Windows/Fonts/segoeui.ttf', 'semibold': 'C:/Windows/Fonts/seguisb.ttf',
         'bold': 'C:/Windows/Fonts/segoeuib.ttf', 'light': 'C:/Windows/Fonts/segoeuil.ttf'}

LEAD, TAIL, FADE = 0.45, 0.8, 0.5      # voice offset into a scene, pause after it, crossfade
MAX_SPEED, SKIP = 1.45, 0.6            # recordings play at most 1.45x (the rest is trimmed); skip the first frames
MIN_SECONDS = {'case': 16.5, 'check': 12.5}   # scenes that need time to show a result after the voice
PRE_INTRO = 2.2                        # seconds of the first keyframe before the clip starts
HOSTED_URL = 'safenet-kz.up.railway.app'


@lru_cache(maxsize=64)
def font(size, weight='regular'):
    return ImageFont.truetype(FONTS[weight], size)


def ease(x):
    x = min(1.0, max(0.0, x))
    return 1 - (1 - x) ** 3


def wrap(draw, text, face, width):
    rows, row = [], ''
    for word in text.split():
        candidate = f'{row} {word}'.strip()
        if row and draw.textlength(candidate, font=face) > width:
            rows.append(row)
            row = word
        else:
            row = candidate
    return rows + [row] if row else rows


def push(image, scale):
    """Centre crop scaled up by `scale` (1.0 = the image itself), for slow camera moves on stills."""
    w, h = round(W / scale), round(H / scale)
    x, y = (W - w) // 2, (H - h) // 2
    return image.crop((x, y, x + w, y + h)).resize((W, H), Image.Resampling.BICUBIC)


# ---------- audio ----------

def read_audio(path):
    chunks = []
    with av.open(str(path)) as container:
        resampler = av.AudioResampler(format='fltp', layout='stereo', rate=RATE)
        for frame in container.decode(container.streams.audio[0]):
            chunks.extend(out.to_ndarray() for out in resampler.resample(frame))
        chunks.extend(out.to_ndarray() for out in resampler.resample(None))
    return np.concatenate(chunks, axis=1).astype(np.float32)


def faded(samples, ms=25):
    n = min(samples.shape[1] // 2, RATE * ms // 1000)
    out = samples.copy()
    if n:
        out[:, :n] *= np.linspace(0, 1, n)
        out[:, -n:] *= np.linspace(1, 0, n)
    return out


# ---------- sources ----------

class Recording:
    """Screencast frames of one page; frames arrive only on change, so hold the latest one."""

    def __init__(self, name):
        self.folder = ROOT / 'frames' / name
        data = json.loads((self.folder / 'timestamps.json').read_text(encoding='utf-8'))
        t0 = data['frames'][0]['t']
        self.times = [f['t'] - t0 for f in data['frames']]
        self.files = [f['file'] for f in data['frames']]
        self.usable = self.times[-1] - SKIP
        self.speed = 1.0

    def frame(self, local):
        source = SKIP + min(local * self.speed, self.usable)
        index = max(0, bisect.bisect_right(self.times, source) - 1)
        return load_frame(str(self.folder / self.files[index]))


@lru_cache(maxsize=8)
def load_frame(path):
    image = Image.open(path).convert('RGB')
    return image if image.size == (W, H) else image.resize((W, H), Image.Resampling.LANCZOS)


class Clip:
    def __init__(self, path):
        with av.open(str(path)) as container:
            stream = container.streams.video[0]
            self.frames = [f.to_image().convert('RGB').resize((W, H), Image.Resampling.BICUBIC) for f in container.decode(stream)]
            self.fps = float(stream.average_rate)
        self.duration = len(self.frames) / self.fps

    def frame(self, t):
        return self.frames[min(len(self.frames) - 1, max(0, int(t * self.fps)))]


# ---------- timeline ----------

def build_timeline(scenes, align, voice_seconds, clip):
    marks = {s['id']: s for s in align['scenes']}
    cuts = []
    for index, scene in enumerate(scenes):
        mark = marks[scene['id']]
        start = 0.0 if index == 0 else (marks[scenes[index - 1]['id']]['end'] + mark['start']) / 2
        end = voice_seconds if index == len(scenes) - 1 else (mark['end'] + marks[scenes[index + 1]['id']]['start']) / 2
        cuts.append((start, end))
    timeline, at = [], 0.0
    for scene, (cut_start, cut_end) in zip(scenes, cuts):
        voice = cut_end - cut_start
        recording = None
        if scene['id'] == 'intro':
            duration = max(voice + LEAD + 1.4, PRE_INTRO + clip.duration + 1.5)
        elif scene['id'] == 'outro':
            duration = voice + LEAD + 3.0
        else:
            recording = Recording(scene['id'])
            duration = max(voice + LEAD + TAIL, MIN_SECONDS.get(scene['id'], 0))
            recording.speed = min(MAX_SPEED, max(1.0, recording.usable / duration))
        timeline.append({'id': scene['id'], 'scene': scene, 'start': at, 'end': at + duration,
                         'cut': (cut_start, cut_end), 'voiceAt': at + LEAD, 'clip': recording})
        at += duration
    return timeline, at


# ---------- subtitles ----------

def split_cues(text, limit=92):
    parts = []
    for sentence in re.split(r'(?<=[.!?…])\s+', text.strip()):
        pending = [sentence]
        while pending:
            piece = pending.pop(0)
            if len(piece) <= limit:
                parts.append(piece)
                continue
            middle = len(piece) / 2
            breaks = [m.end() for m in re.finditer(r'[,:;—]\s', piece)]
            cut = min(breaks, key=lambda b: abs(b - middle)) if breaks else piece.rfind(' ', 0, int(middle))
            pending[:0] = [piece[:cut].strip(), piece[cut:].strip()]
    return parts


def words_of(text):
    return re.findall(r'[\w-]+', text.lower())


def build_cues(timeline, align):
    cues = []
    for item in timeline:
        mark = next(s for s in align['scenes'] if s['id'] == item['id'])
        heard = [w for w in align['words'] if mark['start'] - 0.01 <= w['s'] <= mark['end'] + 0.01]
        parts = split_cues(item['scene']['text'])
        counts = [len(words_of(p)) for p in parts]
        total, done = sum(counts), 0
        shift = item['voiceAt'] - item['cut'][0]
        for part, count in zip(parts, counts):
            first = min(len(heard) - 1, round(done / total * len(heard)))
            done += count
            last = max(first, min(len(heard) - 1, round(done / total * len(heard)) - 1))
            cues.append({'start': round(heard[first]['s'] + shift, 3), 'end': round(heard[last]['e'] + shift + 0.25, 3), 'text': part})
    for current, following in zip(cues, cues[1:]):
        current['end'] = min(current['end'], following['start'] - 0.04)
    return cues


def subtitle_layer(text):
    layer = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    draw = ImageDraw.Draw(layer)
    face = font(40, 'semibold')
    lines = wrap(draw, text, face, 1320)
    if len(lines) > 2:
        face = font(36, 'semibold')
        lines = wrap(draw, text, face, 1420)
    step = round(face.size * 1.32)
    bottom = 998
    top = bottom - len(lines) * step
    width = max(draw.textlength(line, font=face) for line in lines)
    draw.rounded_rectangle((W / 2 - width / 2 - 28, top - 14, W / 2 + width / 2 + 28, bottom + 8), radius=14, fill=(*INK, 222))
    for index, line in enumerate(lines):
        draw.text((W / 2, top + index * step), line, anchor='mt', font=face, fill=WHITE)
    return layer


def srt(cues):
    def stamp(seconds):
        ms = round(seconds * 1000)
        return f'{ms // 3600000:02}:{ms // 60000 % 60:02}:{ms // 1000 % 60:02},{ms % 1000:03}'
    return '\n\n'.join(f"{i}\n{stamp(c['start'])} --> {stamp(c['end'])}\n{c['text']}" for i, c in enumerate(cues, 1)) + '\n'


# ---------- composition ----------

class Composition:
    def __init__(self, timeline, duration, cues, clip, title_at, hosted):
        self.timeline, self.duration, self.cues = timeline, duration, cues
        self.clip, self.title_at, self.hosted = clip, title_at, hosted
        self.layers = [subtitle_layer(c['text']) for c in cues]
        self.cue_starts = [c['start'] for c in cues]
        self.address = self.address_layer(HOSTED_URL)
        self.vignette = self.make_vignette()
        self.first, self.last = clip.frames[0], clip.frames[-1]
        backdrop = self.last.filter(ImageFilter.GaussianBlur(16))
        self.outro_bg = Image.blend(Image.new('RGB', (W, H), INK), backdrop, 0.42)

    @staticmethod
    def make_vignette():
        x = np.linspace(0, 1, W)[None, :]
        y = np.linspace(-1, 1, H)[:, None]
        alpha = np.clip(0.72 - 0.9 * x + 0.12 * y ** 2, 0.12, 0.72)
        layer = np.zeros((H, W, 4), dtype=np.uint8)
        layer[..., :3] = INK
        layer[..., 3] = (alpha * 255).astype(np.uint8)
        return Image.fromarray(layer, 'RGBA')

    @staticmethod
    def address_layer(text):
        """The public address of the running site, like a browser bar, on scenes recorded from it."""
        layer = Image.new('RGBA', (W, H), (0, 0, 0, 0))
        draw = ImageDraw.Draw(layer)
        face = font(24, 'semibold')
        width = draw.textlength(text, font=face)
        x, y = 28, 1026
        draw.rounded_rectangle((x, y, x + width + 62, y + 40), radius=20, fill=(*INK, 215))
        draw.rounded_rectangle((x + 16, y + 18, x + 32, y + 31), radius=3, fill=MINT)
        draw.arc((x + 18, y + 9, x + 30, y + 24), 180, 360, fill=MINT, width=3)
        draw.text((x + 44, y + 20), text, anchor='lm', font=face, fill=WHITE)
        return layer

    def scene_at(self, t):
        for item in self.timeline:
            if t < item['end']:
                return item
        return self.timeline[-1]

    def base(self, item, t):
        local = t - item['start']
        if item['id'] == 'intro':
            return self.intro(local, item['end'] - item['start'])
        if item['id'] == 'outro':
            return self.outro(local)
        return item['clip'].frame(local)

    def intro(self, local, length):
        if local < PRE_INTRO:
            image = push(self.first, 1.035 - 0.035 * ease(local / PRE_INTRO))
        elif local < PRE_INTRO + self.clip.duration:
            image = self.clip.frame(local - PRE_INTRO)
        else:
            rest = max(0.01, length - PRE_INTRO - self.clip.duration)
            image = push(self.last, 1 + 0.035 * ((local - PRE_INTRO - self.clip.duration) / rest))
        shown = local - self.title_at
        if shown <= 0:
            return image
        k = ease(shown / 0.9)
        image = Image.blend(image, Image.alpha_composite(image.convert('RGBA'), self.vignette).convert('RGB'), k)
        overlay = Image.new('RGBA', (W, H), (0, 0, 0, 0))
        od = ImageDraw.Draw(overlay)
        shift = round((1 - k) * 28)
        od.text((120, 380 + shift), 'SafeNet KZ', font=font(132, 'bold'), fill=(*WHITE, round(255 * k)))
        od.text((126, 550 + shift), 'Цифровой щит против незаконных схем', font=font(52, 'light'), fill=(*MINT, round(255 * k)))
        od.rounded_rectangle((126, 648, 126 + round(380 * ease((shown - 0.4) / 0.8)), 654), radius=3, fill=(*MINT, round(255 * k)))
        return Image.alpha_composite(image.convert('RGBA'), overlay).convert('RGB')

    def outro(self, local):
        image = self.outro_bg.copy()
        draw = ImageDraw.Draw(image)
        k = ease(local / 0.8)
        shift = round((1 - k) * 24)
        draw.text((W / 2, 300 + shift), 'SafeNet KZ', anchor='mt', font=font(140, 'bold'), fill=WHITE)
        draw.text((W / 2, 490 + shift), 'Машина читает всё. Решает человек.', anchor='mt', font=font(56, 'light'), fill=MINT)
        lines = [('Лотереи, онлайн-казино и пирамиды — признаки с объяснением', MUTED, 34, 'regular'), (HOSTED_URL, WHITE, 40, 'semibold')]
        for index, (line, colour, size, weight) in enumerate(lines):
            a = ease((local - 0.8 - index * 0.35) / 0.7)
            if a > 0:
                tone = tuple(round(c * a + i * (1 - a)) for c, i in zip(colour, INK))
                draw.text((W / 2, 650 + index * 62), line, anchor='mt', font=font(size, weight), fill=tone)
        return image

    def frame(self, t):
        item = self.scene_at(t)
        image = self.base(item, t)
        index = self.timeline.index(item)
        if index and t - item['start'] < FADE:
            previous = self.timeline[index - 1]
            image = Image.blend(self.base(previous, previous['end'] - 0.001), image, ease((t - item['start']) / FADE))
        image = image.convert('RGBA')
        if item['id'] in self.hosted:
            image = Image.alpha_composite(image, self.address)
        cue = bisect.bisect_right(self.cue_starts, t) - 1
        if cue >= 0 and t < self.cues[cue]['end']:
            image = Image.alpha_composite(image, self.layers[cue])
        draw = ImageDraw.Draw(image)
        draw.rectangle((0, H - 5, round(W * t / self.duration), H), fill=(*TEAL, 255))
        fade = min(1.0, t / 0.5, (self.duration - t) / 0.8)
        image = image.convert('RGB')
        if fade < 1:
            image = Image.blend(Image.new('RGB', (W, H), INK), image, max(0.0, fade))
        return image


# ---------- encode ----------

def mix_audio(timeline, duration, voice, ambience):
    total = math.ceil(duration * FPS) * RATE // FPS
    track = np.zeros((2, total), dtype=np.float32)
    for item in timeline:
        a, b = (round(x * RATE) for x in item['cut'])
        piece = faded(voice[:, a:b])
        at = round(item['voiceAt'] * RATE)
        n = min(piece.shape[1], total - at)
        track[:, at:at + n] += piece[:, :n]
    # The clip's own sound sits quietly under the intro and fades out with it.
    intro_end = round(timeline[0]['end'] * RATE)
    bed = ambience[:, :intro_end] * 0.22
    ramp = min(bed.shape[1], RATE * 2)
    bed[:, -ramp:] *= np.linspace(1, 0, ramp)
    track[:, :bed.shape[1]] += bed
    peak = float(np.max(np.abs(track)))
    if peak > 0.94:
        track *= 0.94 / peak
    return track


def encode(path, composition, track, duration):
    frames = math.ceil(duration * FPS)
    container = av.open(str(path), mode='w', options={'movflags': '+faststart'})
    video = container.add_stream('libx264', rate=FPS)
    video.width, video.height, video.pix_fmt = W, H, 'yuv420p'
    video.options = {'crf': '18', 'preset': 'veryfast', 'profile': 'high'}
    audio = container.add_stream('aac', rate=RATE)
    audio.layout, audio.bit_rate = 'stereo', 192000
    written = 0
    try:
        for index in range(frames):
            frame = av.VideoFrame.from_image(composition.frame(index / FPS))
            frame.pts, frame.time_base = index, Fraction(1, FPS)
            for packet in video.encode(frame):
                container.mux(packet)
            limit = min(track.shape[1], (index + 1) * RATE // FPS)
            while written < limit:
                end = min(written + 1024, limit)
                chunk = av.AudioFrame.from_ndarray(np.ascontiguousarray(track[:, written:end]), format='fltp', layout='stereo')
                chunk.sample_rate, chunk.pts, chunk.time_base = RATE, written, Fraction(1, RATE)
                for packet in audio.encode(chunk):
                    container.mux(packet)
                written = end
            if index % (FPS * 10) == 0:
                print(f'  {index / FPS:5.0f} / {duration:.0f} s', flush=True)
        for stream in (video, audio):
            for packet in stream.encode(None):
                container.mux(packet)
    finally:
        container.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--preview', action='store_true', help='write the contact sheet and SRT only')
    args = parser.parse_args()
    scenes = json.loads((ROOT / 'jury-scenes.json').read_text(encoding='utf-8'))['scenes']
    hosted = {scene['id'] for scene in scenes if scene.get('source') == 'hosted'}
    align = json.loads((ROOT / 'voice' / 'gen1.align.json').read_text(encoding='utf-8'))
    voice = read_audio(ROOT / 'voice' / 'gen1.mp3')
    clip = Clip(ROOT / 'intro' / 'clip.mp4')
    timeline, duration = build_timeline(scenes, align, voice.shape[1] / RATE, clip)
    cues = build_cues(timeline, align)
    intro_mark = next(s for s in align['scenes'] if s['id'] == 'intro')
    we = next(w for w in align['words'] if w['s'] >= intro_mark['start'] and w['w'].strip('.,').lower() == 'мы')
    title_at = timeline[0]['voiceAt'] + we['s'] - timeline[0]['cut'][0]
    composition = Composition(timeline, duration, cues, clip, title_at, hosted)

    OUT.mkdir(exist_ok=True)
    name = 'safenet-kz-jury-ru'
    (OUT / f'{name}.srt').write_text(srt(cues), encoding='utf-8')
    picks = [1.0, PRE_INTRO + 4, title_at + 1.5] + [item['start'] + min(6.0, (item['end'] - item['start']) * 0.6) for item in timeline[1:]]
    sheet = Image.new('RGB', (3 * 640, 4 * 360), INK)
    for index, t in enumerate(picks[:12]):
        sheet.paste(composition.frame(t).resize((640, 360), Image.Resampling.LANCZOS), ((index % 3) * 640, (index // 3) * 360))
    sheet.save(OUT / f'{name}.contact-sheet.jpg', quality=90)
    report = {'output': f'{name}.mp4', 'durationSeconds': round(duration, 2), 'fps': FPS, 'size': [W, H],
              'scenes': [{'id': i['id'], 'start': round(i['start'], 2), 'end': round(i['end'], 2),
                          'speed': round(i['clip'].speed, 2) if i['clip'] else None} for i in timeline],
              'subtitles': len(cues), 'voice': 'ElevenLabs Eleven v4, voice Serik, Russian',
              'intro': 'Google Flow: two Nano Banana keyframes, then a Veo 3.1 Fast frames-to-video clip between them',
              'screens': 'Screencast of https://' + HOSTED_URL + ' and of the same app on the team computer (social scene)'}
    print(json.dumps(report, ensure_ascii=True, indent=1))
    if args.preview:
        return
    try:
        ambience = np.concatenate([np.zeros((2, round(PRE_INTRO * RATE)), dtype=np.float32), read_audio(ROOT / 'intro' / 'clip.mp4')], axis=1)
    except Exception:
        ambience = np.zeros((2, RATE), dtype=np.float32)  # a clip without sound
    encode(OUT / f'{name}.mp4', composition, mix_audio(timeline, duration, voice, ambience), duration)
    (OUT / f'{name}.render.json').write_text(json.dumps(report, ensure_ascii=False, indent=1), encoding='utf-8')
    print('done', OUT / f'{name}.mp4')


if __name__ == '__main__':
    main()

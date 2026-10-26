"""Render the SafeNet KZ jury video (Russian voiceover) with PyAV + Pillow.

Inputs in this folder:
  jury-scenes.json        scene order and narration script
  voice/gen1.mp3          voiceover of the whole script; voice/gen1.align.json has word timings per scene (align.py)
  frames/<scene>/         screencast of the running site with a log of every step (record.py)
  intro/clip.mp4          clip animated between the two keyframes intro/start.png → intro/end.png; the stills shown
                          before and after it are its own first and last frames, so still → motion → still has no seam
  sound.py                music bed and effects

The site plays in a browser window on a dark canvas. A camera eases in on the target of each recorded step and back
out for scrolling; scenes slide into each other; music sits under the voice and ducks while it speaks; clicks, key
taps and whooshes land on the recorded steps and the cuts.
Usage:  python render_jury.py [--preview] [--segment START END]
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

import sound

ROOT = Path(__file__).resolve().parent
OUT = ROOT / 'output'
W, H, FPS, RATE = 1920, 1080, 30, sound.RATE

INK = (9, 33, 36)
DEEP = (13, 58, 60)
TEAL = (11, 125, 116)
MINT = (156, 226, 210)
WHITE = (245, 247, 244)
MUTED = (185, 203, 199)
FONTS = {'regular': 'C:/Windows/Fonts/segoeui.ttf', 'semibold': 'C:/Windows/Fonts/seguisb.ttf',
         'bold': 'C:/Windows/Fonts/segoeuib.ttf', 'light': 'C:/Windows/Fonts/segoeuil.ttf'}

LEAD, TAIL, FADE = 0.45, 0.8, 0.6      # voice offset into a scene, pause after it, scene transition
MAX_SPEED, SKIP = 1.45, 0.6            # recordings play at most 1.45x (the rest is trimmed); skip the first frames
MIN_SECONDS = {'case': 16.5, 'check': 12.5}   # scenes that need time to show a result after the voice
PRE_INTRO = 2.2                        # seconds of the first keyframe before the clip starts
HOSTED_URL = 'safenet-kz.up.railway.app'
CHAPTERS = {'live': 'Пульт', 'telegram': 'Поиск в Telegram', 'case': 'Разбор случая', 'check': 'Проверка текста',
            'social': 'Instagram и TikTok', 'strength': 'Качество'}

# The window: the site at 84% on the canvas under a browser bar. Camera zoom 1/K makes the page fill the frame.
K = 0.84
TOP, BAR_H, RADIUS = 60, 46, 16
WIN_W, WIN_H = W * K, H * K
WX, CY0 = (W - WIN_W) / 2, TOP + BAR_H
REST = (W / 2, (TOP + CY0 + WIN_H) / 2, 1.0)
FILL = (W / 2, CY0 + WIN_H / 2, 1 / K)
SPRING, START_HOLD, SLIDE = 4.2, 1.1, 150
SHADOW_PAD = 200


@lru_cache(maxsize=128)
def font(size, weight='regular'):
    return ImageFont.truetype(FONTS[weight], max(6, size))


def ease(x):
    x = min(1.0, max(0.0, x))
    return 1 - (1 - x) ** 3


def ease_io(x):
    x = min(1.0, max(0.0, x))
    return 4 * x ** 3 if x < 0.5 else 1 - (-2 * x + 2) ** 3 / 2


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


def trimmed(layer):
    """An RGBA overlay cut to its visible box, with where that box sits, so pasting it touches only those pixels."""
    box = layer.getbbox()
    return layer.crop(box), box[:2]


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
    """Screencast frames of one page and its step log; frames arrive only on change, so hold the latest one."""

    def __init__(self, name):
        self.folder = ROOT / 'frames' / name
        data = json.loads((self.folder / 'timestamps.json').read_text(encoding='utf-8'))
        self.t0 = data['frames'][0]['t']
        self.times = [f['t'] - self.t0 for f in data['frames']]
        self.files = [f['file'] for f in data['frames']]
        self.events = data.get('events', [])
        self.usable = self.times[-1] - SKIP
        self.speed = 1.0

    def local(self, epoch):
        """Scene time at which something logged at `epoch` (same clock as the frames) is on screen."""
        return (epoch - self.t0 - SKIP) / self.speed

    def frame(self, local):
        source = SKIP + min(local * self.speed, self.usable)
        index = max(0, bisect.bisect_right(self.times, source) - 1)
        return load_frame(str(self.folder / self.files[index]))


@lru_cache(maxsize=8)
def load_frame(path):
    return Image.open(path).convert('RGB')


class Clip:
    def __init__(self, path):
        with av.open(str(path)) as container:
            stream = container.streams.video[0]
            self.frames = [f.to_image().convert('RGB').resize((W, H), Image.Resampling.BICUBIC) for f in container.decode(stream)]
            self.fps = float(stream.average_rate)
        self.duration = len(self.frames) / self.fps

    def frame(self, t):
        return self.frames[min(len(self.frames) - 1, max(0, int(t * self.fps)))]


# ---------- camera ----------

def clamp_view(x, y, z):
    """Keep the view inside the window once it is zoomed past it; centre the window while it is smaller."""
    half_w, half_h = W / (2 * z), H / (2 * z)
    left, right, top, bottom = WX, WX + WIN_W, TOP, CY0 + WIN_H
    x = min(max(x, left + half_w), right - half_w) if right - left > 2 * half_w else (left + right) / 2
    y = min(max(y, top + half_h), bottom - half_h) if bottom - top > 2 * half_h else (top + bottom) / 2
    return x, y, z


def focus(event):
    """Camera target for one recorded step: its box, as close as its zoom hint allows and the box still fits."""
    box, hint = event.get('box'), event.get('zoom', 1.0)
    if not box or hint <= 1.0:
        return REST
    x0, y0 = max(0.0, box[0]), max(0.0, box[1])
    x1, y1 = min(1920.0, box[0] + box[2]), min(1080.0, box[1] + box[3])
    if x1 - x0 < 4 or y1 - y0 < 4:
        return REST
    width, height = (x1 - x0) * K, (y1 - y0) * K
    zoom = max(1.0, min(hint, 0.9 * W / width, 0.8 * H / height))
    return WX + (x0 + x1) / 2 * K, CY0 + (y0 + y1) / 2 * K, zoom


class Camera:
    """Where the edit looks inside one scene: (centre x, centre y, zoom) on the canvas for every output frame.

    It rests on the whole window and leans in on the target of each recorded step; a critically damped spring makes
    every move ease in and settle without overshoot.
    """

    def __init__(self, recording, length, start=None):
        steps = [(0.0, start), (START_HOLD, REST)] if start else [(0.0, REST)]
        for event in recording.events:
            local = recording.local(event['t'])
            if local < length:
                steps.append((max(steps[-1][0], local), focus(event)))
        x, y, z = clamp_view(*(start or REST))
        state, velocity = np.array([x, y, math.log(z)]), np.zeros(3)
        self.track, index, h = [], 0, 1 / FPS / 4
        for i in range(math.ceil(length * FPS) + 1):
            while index + 1 < len(steps) and steps[index + 1][0] <= i / FPS:
                index += 1
            tx, ty, tz = clamp_view(*steps[index][1])
            target = np.array([tx, ty, math.log(tz)])
            for _ in range(4):
                velocity += (SPRING ** 2 * (target - state) - 2 * SPRING * velocity) * h
                state += velocity * h
            self.track.append(clamp_view(state[0], state[1], math.exp(state[2])))

    def at(self, local):
        return self.track[min(len(self.track) - 1, max(0, round(local * FPS)))]


# ---------- stage ----------

class Stage:
    """Dark canvas, window shadow, browser bar and page, all under one camera transform."""

    def __init__(self):
        self.background = self.make_background()
        self.shadow = self.make_shadow()

    @staticmethod
    def make_background():
        w, h = W + 120, H + 68
        x = np.linspace(0, 1, w)[None, :, None]
        y = np.linspace(0, 1, h)[:, None, None]
        ink, deep, mint, teal = (np.array(c, dtype=np.float64) for c in (INK, DEEP, MINT, TEAL))
        image = ink + (deep - ink) * (0.55 * x + 0.45 * y)
        image += mint * 0.10 * np.exp(-((x - 0.86) ** 2 / 0.06 + (y - 0.08) ** 2 / 0.10))
        image += teal * 0.30 * np.exp(-((x - 0.08) ** 2 / 0.08 + (y - 0.96) ** 2 / 0.07))
        image += np.random.default_rng(1).uniform(-1.6, 1.6, (h, w, 1))   # dither against banding
        return Image.fromarray(np.clip(image, 0, 255).astype(np.uint8), 'RGB')

    @staticmethod
    def make_shadow():
        """Soft shadow under the window, at half resolution over the canvas plus a margin."""
        pad = SHADOW_PAD
        mask = Image.new('L', ((W + 2 * pad) // 2, (H + 2 * pad) // 2), 0)
        box = ((WX + pad) / 2, (TOP + pad + 24) / 2, (WX + WIN_W + pad) / 2, (CY0 + WIN_H + pad + 24) / 2)
        ImageDraw.Draw(mask).rounded_rectangle(box, radius=RADIUS / 2, fill=170)
        return mask.filter(ImageFilter.GaussianBlur(24))

    def background_at(self, t):
        x = round(60 + 52 * math.sin(2 * math.pi * t / 41))
        y = round(34 + 30 * math.sin(2 * math.pi * t / 53 + 1.3))
        return self.background.crop((x, y, x + W, y + H))

    @staticmethod
    def visible(x0, y0, x1, y1):
        return max(0, round(x0)), max(0, round(y0)), min(W, round(x1)), min(H, round(y1))

    def draw(self, canvas, page, camera, address, dx=0.0, scale=1.0):
        cx, cy, z = camera
        zoom = z * scale

        def screen(x, y):
            return (x - cx) * zoom + W / 2 + dx, (y - cy) * zoom + H / 2

        def resized(image, rect, size):
            """The part of `image` (spanning `rect` on screen) that falls on the screen, scaled to the screen."""
            x0, y0, x1, y1 = rect
            v = self.visible(*rect)
            if v[2] <= v[0] or v[3] <= v[1]:
                return None, v
            iw, ih = size
            # Rounding the screen edges can reach a fraction of a pixel past the image; keep the box inside it.
            box = (max(0.0, (v[0] - x0) / (x1 - x0) * iw), max(0.0, (v[1] - y0) / (y1 - y0) * ih),
                   min(iw, (v[2] - x0) / (x1 - x0) * iw), min(ih, (v[3] - y0) / (y1 - y0) * ih))
            return image.resize((v[2] - v[0], v[3] - v[1]), Image.Resampling.BICUBIC, box=box), v

        if zoom < 1 / K * 0.98:
            rect = (*screen(-SHADOW_PAD, -SHADOW_PAD), *screen(W + SHADOW_PAD, H + SHADOW_PAD))
            part, v = resized(self.shadow, rect, self.shadow.size)
            if part:
                canvas.paste((0, 0, 0), v, part)

        bx0, by0 = screen(WX, TOP)
        px0, py0 = screen(WX, CY0)
        px1, py1 = screen(WX + WIN_W, CY0 + WIN_H)
        radius = RADIUS * zoom
        draw = ImageDraw.Draw(canvas)
        draw.rounded_rectangle((bx0, by0, px1, py0 + radius), radius=radius, fill=(233, 239, 237), corners=(True, True, False, False))
        mid = (by0 + py0) / 2
        for index, colour in enumerate(((237, 106, 94), (245, 191, 79), (98, 197, 85))):
            ox = bx0 + (24 + index * 21) * zoom
            draw.ellipse((ox - 6 * zoom, mid - 6 * zoom, ox + 6 * zoom, mid + 6 * zoom), fill=colour)
        half = 330 * zoom
        centre = (bx0 + px1) / 2
        draw.rounded_rectangle((centre - half, mid - 15 * zoom, centre + half, mid + 15 * zoom), radius=15 * zoom, fill=(255, 255, 255), outline=(214, 222, 219))
        face = font(round(17 * zoom))
        host, path = address
        x = centre - half + 20 * zoom
        if path is not None:   # the public site: padlock, host, route
            draw.rounded_rectangle((x, mid - 1 * zoom, x + 12 * zoom, mid + 8 * zoom), radius=2 * zoom, fill=(52, 120, 108))
            draw.arc((x + 2 * zoom, mid - 8 * zoom, x + 10 * zoom, mid + 3 * zoom), 180, 360, fill=(52, 120, 108), width=max(1, round(2 * zoom)))
            x += 22 * zoom
        draw.text((x, mid), host, anchor='lm', font=face, fill=(40, 62, 66))
        if path:
            draw.text((x + draw.textlength(host, font=face), mid), path, anchor='lm', font=face, fill=(128, 146, 146))

        part, v = resized(page, (px0, py0, px1, py1), page.size)
        if part:
            mask = Image.new('L', part.size, 0)
            ImageDraw.Draw(mask).rounded_rectangle((px0 - v[0], py0 - v[1], px1 - v[0] - 1, py1 - v[1] - 1), radius=radius, fill=255, corners=(False, False, True, True))
            canvas.paste(part, v[:2], mask)
            draw.line((px0, py0, px1, py0), fill=(210, 219, 216), width=max(1, round(zoom)))
        return canvas


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
    for index, (scene, (cut_start, cut_end)) in enumerate(zip(scenes, cuts)):
        voice = cut_end - cut_start
        recording = camera = address = None
        if scene['id'] == 'intro':
            duration = max(voice + LEAD + 1.4, PRE_INTRO + clip.duration + 1.5)
        elif scene['id'] == 'outro':
            duration = voice + LEAD + 3.0
        else:
            recording = Recording(scene['id'])
            duration = max(voice + LEAD + TAIL, MIN_SECONDS.get(scene['id'], 0))
            recording.speed = min(MAX_SPEED, max(1.0, recording.usable / duration))
            # The first scene after the full-frame intro starts filling the frame, then pulls back to the window.
            camera = Camera(recording, duration, start=FILL if scenes[index - 1]['id'] == 'intro' else None)
            route = scene['path'].split('?')[0]
            address = (HOSTED_URL, '/' + route) if scene.get('source') == 'hosted' else ('SafeNet KZ — ' + CHAPTERS[scene['id']], None)
        timeline.append({'id': scene['id'], 'scene': scene, 'start': at, 'end': at + duration,
                         'cut': (cut_start, cut_end), 'voiceAt': at + LEAD, 'clip': recording, 'camera': camera, 'address': address})
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
    draw.rounded_rectangle((W / 2 - width / 2 - 28, top - 14, W / 2 + width / 2 + 28, bottom + 8), radius=14, fill=(*INK, 226))
    for index, line in enumerate(lines):
        draw.text((W / 2, top + index * step), line, anchor='mt', font=face, fill=WHITE)
    return layer


def chapter_layer(text):
    """Scene name in the margin above the window: a mint dot and the name."""
    face = font(26, 'semibold')
    width = round(ImageDraw.Draw(Image.new('L', (1, 1))).textlength(text, font=face))
    layer = Image.new('RGBA', (width + 30, 40), (0, 0, 0, 0))
    draw = ImageDraw.Draw(layer)
    draw.ellipse((2, 15, 12, 25), fill=(*MINT, 255))
    draw.text((26, 20), text, anchor='lm', font=face, fill=(*WHITE, 255))
    return layer


def srt(cues):
    def stamp(seconds):
        ms = round(seconds * 1000)
        return f'{ms // 3600000:02}:{ms // 60000 % 60:02}:{ms // 1000 % 60:02},{ms % 1000:03}'
    return '\n\n'.join(f"{i}\n{stamp(c['start'])} --> {stamp(c['end'])}\n{c['text']}" for i, c in enumerate(cues, 1)) + '\n'


# ---------- composition ----------

class Composition:
    def __init__(self, timeline, duration, cues, clip, title_at):
        self.timeline, self.duration, self.cues = timeline, duration, cues
        self.clip, self.title_at = clip, title_at
        self.stage = Stage()
        self.layers = [trimmed(subtitle_layer(c['text'])) for c in cues]
        self.cue_starts = [c['start'] for c in cues]
        self.chapters = {key: chapter_layer(text) for key, text in CHAPTERS.items()}
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

    def scene_at(self, t):
        for item in self.timeline:
            if t < item['end']:
                return item
        return self.timeline[-1]

    def base(self, item, t, dx=0.0, scale=1.0):
        local = t - item['start']
        if item['id'] == 'intro':
            return self.intro(local, item['end'] - item['start'])
        if item['id'] == 'outro':
            return self.outro(local)
        canvas = self.stage.background_at(t)
        return self.stage.draw(canvas, item['clip'].frame(local), item['camera'].at(local), item['address'], dx, scale)

    def intro(self, local, length):
        if local < PRE_INTRO:
            image = push(self.first, 1.035 - 0.035 * ease(local / PRE_INTRO))
        elif local < PRE_INTRO + self.clip.duration:
            image = self.clip.frame(local - PRE_INTRO).copy()   # overlays are pasted in place; keep the clip clean
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

    def chapter(self, image, item, t, fade):
        """The scene name fades in with the scene and steps aside while the camera is zoomed in."""
        if item['id'] not in self.chapters:
            return
        z = item['camera'].at(t - item['start'])[2]
        alpha = fade * min(1.0, max(0.0, (1.12 - z) / 0.1))
        if alpha <= 0.01:
            return
        layer = self.chapters[item['id']].copy()
        layer.putalpha(layer.getchannel('A').point(lambda v: round(v * alpha)))
        image.paste(layer, (round(WX), 10), layer)

    def frame(self, t):
        item = self.scene_at(t)
        index = self.timeline.index(item)
        into = (t - item['start']) / FADE
        previous = self.timeline[index - 1] if index else None
        if previous and into < 1:
            m = ease_io(into)
            held = previous['end'] - 0.001
            if previous['clip'] and item['clip']:          # site → site: slide across
                image = Image.blend(self.base(previous, held, dx=-SLIDE * m, scale=1 - 0.03 * m),
                                    self.base(item, t, dx=SLIDE * (1 - m), scale=0.97 + 0.03 * m), m)
            elif previous['clip']:                          # site → final card: the window steps back
                image = Image.blend(self.base(previous, held, scale=1 - 0.08 * m), self.base(item, t), m)
            else:
                image = Image.blend(self.base(previous, held), self.base(item, t), m)
            if previous['clip']:
                self.chapter(image, previous, held, 1 - m)
            if item['clip']:
                self.chapter(image, item, t, m)
        else:
            image = self.base(item, t)
            if item['clip']:
                self.chapter(image, item, t, 1.0)
        cue = bisect.bisect_right(self.cue_starts, t) - 1
        if cue >= 0 and t < self.cues[cue]['end']:
            piece, at = self.layers[cue]
            image.paste(piece, at, piece)
        draw = ImageDraw.Draw(image)
        draw.rectangle((0, H - 5, round(W * t / self.duration), H), fill=TEAL)
        fade = min(1.0, t / 0.5, (self.duration - t) / 0.8)
        if fade < 1:
            image = Image.blend(Image.new('RGB', (W, H), INK), image, max(0.0, fade))
        return image


# ---------- sound ----------

def effects(timeline, title_at):
    """(time, sound, gain) for every effect: title riser and hit, whooshes on cuts, clicks and keys, outro chime."""
    rng = np.random.default_rng(9)
    click = sound.click()
    out = [(title_at - 1.8, sound.riser(1.8), 0.16), (title_at, sound.impact(), 0.45)]
    for index, item in enumerate(timeline[1:], 1):
        out.append((item['start'] + FADE / 2 - 0.375, sound.whoosh(0.75, seed=20 + index), 0.2))
    for item in timeline:
        recording = item['clip']
        if not recording:
            continue
        length = item['end'] - item['start']
        for event in recording.events:
            local = recording.local(event['t'])
            if event['method'] == 'click':
                at = local + 0.75 / recording.speed     # record.py clicks 0.75 s after the cursor sets off
                if 0 <= at < length:
                    out.append((item['start'] + at, click, 0.34))
            elif event['method'] == 'type':
                at, end = local, local + event['seconds'] * 0.65 / recording.speed
                while at < min(end, length):
                    if at >= 0:
                        out.append((item['start'] + at, sound.key(rng), 0.13))
                    at += rng.uniform(0.06, 0.12)
    out.append((timeline[-1]['start'] + 0.3, sound.chime(), 0.2))
    return out


def envelope(track, attack=0.06, release=0.5, ahead=0.08):
    """How much the voice is speaking, 0…1, slightly ahead of time so the music ducks before a word starts."""
    block = RATE // 100
    mono = np.abs(track).mean(axis=0)
    n = mono.size // block
    level = np.sqrt((mono[:n * block].reshape(n, block) ** 2).mean(axis=1))
    on = np.clip((level - 0.01) / 0.03, 0, 1)
    smooth, value = np.zeros(n), 0.0
    up, down = 1 - math.exp(-0.01 / attack), 1 - math.exp(-0.01 / release)
    for i in range(n):
        value += (on[i] - value) * (up if on[i] > value else down)
        smooth[i] = value
    shift = round(ahead * 100)
    smooth = np.concatenate([smooth[shift:], np.zeros(shift)])
    return np.interp(np.arange(track.shape[1]) / block, np.arange(n), smooth)


def mix_audio(timeline, duration, voice, ambience, title_at):
    total = math.ceil(duration * FPS) * RATE // FPS
    speech = np.zeros((2, total), dtype=np.float32)
    for item in timeline:
        a, b = (round(x * RATE) for x in item['cut'])
        piece = faded(voice[:, a:b])
        at = round(item['voiceAt'] * RATE)
        n = min(piece.shape[1], total - at)
        speech[:, at:at + n] += piece[:, :n]
    # Music: about 16 dB under the voice while it speaks, 7 dB under it in the pauses.
    music = sound.score(total / RATE, title_at, timeline[1]['start'], timeline[-1]['start'])[:, :total]
    talking = envelope(speech)
    voice_rms = float(np.sqrt(np.mean(speech[:, talking > 0.5] ** 2)))
    music_rms = float(np.sqrt(np.mean(music ** 2)))
    under, gap = voice_rms / music_rms * 10 ** (-16 / 20), voice_rms / music_rms * 10 ** (-7 / 20)
    track = speech + music * (gap + (under - gap) * talking)
    for at, effect, gain in effects(timeline, title_at):
        sound.add(track, effect.astype(np.float32), at, gain * voice_rms / 0.1)
    # The clip's own sound sits quietly under the intro and fades out with it.
    intro_end = min(total, round(timeline[0]['end'] * RATE))
    bed = ambience[:, :intro_end] * 0.1
    ramp = min(bed.shape[1], RATE * 2)
    bed[:, -ramp:] *= np.linspace(1, 0, ramp)
    track[:, :bed.shape[1]] += bed
    # Loudness: the body of the mix up to 0.88, the rare effect peaks above it rounded off softly below 0.93,
    # which leaves headroom for the AAC encoder's own overshoot.
    track *= 0.88 / max(float(np.percentile(np.abs(track), 99.98)), 1e-6)
    over = np.abs(track) > 0.86
    track[over] = np.sign(track[over]) * (0.86 + 0.07 * np.tanh((np.abs(track[over]) - 0.86) / 0.07))
    return track.astype(np.float32)


# ---------- encode ----------

def encode(path, composition, track, start, end):
    first, last = round(start * FPS), math.ceil(end * FPS)
    container = av.open(str(path), mode='w', options={'movflags': '+faststart'})
    video = container.add_stream('libx264', rate=FPS)
    video.width, video.height, video.pix_fmt = W, H, 'yuv420p'
    video.options = {'crf': '20', 'preset': 'medium', 'profile': 'high'}
    audio = container.add_stream('aac', rate=RATE)
    audio.layout, audio.bit_rate = 'stereo', 192000
    offset = first * RATE // FPS
    written = offset
    try:
        for index in range(first, last):
            frame = av.VideoFrame.from_image(composition.frame(index / FPS))
            frame.pts, frame.time_base = index - first, Fraction(1, FPS)
            for packet in video.encode(frame):
                container.mux(packet)
            limit = min(track.shape[1], (index + 1) * RATE // FPS)
            while written < limit:
                stop = min(written + 1024, limit)
                chunk = av.AudioFrame.from_ndarray(np.ascontiguousarray(track[:, written:stop]), format='fltp', layout='stereo')
                chunk.sample_rate, chunk.pts, chunk.time_base = RATE, written - offset, Fraction(1, RATE)
                for packet in audio.encode(chunk):
                    container.mux(packet)
                written = stop
            if index % (FPS * 10) == 0:
                print(f'  {index / FPS:5.0f} / {end:.0f} s', flush=True)
        for stream in (video, audio):
            for packet in stream.encode(None):
                container.mux(packet)
    finally:
        container.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--preview', action='store_true', help='write the contact sheet and SRT only')
    parser.add_argument('--segment', nargs=2, type=float, metavar=('START', 'END'), help='render only this stretch to output/*-preview.mp4')
    args = parser.parse_args()
    scenes = json.loads((ROOT / 'jury-scenes.json').read_text(encoding='utf-8'))['scenes']
    align = json.loads((ROOT / 'voice' / 'gen1.align.json').read_text(encoding='utf-8'))
    voice = read_audio(ROOT / 'voice' / 'gen1.mp3')
    clip = Clip(ROOT / 'intro' / 'clip.mp4')
    timeline, duration = build_timeline(scenes, align, voice.shape[1] / RATE, clip)
    cues = build_cues(timeline, align)
    intro_mark = next(s for s in align['scenes'] if s['id'] == 'intro')
    we = next(w for w in align['words'] if w['s'] >= intro_mark['start'] and w['w'].strip('.,').lower() == 'мы')
    title_at = timeline[0]['voiceAt'] + we['s'] - timeline[0]['cut'][0]
    composition = Composition(timeline, duration, cues, clip, title_at)

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
              'titleAt': round(title_at, 2), 'subtitles': len(cues), 'voice': 'ElevenLabs Eleven v4, voice Serik, Russian',
              'music': 'sound.py: D-major underscore at 96 BPM, ducked under the voice; clicks, keys, whooshes, riser, impact, chime',
              'intro': 'Google Flow: two Nano Banana keyframes, then a Veo 3.1 Fast frames-to-video clip between them',
              'screens': 'Screencast of https://' + HOSTED_URL + ' and of the same app on the team computer (social scene)'}
    print(json.dumps(report, ensure_ascii=True, indent=1))
    if args.preview:
        return
    try:
        ambience = np.concatenate([np.zeros((2, round(PRE_INTRO * RATE)), dtype=np.float32), read_audio(ROOT / 'intro' / 'clip.mp4')], axis=1)
    except Exception:
        ambience = np.zeros((2, RATE), dtype=np.float32)  # a clip without sound
    track = mix_audio(timeline, duration, voice, ambience, title_at)
    if args.segment:
        start, end = max(0.0, args.segment[0]), min(duration, args.segment[1])
        encode(OUT / f'{name}-preview.mp4', composition, track, start, end)
        print('done', OUT / f'{name}-preview.mp4')
        return
    encode(OUT / f'{name}.mp4', composition, track, 0.0, duration)
    (OUT / f'{name}.render.json').write_text(json.dumps(report, ensure_ascii=False, indent=1), encoding='utf-8')
    print('done', OUT / f'{name}.mp4')


if __name__ == '__main__':
    main()

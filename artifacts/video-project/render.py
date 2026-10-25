"""Render an evidence-based SafeNet presentation with local PyAV + Pillow.

No network access, generated UI, transcription, or external service calls.
Required inputs are a genuine screen recording and finished narration.
"""
from __future__ import annotations

import argparse
from collections import OrderedDict
from fractions import Fraction
from functools import lru_cache
import hashlib
import json
import math
from pathlib import Path
import sys

import av
import numpy as np
from PIL import Image, ImageDraw, ImageFont, ImageFilter

ROOT = Path(__file__).resolve().parent
W, H, FPS = 1920, 1080, 30
GREEN = '#123C2E'
DEEP = '#09281F'
LIME = '#C8F565'
WHITE = '#F4F5EC'
MUTED = '#B1C7BC'
AMBER = '#F0CC7D'
FONT = Path('C:/Windows/Fonts/segoeui.ttf')
BOLD = Path('C:/Windows/Fonts/segoeuib.ttf')
LIGHT = Path('C:/Windows/Fonts/segoeuil.ttf')


def resolve_path(value):
    path = Path(value)
    return path if path.is_absolute() else ROOT / path


def load_json(path):
    return json.loads(Path(path).read_text(encoding='utf-8-sig'))


def sha256(path):
    digest = hashlib.sha256()
    with open(path, 'rb') as handle:
        for part in iter(lambda: handle.read(1024 * 1024), b''):
            digest.update(part)
    return digest.hexdigest()


@lru_cache(maxsize=80)
def font(size, weight='regular'):
    return ImageFont.truetype(str({'regular': FONT, 'bold': BOLD, 'light': LIGHT}[weight]), size)


def ease(value):
    value = min(1, max(0, value))
    return 1 - (1 - value) ** 3


def wrap(draw, text, face, width):
    rows = []
    for paragraph in text.split('\n'):
        words = paragraph.split()
        row = ''
        for word in words:
            candidate = (row + ' ' + word).strip()
            if row and draw.textlength(candidate, font=face) > width:
                rows.append(row)
                row = word
            else:
                row = candidate
        rows.append(row)
    return rows


def text_block(image, text, xy, width, size=56, fill=WHITE, weight='bold', leading=1.18):
    draw = ImageDraw.Draw(image)
    face = font(size, weight)
    x, y = xy
    for row in wrap(draw, text, face, width):
        draw.text((x, y), row, font=face, fill=fill, stroke_width=0)
        y += round(size * leading)
    return y


class VideoSource:
    """Decode sequentially, seeking when a short recording is replayed."""
    def __init__(self, path):
        self.path = Path(path)
        self.container = av.open(str(path))
        if not self.container.streams.video:
            raise ValueError(f'No video track: {path}')
        self.stream = self.container.streams.video[0]
        self.stream.thread_type = 'AUTO'
        duration = (float(self.stream.duration * self.stream.time_base)
                    if self.stream.duration else None)
        if not duration and self.container.duration:
            duration = self.container.duration / av.time_base
        if not duration:
            # A browser MediaRecorder WebM can omit its duration metadata.
            duration = 0
            for frame in self.container.decode(self.stream):
                if frame.time is not None:
                    duration = max(duration, float(frame.time))
            duration += 1 / float(self.stream.average_rate or FPS)
            self.container.seek(0, stream=self.stream)
        self.duration = float(duration)
        if self.duration <= 0:
            raise ValueError(f'Empty video: {path}')
        self.width, self.height = self.stream.width, self.stream.height
        self.iterator = iter(self.container.decode(self.stream))
        self.current_time = -1.0
        self.current_image = None
        self.next_frame = None
        self.cache = OrderedDict()

    def frame(self, seconds):
        target = min(max(0.0, seconds), max(0, self.duration - 0.05))
        key = round(target * FPS)
        if key in self.cache:
            self.cache.move_to_end(key)
            return self.cache[key]
        if target < self.current_time - 0.05 or target > self.current_time + 2:
            self.container.seek(max(0, int(target / float(self.stream.time_base))),
                                stream=self.stream, backward=True, any_frame=False)
            self.iterator = iter(self.container.decode(self.stream))
            self.current_time = -1
            self.current_image = None
            self.next_frame = None
        while True:
            if self.next_frame is not None:
                stamp, decoded = self.next_frame
                if stamp > target and self.current_image is not None:
                    break
                self.current_time, self.current_image = stamp, decoded
                self.next_frame = None
                continue
            frame = next(self.iterator, None)
            if frame is None:
                break
            stamp = float(frame.time or 0)
            decoded = frame.to_image().convert('RGB')
            if stamp <= target or self.current_image is None:
                self.current_time, self.current_image = stamp, decoded
            else:
                self.next_frame = (stamp, decoded)
                break
        if self.current_image is None:
            raise ValueError(f'Could not decode video frame: {self.path}')
        result = self.current_image
        self.cache[key] = result
        while len(self.cache) > 6:
            self.cache.popitem(last=False)
        return result

    def close(self):
        self.container.close()


def read_narration(path, gain_db=0.0):
    chunks = []
    with av.open(str(path)) as container:
        if not container.streams.audio:
            raise ValueError(f'No narration audio track: {path}')
        resampler = av.AudioResampler(format='fltp', layout='stereo', rate=48000)
        for frame in container.decode(container.streams.audio[0]):
            chunks.extend(out.to_ndarray() for out in resampler.resample(frame))
        chunks.extend(out.to_ndarray() for out in resampler.resample(None))
    if not chunks:
        raise ValueError('Narration is empty')
    audio = np.concatenate(chunks, axis=1).astype(np.float32)
    audio *= float(10 ** (gain_db / 20))
    peak = float(np.max(np.abs(audio)))
    # Peak guard only; this is not a claimed LUFS measurement.
    if peak > 0.891:
        audio *= 0.891 / peak
    fade = min(480, audio.shape[1] // 2)
    audio[:, :fade] *= np.linspace(0, 1, fade)
    audio[:, -fade:] *= np.linspace(1, 0, fade)
    return audio


def normalize_crop(crop, width, height):
    if not crop:
        return 0, 0, width, height
    if len(crop) != 4 or not all(isinstance(v, (int, float)) for v in crop):
        raise ValueError('Crop must be normalized [x, y, width, height]')
    x, y, w, h = crop
    if x < 0 or y < 0 or w <= 0 or h <= 0 or x + w > 1.00001 or y + h > 1.00001:
        raise ValueError(f'Crop outside source recording: {crop}')
    return round(x * width), round(y * height), round((x + w) * width), round((y + h) * height)


def rounded_paste(canvas, source, box, radius=22, padding=10, crop=None):
    x, y, right, bottom = box
    bw, bh = right - x, bottom - y
    draw = ImageDraw.Draw(canvas)
    draw.rounded_rectangle(box, radius=radius, fill='#E6EAE2', outline='#608572', width=1)
    image = source.crop(normalize_crop(crop, *source.size))
    ratio = min((bw - padding * 2) / image.width, (bh - padding * 2) / image.height)
    image = image.resize((round(image.width * ratio), round(image.height * ratio)), Image.Resampling.LANCZOS)
    px, py = x + (bw - image.width) // 2, y + (bh - image.height) // 2
    canvas.paste(image, (px, py))


def base_background():
    arr = np.zeros((H, W, 3), dtype=np.uint8)
    left = np.array([9, 40, 31])
    right = np.array([21, 64, 47])
    for x in range(W):
        arr[:, x] = left + (right - left) * (x / W)
    image = Image.fromarray(arr)
    draw = ImageDraw.Draw(image)
    # Restrained background geometry stays outside the evidence area.
    for offset in range(0, 6):
        draw.arc((1170 + offset * 70, -520 + offset * 70,
                  2350 - offset * 70, 660 - offset * 70), 110, 320,
                 fill=(32 + offset, 77 + offset, 55 + offset), width=1)
    return image


def brand(image, y=70):
    draw = ImageDraw.Draw(image)
    draw.rounded_rectangle((72, y, 120, y + 48), radius=12, fill=LIME)
    draw.text((86, y + 2), 'S', font=font(32, 'bold'), fill=DEEP)
    draw.text((138, y + 4), 'SafeNet KZ', font=font(30, 'bold'), fill=WHITE)
    draw.text((1660, y + 12), 'REAL TEST / 2026', font=font(18), fill=MUTED)


def pill(image, text, x, y, color=LIME, ink=DEEP, size=22):
    draw = ImageDraw.Draw(image)
    face = font(size, 'bold')
    width = math.ceil(draw.textlength(text, font=face)) + 30
    draw.rounded_rectangle((x, y, x + width, y + 43), radius=21, fill=color)
    draw.text((x + 15, y + 5), text, font=face, fill=ink)
    return width


def make_subtitles(config, duration, audio_duration):
    path = resolve_path(config['subtitles'])
    spec = load_json(path)
    if spec.get('timing') == 'absolute':
        return spec['cues'], spec.get('method', 'absolute_timing_supplied')
    cues = spec['cues']
    start = float(config.get('narration_start', 0.6))
    total = sum(max(1, len(c['text'].split())) for c in cues)
    now = start
    output = []
    for cue in cues:
        length = max(1, len(cue['text'].split())) / total * audio_duration
        output.append({'start': round(now, 3), 'end': round(now + length, 3), 'text': cue['text']})
        now += length
    return output, 'estimated_by_word_count_review_required'


def srt_stamp(seconds):
    total = round(seconds * 1000)
    hours, rem = divmod(total, 3600000)
    minutes, rem = divmod(rem, 60000)
    secs, ms = divmod(rem, 1000)
    return f'{hours:02}:{minutes:02}:{secs:02},{ms:03}'


def save_srt(path, cues):
    text = '\n\n'.join(f"{index}\n{srt_stamp(cue['start'])} --> {srt_stamp(cue['end'])}\n{cue['text']}"
                       for index, cue in enumerate(cues, 1))
    path.write_text(text + '\n', encoding='utf-8')


def subtitle_layer(cue):
    layer = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    draw = ImageDraw.Draw(layer)
    face = font(38)
    lines = wrap(draw, cue['text'], face, 1550)
    if len(lines) > 2:
        face = font(34)
        lines = wrap(draw, cue['text'], face, 1590)
    if len(lines) > 2:
        raise ValueError(f"Subtitle needs more than two lines; shorten cue: {cue['text']}")
    line_height = 49
    top = 990 - len(lines) * line_height // 2
    max_width = max(draw.textlength(line, font=face) for line in lines)
    draw.rounded_rectangle((W / 2 - max_width / 2 - 30, top - 12,
                            W / 2 + max_width / 2 + 30, top + len(lines) * line_height + 9),
                           radius=16, fill=(4, 20, 15, 230))
    for index, line in enumerate(lines):
        draw.text((W / 2, top + index * line_height), line, anchor='mt', font=face, fill=WHITE)
    return layer


class Composition:
    def __init__(self, config, screen, intro, duration, cues):
        self.config, self.screen, self.intro = config, screen, intro
        self.duration, self.cues = duration, cues
        self.background = base_background()
        self.subtitle_layers = [subtitle_layer(cue) for cue in cues]
        # Preserve intro length; adapt the edited demonstration to narration duration.
        self.intro_end = min(float(config.get('intro_seconds', 6)), duration * 0.2)
        self.end_start = duration - float(config.get('outro_seconds', 5.5))
        self.sections = ['real', 'score', 'why', 'languages', 'context']
        weights = [10, 10, 12, 8, 8]
        available = self.end_start - self.intro_end
        at = self.intro_end
        self.bounds = []
        for name, weight in zip(self.sections, weights):
            end = at + available * weight / sum(weights)
            self.bounds.append((name, at, end))
            at = end

    def recording_time(self, t, start, name):
        section = self.config.get('recording_ranges', {}).get(name, {})
        offset = max(0.0, float(section.get('in', self.config.get('recording_in', 0))))
        usable = min(float(section.get('seconds', self.config.get('recording_seconds')) or self.screen.duration), self.screen.duration - offset)
        if usable <= 0.1:
            raise ValueError('recording_in is beyond the end of the recording')
        return offset + (t - start) % max(0.1, usable - 0.05)

    def frame(self, t):
        image = self.background.copy()
        draw = ImageDraw.Draw(image)
        if t < self.intro_end:
            if self.intro:
                frame = self.intro.frame(min(t, self.intro.duration - 0.1))
                frame = frame.resize((W, H), Image.Resampling.LANCZOS)
                image = Image.blend(frame, image, 0.46)
            draw = ImageDraw.Draw(image)
            progress = ease((t - 0.25) / 1.1)
            shift = round((1 - progress) * 36)
            draw.text((96, 255 + shift), 'SafeNet KZ', font=font(116, 'bold'), fill=WHITE)
            draw.text((102, 416 + shift), 'Белгіні көр. Себебін түсін.', font=font(52), fill=LIME)
            draw.text((105, 515 + shift), 'Instagram-дағы нақты сынақ', font=font(30), fill=MUTED)
            draw.rounded_rectangle((104, 608, 104 + round(410 * ease(t / 3)), 614), radius=3, fill=LIME)
            pill(image, 'ҚАЗ + РУС', 104, 670)
            draw.text((104, 900), 'Кіріспе визуалы · демонстрация келесі кадрда', font=font(21), fill=MUTED)
        elif t >= self.end_start:
            brand(image)
            draw.text((W / 2, 280), 'SafeNet KZ', anchor='mt', font=font(110, 'bold'), fill=WHITE)
            draw.text((W / 2, 442), 'Белгіні көр. Себебін түсін.', anchor='mt', font=font(52), fill=LIME)
            draw.text((W / 2, 555), 'Қазақша және орысша · түсіндірмесі бар талдау', anchor='mt', font=font(30), fill=MUTED)
            draw.rounded_rectangle((705, 662, 1215, 730), radius=34, fill=LIME)
            draw.text((W / 2, 675), 'Саналы шешімнен басталады', anchor='mt', font=font(28, 'bold'), fill=DEEP)
        else:
            name, start, end = next(item for item in self.bounds if item[1] <= t < item[2])
            brand(image)
            draw.text((72, 180), f'0{self.sections.index(name)+1} / НАҚТЫ СЫНАҚ', font=font(22, 'bold'), fill=LIME)
            self.left_column(image, name)
            draw = ImageDraw.Draw(image)
            draw.text((610, 161), 'Instagram · нақты экран жазбасының монтаждалған үзіндісі', font=font(21), fill=MUTED)
            crop = self.config.get('crops', {}).get(name)
            rounded_paste(image, self.screen.frame(self.recording_time(t, start, name)), (600, 205, 1848, 902), crop=crop)
            draw.text((610, 914), 'Дәйек: «ФРИСПИНОВ»  ·  Сипаттама мәтінінің автоматты талдауы', font=font(20), fill=MUTED)
            draw.line((72, 876, 510, 876), fill='#436452', width=2)
            draw.text((72, 893), 'Тәуекел белгісі. Алаяқтықтың дәлелі емес.', font=font(18), fill=MUTED)
        for cue, layer in zip(self.cues, self.subtitle_layers):
            if cue['start'] <= t < cue['end']:
                image = Image.alpha_composite(image.convert('RGBA'), layer).convert('RGB')
                break
        # A tiny timeline is editorial, not a counterfeit playback control.
        draw = ImageDraw.Draw(image)
        draw.rectangle((0, H - 4, round(W * t / self.duration), H), fill=LIME)
        fade = min(1.0, max(0, t / 0.35), max(0, (self.duration - t) / 0.4))
        if fade < 1:
            image = Image.blend(Image.new('RGB', (W, H), DEEP), image, fade)
        return image

    @staticmethod
    def left_column(image, name):
        draw = ImageDraw.Draw(image)
        if name == 'real':
            text_block(image, 'Нақты пост.\nАшық себеп.', (72, 270), 470, 66)
            text_block(image, 'Іздеуден ашылған жазбаның сипаттамасы автоматты талданды.', (76, 490), 450, 31, MUTED, 'regular', 1.4)
            pill(image, 'Қолмен көшірусіз', 74, 692, size=23)
        elif name == 'score':
            draw.text((72, 252), '51', font=font(172, 'bold'), fill=AMBER)
            draw.text((302, 368), '/ 100', font=font(45), fill=MUTED)
            text_block(image, 'Тексеру\nқажет', (78, 486), 450, 59)
            text_block(image, 'Ережелер бойынша тәуекел ұпайы', (80, 658), 430, 28, MUTED, 'regular', 1.4)
        elif name == 'why':
            text_block(image, 'Неліктен\nбелгіленді?', (72, 265), 470, 59)
            pill(image, '01', 76, 465, size=21)
            text_block(image, 'Құмар ойын термині', (152, 466), 340, 29, WHITE)
            pill(image, '02', 76, 572, size=21)
            text_block(image, 'Бонуспен тарту', (152, 574), 340, 29, WHITE)
            draw.text((76, 725), '«ФРИСПИНОВ»', font=font(36, 'bold'), fill=AMBER)
        elif name == 'languages':
            text_block(image, 'Түсіндірме\nтүсінікті.', (72, 265), 470, 60)
            first = pill(image, 'ҚАЗАҚША', 76, 493, size=24)
            pill(image, 'РУССКИЙ', 76, 561, WHITE, DEEP, 24)
            text_block(image, 'Нақты дәйек.\nӘр белгіге себеп.', (78, 682), 440, 31, MUTED, 'regular', 1.4)
        else:
            text_block(image, 'Белгі —\nтексеруге\nсебеп.', (72, 265), 470, 60)
            text_block(image, 'Ұпай ықтималдықтың пайызы емес. Мәтінмән мен дереккөзді тексеріңіз.', (78, 558), 430, 31, MUTED, 'regular', 1.4)


def render_video(path, composition, narration, narration_start, duration):
    total_frames = math.ceil(duration * FPS)
    total_samples = round(total_frames / FPS * 48000)
    samples = np.zeros((2, total_samples), dtype=np.float32)
    start = round(narration_start * 48000)
    count = min(narration.shape[1], total_samples - start)
    samples[:, start:start + count] = narration[:, :count]
    container = av.open(str(path), mode='w', options={'movflags': '+faststart'})
    video = container.add_stream('libx264', rate=FPS)
    video.width, video.height, video.pix_fmt = W, H, 'yuv420p'
    video.options = {'crf': '20', 'preset': 'veryfast', 'profile': 'high'}
    video.codec_context.thread_count = 4
    audio = container.add_stream('aac', rate=48000)
    audio.layout = 'stereo'
    audio.bit_rate = 192000
    audio_at = 0
    try:
        for index in range(total_frames):
            image = composition.frame(index / FPS)
            frame = av.VideoFrame.from_image(image)
            frame.pts, frame.time_base = index, Fraction(1, FPS)
            for packet in video.encode(frame):
                container.mux(packet)
            limit = min(total_samples, round((index + 1) / FPS * 48000))
            while audio_at < limit:
                end = min(audio_at + 1024, total_samples)
                chunk = np.ascontiguousarray(samples[:, audio_at:end])
                af = av.AudioFrame.from_ndarray(chunk, format='fltp', layout='stereo')
                af.sample_rate, af.pts, af.time_base = 48000, audio_at, Fraction(1, 48000)
                for packet in audio.encode(af):
                    container.mux(packet)
                audio_at = end
            if index % (FPS * 5) == 0:
                print(f'Rendered {index / FPS:.0f} / {total_frames / FPS:.1f} seconds', flush=True)
        for packet in video.encode(None):
            container.mux(packet)
        for packet in audio.encode(None):
            container.mux(packet)
    finally:
        container.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', default=str(ROOT / 'render-config.json'))
    parser.add_argument('--recording', help='Override actual screen recording path')
    parser.add_argument('--voice', help='Override finished narration audio path')
    parser.add_argument('--intro', help='Override optional Google Flow intro path')
    parser.add_argument('--output', help='Override final MP4 path')
    parser.add_argument('--previews-only', action='store_true', help='Create poster/contact sheet, do not encode MP4')
    parser.add_argument('--allow-estimated-subtitles', action='store_true', help='Render a REVIEW draft with estimated cue timing')
    parser.add_argument('--no-burned-subtitles', action='store_true', help='Export SRT separately and omit burned subtitle text')
    args = parser.parse_args()
    config = load_json(args.config)
    for key, value in [('recording', args.recording), ('voice', args.voice), ('intro', args.intro), ('output', args.output)]:
        if value:
            config[key] = value
    evidence_path = resolve_path(config['evidence'])
    evidence = load_json(evidence_path)
    finding_text = '\n'.join(evidence['result']['panels'])
    if '51/100' not in finding_text or 'ФРИСПИНОВ' not in finding_text:
        raise ValueError('Configured evidence does not support the51/100 + ФРИСПИНОВ demonstration')
    recording_path, voice_path = resolve_path(config['recording']), resolve_path(config['voice'])
    for path in (recording_path, voice_path):
        if not path.is_file():
            raise FileNotFoundError(f'Required genuine asset is missing: {path}')
    intro_path = resolve_path(config['intro']) if config.get('intro') else None
    if intro_path and not intro_path.is_file():
        raise FileNotFoundError(f'Configured Flow intro is missing: {intro_path}; set intro=null to use local titles')
    screen, intro = VideoSource(recording_path), VideoSource(intro_path) if intro_path else None
    narration = read_narration(voice_path, config.get('voice_gain_db', 0))
    audio_duration = narration.shape[1] / 48000
    narration_start = float(config.get('narration_start', 0.6))
    duration = max(float(config.get('minimum_duration', 60)), audio_duration + narration_start + 1.5)
    cues, subtitle_timing = make_subtitles(config, duration, audio_duration)
    if subtitle_timing.startswith('estimated') and not args.allow_estimated_subtitles and not args.previews_only and not args.no_burned_subtitles:
        raise ValueError('Subtitle timing is estimated. Review/edit subtitle-cues.json to timing=absolute, or render a review draft with --allow-estimated-subtitles.')
    composition = Composition(config, screen, intro, duration, [] if args.no_burned_subtitles else cues)
    output = resolve_path(config['output'])
    output.parent.mkdir(parents=True, exist_ok=True)
    save_srt(output.with_suffix('.kk.srt'), cues)
    preview_times = [3, composition.bounds[0][1] + 2, composition.bounds[1][1] + 2,
                     composition.bounds[2][1] + 3, composition.bounds[3][1] + 2,
                     composition.end_start + 2]
    previews = [composition.frame(min(t, duration - 0.5)) for t in preview_times]
    previews[2].save(output.with_suffix('.poster.jpg'), quality=94)
    sheet = Image.new('RGB', (1920, 1080), DEEP)
    for index, image in enumerate(previews):
        tile = image.resize((640, 360), Image.Resampling.LANCZOS)
        sheet.paste(tile, ((index % 3) * 640, (index // 3) * 360))
    # The bottom360px preserve readable review labels rather than another fake scene.
    draw = ImageDraw.Draw(sheet)
    draw.text((55, 790), 'SafeNet KZ — montage review', font=font(42, 'bold'), fill=WHITE)
    draw.text((55, 860), 'Real recording + verified caption result. Multimedia recognition is not claimed.', font=font(27), fill=MUTED)
    draw.text((55, 920), f'Duration: {duration:.2f}s · 1920×1080 /30fps · Subtitle timing: {subtitle_timing}', font=font(25), fill=MUTED)
    sheet.save(output.with_suffix('.contact-sheet.jpg'), quality=94)
    report = {'status': 'previews_only' if args.previews_only else 'rendering', 'output': str(output),
              'width': W, 'height': H, 'fps': FPS, 'durationSeconds': round(duration, 3),
              'narrationDurationSeconds': round(audio_duration, 3), 'subtitleTiming': subtitle_timing,
              'burnedSubtitles': not args.no_burned_subtitles,
              'flow_included': intro is not None,
              'introSource': 'Google Flow abstract clip' if intro is not None else 'Local designed typography and motion; Google Flow not included',
              'sourceRecordingRepeated': True, 'recordingLabel': 'Нақты экран жазбасының монтаждалған үзіндісі',
              'claim': 'Visible Instagram caption automatically flagged51/100; not proof of fraud or video/audio recognition',
              'evidenceUrl': evidence['result']['url'], 'evidenceSha256': sha256(evidence_path),
              'assets': [{'kind': kind, 'path': str(path), 'sha256': sha256(path)} for kind, path in
                         [('actual_recording', recording_path), ('narration', voice_path)]] +
                        ([{'kind': 'generated_abstract_intro_not_evidence', 'path': str(intro_path), 'sha256': sha256(intro_path)}] if intro_path else []),
              'audioNote': 'Peak guard applied; no LUFS measurement claimed.'}
    try:
        if not args.previews_only:
            render_video(output, composition, narration, narration_start, duration)
            report['status'] = 'rendered_review_required'
            report['outputBytes'] = output.stat().st_size
            report['outputSha256'] = sha256(output)
        output.with_suffix('.render.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    finally:
        screen.close()
        if intro:
            intro.close()
    # PowerShell can expose a legacy console code page; artifact JSON remains
    # UTF-8, while console output is ASCII-safe and cannot fail after rendering.
    print(json.dumps(report, ensure_ascii=True, indent=2))


if __name__ == '__main__':
    main()

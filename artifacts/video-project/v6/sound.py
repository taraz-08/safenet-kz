"""Music bed and sound effects for the jury video, synthesised with numpy (no samples, nothing to license).

The score is a calm D-major underscore at 96 BPM: warm pad, plucked arpeggio, soft bass and light drums, laid out on
a bar grid that puts a downbeat on the title reveal and a final chord on the outro card. render_jury.py mixes it
under the voice with ducking and drops the effects onto the edit: clicks and key taps from the recorded steps,
whooshes on scene changes, a riser and an impact on the title, a chime on the outro.
"""
from __future__ import annotations

import math

import numpy as np
from scipy.signal import butter, fftconvolve, istft, sosfilt, stft

RATE = 48000
BPM = 96
BEAT = 60 / BPM
BAR = 4 * BEAT

# (bass, pad voicing, arpeggio) as MIDI notes: Bm9 → Gmaj9 → D/F# → Asus2, then Dmaj9 for the ending.
CHORDS = [
    (47, [59, 62, 66, 69, 73], [71, 74, 78, 81]),
    (43, [59, 62, 66, 69], [67, 71, 74, 78]),
    (42, [57, 62, 66, 76], [69, 74, 78, 81]),
    (45, [57, 61, 64, 71], [69, 73, 76, 81]),
]
FINAL = (38, [62, 66, 69, 73, 76], [74, 78, 81, 85])
BELLS = [(0.0, 78), (1.5, 81), (2.0, 76), (3.0, 74), (5.0, 85)]   # (beats after the final chord, note)


def hz(note):
    return 440.0 * 2 ** ((note - 69) / 12)


def times(n):
    return np.arange(n, dtype=np.float64) / RATE


def pan(mono, position):
    """Equal-power pan, position 0 (left) … 1 (right)."""
    return np.stack([mono * math.cos(position * math.pi / 2), mono * math.sin(position * math.pi / 2)])


def band(signal, low, high, order=2):
    return sosfilt(butter(order, [low, high], btype='band', fs=RATE, output='sos'), signal, axis=-1)


def lowpass(signal, cutoff, order=2):
    return sosfilt(butter(order, cutoff, btype='low', fs=RATE, output='sos'), signal, axis=-1)


def highpass(signal, cutoff, order=2):
    return sosfilt(butter(order, cutoff, btype='high', fs=RATE, output='sos'), signal, axis=-1)


def add(track, sound, at, gain=1.0):
    start = round(at * RATE)
    if start >= track.shape[1] or start + sound.shape[1] <= 0:
        return
    cut = max(0, -start)
    end = min(track.shape[1], start + sound.shape[1])
    track[:, start + cut:end] += gain * sound[:, cut:end - start]


def reverb(signal, seconds=2.4, seed=3):
    """Convolution with decaying, darkened stereo noise: a soft hall."""
    rng = np.random.default_rng(seed)
    n = round(seconds * 1.2 * RATE)
    t = times(n)
    ir = lowpass(rng.standard_normal((2, n)), 5200) * np.exp(-6.9 * t / seconds)
    ir[:, :round(0.015 * RATE)] = 0
    ir /= np.sqrt(np.sum(ir ** 2, axis=1, keepdims=True))
    wet = np.stack([fftconvolve(signal[0], ir[0]), fftconvolve(signal[1], ir[1])])
    return wet[:, :signal.shape[1]]


# ---------- instruments ----------

def pad_note(note, length, brightness, rng, attack=1.1, release=1.9):
    n = round((length + release) * RATE)
    t = times(n)
    out = np.zeros((2, n))
    for detune, position in ((-0.07, 0.15), (0.0, 0.5), (0.06, 0.85)):
        f = hz(note + detune)
        wave = np.zeros(n)
        for h in range(1, 7):
            wave += np.exp(-(h - 1) / (1.2 + 2.2 * brightness)) / h * np.sin(2 * np.pi * f * h * t + rng.random() * 6.283)
        out += pan(wave, position)
    shape = np.minimum(1.0, t / attack) ** 2
    shape *= np.clip((length + release - t) / release, 0, 1) ** 1.5
    shape *= 1 + 0.08 * np.sin(2 * np.pi * 0.21 * t + rng.random() * 6.283)
    return out * shape / 3


def pluck(note, velocity, position):
    t = times(round(1.1 * RATE))
    f = hz(note)
    wave = np.sin(2 * np.pi * f * t) + 0.3 * np.exp(-t / 0.09) * np.sin(4 * np.pi * f * t) + 0.1 * np.exp(-t / 0.04) * np.sin(6 * np.pi * f * t)
    shape = np.exp(-t / 0.3) * np.minimum(1.0, t / 0.003)
    return pan(wave * shape * velocity, position)


def bass_note(note, length):
    t = times(round((length + 0.3) * RATE))
    f = hz(note)
    wave = np.sin(2 * np.pi * f * t) + 0.35 * np.sin(4 * np.pi * f * t) + 0.12 * np.sin(6 * np.pi * f * t) + 0.5 * np.sin(np.pi * f * t)
    shape = np.minimum(1.0, t / 0.012) * (0.75 + 0.25 * np.exp(-t / 0.4)) * np.clip((length + 0.3 - t) / 0.3, 0, 1)
    return pan(wave * shape, 0.5)


def kick():
    t = times(round(0.5 * RATE))
    body = np.sin(2 * np.pi * np.cumsum(44 + 80 * np.exp(-t / 0.03)) / RATE) * np.exp(-t / 0.17)
    snap = lowpass(np.random.default_rng(11).standard_normal(t.size), 3000) * np.exp(-t / 0.004) * 0.25
    return pan(body + snap, 0.5)


def clap(rng):
    t = times(round(0.35 * RATE))
    noise = band(rng.standard_normal(t.size), 900, 3200)
    bursts = sum(np.where(t >= d, np.exp(-(t - d) / 0.006), 0) for d in (0.0, 0.011, 0.022))
    tail = np.where(t >= 0.03, np.exp(-(t - 0.03) / 0.09), 0)
    return pan(noise * (bursts * 0.6 + tail), 0.5)


def hat(rng, velocity, open_=False):
    t = times(round((0.3 if open_ else 0.09) * RATE))
    noise = highpass(rng.standard_normal(t.size), 7500, order=4)
    return pan(noise * np.exp(-t / (0.11 if open_ else 0.022)) * velocity, 0.58)


def bell(note, velocity=1.0):
    t = times(round(3.0 * RATE))
    f = hz(note)
    wave = np.sin(2 * np.pi * f * t + 2.2 * np.exp(-t / 0.5) * np.sin(2 * np.pi * f * 3.5 * t))
    return pan(wave * np.exp(-t / 1.1) * np.minimum(1.0, t / 0.002) * velocity, 0.5)


# ---------- effects ----------

def click():
    """A mouse button: press and a softer release."""
    t = times(round(0.16 * RATE))
    rng = np.random.default_rng(5)

    def tick(at, gain, pitch):
        u = np.clip(t - at, 0, None)
        body = 0.6 * np.sin(2 * np.pi * pitch * u) * np.exp(-u / 0.004) + 0.45 * np.sin(2 * np.pi * pitch * 0.45 * u) * np.exp(-u / 0.009)
        grit = highpass(rng.standard_normal(t.size), 2500) * np.exp(-u / 0.0025) * 0.5
        return np.where(t >= at, (body + grit) * gain, 0)

    out = pan(tick(0.0, 1.0, 2500) + tick(0.075, 0.45, 2900), 0.55)
    return out / (np.max(np.abs(out)) + 1e-9)


def key(rng):
    """One soft key press, a little different each time."""
    t = times(round(0.07 * RATE))
    pitch = rng.uniform(1300, 1900)
    body = np.sin(2 * np.pi * pitch * t) * np.exp(-t / 0.0035) + 0.6 * np.sin(2 * np.pi * pitch * 0.4 * t) * np.exp(-t / 0.008)
    grit = highpass(rng.standard_normal(t.size), 3000) * np.exp(-t / 0.002) * 0.4
    return pan((body + grit) * rng.uniform(0.55, 1.0), rng.uniform(0.4, 0.6))


def whoosh(length=0.75, left_to_right=False, seed=21):
    """Air moving past: noise through a band-pass that sweeps up and back, panned across."""
    rng = np.random.default_rng(seed)
    n = round(length * RATE)
    f, frames, spec = stft(rng.standard_normal(n), fs=RATE, nperseg=1024, noverlap=768)
    k = np.linspace(0, 1, frames.size)
    centre = 260 * (3600 / 260) ** (np.sin(np.pi * np.clip(k * 1.1, 0, 1)) ** 1.4)
    mask = np.exp(-0.5 * (np.log2(np.maximum(f[:, None], 20) / centre[None, :]) / 0.75) ** 2)
    _, mono = istft(spec * mask, fs=RATE, nperseg=1024, noverlap=768)
    mono = mono[:n]
    t = times(mono.size) / length
    mono = mono * np.sin(np.pi * np.clip(t, 0, 1)) ** 2.2
    side = t if left_to_right else 1 - t
    out = np.stack([mono * np.cos(side * np.pi / 2), mono * np.sin(side * np.pi / 2)])
    return out / (np.max(np.abs(out)) + 1e-9)


def riser(length=1.8, seed=31):
    rng = np.random.default_rng(seed)
    n = round(length * RATE)
    t = times(n)
    noise = rng.standard_normal((2, n))
    pieces = np.zeros((2, n))
    for i in range(8):
        a, b = i * n // 8, (i + 1) * n // 8
        centre = 400 * (6000 / 400) ** ((i + 0.5) / 8)
        pieces[:, a:b] = band(noise, centre * 0.7, min(centre * 1.4, 20000))[:, a:b]
    tone = np.sin(2 * np.pi * np.cumsum(220 * 2 ** (2 * t / length)) / RATE) * 0.15
    out = (pieces + tone) * (t / length) ** 2.5
    return out / (np.max(np.abs(out)) + 1e-9)


def impact(seed=41):
    rng = np.random.default_rng(seed)
    t = times(round(2.6 * RATE))
    boom = np.sin(2 * np.pi * np.cumsum(36 + 60 * np.exp(-t / 0.08)) / RATE) * np.exp(-t / 0.7)
    thump = lowpass(rng.standard_normal(t.size), 400) * np.exp(-t / 0.06) * 0.6
    shimmer = sum(np.sin(2 * np.pi * f * t) * np.exp(-t / 1.4) for f in (1568, 2350, 3136)) * 0.05
    dry = pan(boom + thump, 0.5) + pan(shimmer, 0.5)
    out = dry + 0.35 * reverb(dry, seconds=2.2, seed=seed)
    return out / (np.max(np.abs(out)) + 1e-9)


def chime():
    dry = sum(bell(note, velocity) for note, velocity in ((86, 0.8), (90, 0.55), (93, 0.4)))
    out = dry + 0.6 * reverb(dry, seconds=2.6, seed=51)
    return out / (np.max(np.abs(out)) + 1e-9)


def swell(length=BAR, seed=61):
    """Reversed reverb noise that rises into a downbeat."""
    rng = np.random.default_rng(seed)
    t = times(round(length * RATE))
    out = (band(rng.standard_normal((2, t.size)), 500, 9000) * np.exp(-6.0 * t / length))[:, ::-1]
    return out / (np.max(np.abs(out)) + 1e-9)


# ---------- score ----------

def score(duration, title_at, groove_at, outro_at):
    """The whole music bed; bar lines sit on title_at, the groove and the final chord snap to the nearest bar."""
    rng = np.random.default_rng(7)
    n = round(duration * RATE)
    pads, plucks, low, drums, bells = (np.zeros((2, n)) for _ in range(5))

    def bar_of(t):
        return round((t - title_at) / BAR)

    first, groove, final = math.floor(-title_at / BAR), bar_of(groove_at), bar_of(outro_at)
    kicks = []
    for k in range(first, final):
        at = title_at + k * BAR
        bass, voicing, arp = CHORDS[k % 4]
        # The intro opens up from a dark, filtered pad to the full sound on the title.
        brightness = min(1.0, 0.25 + 0.75 * max(0.0, at + BAR) / title_at) if k < 0 else 1.0
        for note in voicing:
            add(pads, pad_note(note, BAR, brightness, rng), at, 0.16)
        # Arpeggio: quarter notes in the intro, then eighths, in a different order once the drums are in.
        step = BEAT if k < 0 else BEAT / 2
        order = [0, 1, 2, 3, 2, 1, 2, 3] if k < groove else [0, 2, 1, 3, 2, 1, 3, 2]
        if k >= -2:
            for i in range(round(BAR / step)):
                velocity = (0.55 if k < 0 else 0.8) * (1.0 if i % 2 == 0 else 0.72) * rng.uniform(0.9, 1.05)
                add(plucks, pluck(arp[order[i % 8]], velocity, 0.3 + 0.4 * (i % 2)), at + i * step, 0.11)
        if k >= 0:
            add(low, bass_note(bass, BAR - 0.08), at, 0.2)
        if k >= groove:
            for beat in range(4):
                b = at + beat * BEAT
                if beat in (0, 2):
                    add(drums, kick(), b, 0.5)
                    kicks.append(b)
                if beat in (1, 3) and k >= groove + 2:
                    add(drums, clap(rng), b, 0.16)
                add(drums, hat(rng, rng.uniform(0.5, 0.7), open_=(beat == 3 and k % 2 == 1)), b + BEAT / 2, 0.09)
                if k >= groove + 2:
                    add(drums, hat(rng, rng.uniform(0.25, 0.35)), b, 0.06)
    end_at = title_at + final * BAR
    add(drums, swell(), end_at - BAR, 0.18)
    bass, voicing, arp = FINAL
    hold = max(BAR, duration - end_at - 2.0)
    for note in voicing:
        add(pads, pad_note(note, hold, 0.8, rng, attack=0.4, release=2.0), end_at, 0.17)
    add(low, bass_note(bass, hold), end_at, 0.22)
    for beats, note in BELLS:
        add(bells, bell(note, 0.8), end_at + beats * BEAT, 0.12)
    for i, note in enumerate(arp + arp[::-1][1:]):
        add(plucks, pluck(note + 12, 0.5 * (1 - i / 9), 0.3 + 0.4 * (i % 2)), end_at + i * BEAT / 2, 0.09)

    # Pads, bass and arpeggio breathe with the kick (a gentle side-chain).
    pump = np.ones(n)
    for b in kicks:
        a = round(b * RATE)
        m = min(n - a, round(0.45 * RATE))
        if m > 0:
            pump[a:a + m] = np.minimum(pump[a:a + m], 1 - 0.28 * np.exp(-times(m) / 0.13))
    music = (pads + low + plucks) * pump + drums + bells
    music += 0.34 * reverb(pads + plucks * 0.8 + bells + drums * 0.15)
    music = lowpass(music, 15000)
    music = np.tanh(music * 1.4) / 1.4
    music *= np.clip((duration - times(n)) / 2.5, 0, 1) * np.minimum(1.0, times(n) / 1.2)
    return (music / (np.max(np.abs(music)) + 1e-9) * 0.9).astype(np.float32)


def write_wav(path, samples):
    import wave
    pcm = (np.clip(samples.T, -1, 1) * 32767).astype('<i2')
    with wave.open(str(path), 'wb') as f:
        f.setnchannels(2)
        f.setsampwidth(2)
        f.setframerate(RATE)
        f.writeframes(pcm.tobytes())


if __name__ == '__main__':
    # Listen to the bed on its own: python sound.py → output/music-preview.wav
    from pathlib import Path
    out = Path(__file__).resolve().parent / 'output' / 'music-preview.wav'
    write_wav(out, score(108.0, 9.2, 12.0, 98.0))
    print(out)

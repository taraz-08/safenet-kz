"""Encode actual browser screencast frames at their recorded timestamps.

Creates a chronological VFR master and optional chronological montage with long
capture gaps shortened. No invented/interpolated frames, UI or audio are added.
"""
from fractions import Fraction
from pathlib import Path
import argparse
import hashlib
import json

import av
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent


def encode(rows, directory, output, gap_limit=None):
    first = Image.open(directory / rows[0]['file']).convert('RGB')
    width, height = first.size
    out_width, out_height = width + width % 2, height + height % 2
    time_base = Fraction(1, 90000)
    container = av.open(str(output), 'w', options={'movflags': '+faststart'})
    stream = container.add_stream('libx264', rate=15)
    stream.width, stream.height, stream.pix_fmt = out_width, out_height, 'yuv420p'
    stream.time_base = stream.codec_context.time_base = time_base
    # No B-frame reordering: preserve VFR PTS and container duration for sparse
    # browser screencasts, including the final displayed state.
    stream.options = {'crf': '17', 'preset': 'fast', 'bf': '0'}
    stream.codec_context.max_b_frames = 0
    base = rows[0]['monotonicTimestamp']
    previous = base
    timeline = 0.0
    mapping = []
    try:
        for index, row in enumerate(rows):
            actual = row['monotonicTimestamp']
            gap = actual - previous
            if index and gap <= 0:
                raise ValueError('Capture timestamps must increase')
            timeline += min(gap, 0.25) if gap_limit and gap > gap_limit else gap
            image = Image.open(directory / row['file']).convert('RGB')
            if image.size != first.size:
                raise ValueError('Viewport resolution changed during capture')
            scale_x = width / row['deviceWidth']
            scale_y = height / row['deviceHeight']
            draw = ImageDraw.Draw(image)
            # Hide the private chat-avatar tray. Navigation above the SafeNet
            # panel is also omitted; the actual evidence region is untouched.
            draw.rectangle((round(730 * scale_x), round(498 * scale_y), width, height), fill='#0D1015')
            draw.rectangle((0, 0, round(170 * scale_x), round(420 * scale_y)), fill='#0D1015')
            padded = Image.new('RGB', (out_width, out_height), '#0D1015')
            padded.paste(image, (0, 0))
            frame = av.VideoFrame.from_image(padded)
            frame.pts, frame.time_base = round(timeline * 90000), time_base
            for packet in stream.encode(frame):
                container.mux(packet)
            mapping.append({'frame': row['file'], 'originalSeconds': round(actual - base, 6),
                            'outputSeconds': round(timeline, 6), 'gapShortened': bool(gap_limit and gap > gap_limit)})
            previous = actual
        for packet in stream.encode(None):
            container.mux(packet)
    finally:
        container.close()
    with av.open(str(output)) as check:
        decoded_count = sum(1 for _ in check.decode(check.streams.video[0]))
        duration = check.duration / av.time_base
    if decoded_count != len(rows):
        raise ValueError(f'Encoded {decoded_count} frames, expected {len(rows)}')
    return {'path': str(output), 'frames': decoded_count, 'durationSeconds': duration,
            'width': out_width, 'height': out_height, 'editedGaps': gap_limit is not None,
            'chronologyPreserved': True, 'interpolatedFrames': 0,
            'source': 'Actual Page.startScreencast JPEG frames with metadata timestamps',
            'redactionsCssPixels': [[730, 498, 1037, 593], [0, 0, 170, 420]],
            'sha256': hashlib.sha256(output.read_bytes()).hexdigest(), 'frameMapping': mapping}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--frames', default=str(ROOT / 'assets/instagram-frames'))
    parser.add_argument('--output', default=str(ROOT / 'assets/instagram-caption-recording.mp4'))
    parser.add_argument('--edited-output', default=str(ROOT / 'assets/instagram-caption-recording-edited.mp4'))
    args = parser.parse_args()
    directory, output, edited = Path(args.frames), Path(args.output), Path(args.edited_output)
    rows = json.loads((directory / 'timestamps.json').read_text(encoding='utf-8'))
    if not rows:
        raise ValueError('No actual screencast frames')
    output.parent.mkdir(parents=True, exist_ok=True)
    edited.parent.mkdir(parents=True, exist_ok=True)
    master = encode(rows, directory, output)
    montage = encode(rows, directory, edited, gap_limit=0.5)
    report = {'master': master, 'montage': montage,
              'note': 'Master retains original timestamps. Montage removes long capture gaps in chronological order; duplicated/generated browser actions are not introduced.'}
    (output.parent / 'capture-provenance.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps({'master': {k:v for k,v in master.items() if k != 'frameMapping'},
                      'montage': {k:v for k,v in montage.items() if k != 'frameMapping'}}, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()

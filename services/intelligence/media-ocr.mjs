/** One bounded clip request on stdin; one JSON result. No URLs or downloads. */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { access } from 'node:fs/promises';
import { existsSync } from 'node:fs';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repository = resolve(scriptDirectory, '../..');
const root = existsSync(resolve(repository, 'package.json')) ? repository : scriptDirectory;
const require = createRequire(resolve(root, 'package.json'));
const MAX_INPUT = 2 * 1024 * 1024;
const MIN_CONFIDENCE = 60;
let worker;
let emitted = false;
const emit = (value) => {
  if (!emitted) {
    emitted = true;
    process.stdout.write(`${JSON.stringify(value)}\n`);
  }
};
// Native/library chatter belongs off the JSON channel.
console.log = console.info = console.warn = console.error = () => {};
process.stdout.on('error', () => process.exit(1));
const timer = setTimeout(() => {
  emit({ status: 'unavailable', reason: 'ocr_timeout', frames: [] });
  process.exit(1);
}, 44_000);

function recognized(data) {
  const lines = [];
  let sum = 0;
  let count = 0;
  let length = 0;
  for (const block of data.blocks ?? []) {
    for (const paragraph of block.paragraphs ?? []) {
      for (const line of paragraph.lines ?? []) {
        const words = [];
        for (const word of line.words ?? []) {
          const text = typeof word.text === 'string' ? word.text.trim() : '';
          if (Number.isFinite(word.confidence) && word.confidence >= MIN_CONFIDENCE &&
              word.confidence <= 100 && /[\p{L}\p{N}]/u.test(text)) {
            if (length + text.length > 4000) continue;
            words.push(text);
            sum += word.confidence;
            count += 1;
            length += text.length + 1;
          }
        }
        if (words.length) lines.push(words.join(' '));
      }
    }
  }
  return { text: lines.join('\n').slice(0, 4000), confidence: count ? sum / count / 100 : 0 };
}

try {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    if (bytes > MAX_INPUT) throw new Error('input_limit');
    chunks.push(chunk);
  }
  const request = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!Array.isArray(request.frames) || request.frames.length < 1 || request.frames.length > 6) {
    throw new Error('invalid_frames');
  }
  const images = request.frames.map((encoded) => {
    if (typeof encoded !== 'string' || encoded.length > 400_000 ||
        !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) throw new Error('invalid_image');
    const image = Buffer.from(encoded, 'base64');
    if (image.length > 300_000 || image[0] !== 0xff || image[1] !== 0xd8) {
      throw new Error('invalid_image');
    }
    return image;
  });
  const langPath = resolve(root, 'public/ocr');
  await Promise.all(['eng', 'rus', 'kaz'].map((language) => access(resolve(langPath, `${language}.traineddata.gz`))));
  const { createWorker, PSM } = require('tesseract.js');
  worker = await createWorker(['eng', 'rus', 'kaz'], 1, {
    langPath, cacheMethod: 'none', gzip: true, logger: () => {},
    errorHandler: () => {},
  });
  await worker.setParameters({ tessedit_pageseg_mode: PSM.SPARSE_TEXT, user_defined_dpi: '150' });
  const frames = [];
  for (const image of images) {
    const { data } = await worker.recognize(image, {}, { text: true, blocks: true });
    frames.push(recognized(data));
  }
  emit({ status: 'completed', frames });
} catch {
  emit({ status: 'unavailable', reason: 'ocr_unavailable', frames: [] });
} finally {
  if (worker) await worker.terminate().catch(() => {});
  clearTimeout(timer);
}

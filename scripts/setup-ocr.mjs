import { mkdir, cp, copyFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';

const destination = resolve('public/ocr');
await mkdir(destination, {recursive: true});
await copyFile('node_modules/tesseract.js/dist/worker.min.js', resolve(destination, 'worker.min.js'));
await cp('node_modules/tesseract.js-core', resolve(destination, 'core'), {recursive:true});
for (const language of ['eng', 'rus', 'kaz']) {
  const base = resolve(`node_modules/@tesseract.js-data/${language}`);
  const folders = await readdir(base);
  const model = folders.find(name => name === '4.0.0_best_int') || folders.find(name => name.startsWith('4.'));
  if (!model) throw new Error(`No traineddata folder found for ${language}`);
  await copyFile(resolve(base, model, `${language}.traineddata.gz`), resolve(destination, `${language}.traineddata.gz`));
}
console.log('Local OCR assets ready: English, Russian, Kazakh. Images stay in your browser.');

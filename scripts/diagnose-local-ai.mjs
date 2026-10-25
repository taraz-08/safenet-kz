import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createAiService } from '../server/ai.mjs';
import { createMediaService } from '../server/media.mjs';

// Diagnostics accept ONLY these generated fixtures. Never captures a real user's
// browser frame, transcript, request body, token or arbitrary file path.
const fixtures = {
  slot: { name: 'synthetic-slot', kind: 'frame', path: 'qa/ai-fixtures/synthetic-slot.png', mimeType: 'image/png', endMs: 0, locale: 'ru' },
  house: { name: 'synthetic-house', kind: 'frame', path: 'qa/ai-fixtures/synthetic-house.png', mimeType: 'image/png', endMs: 0, locale: 'kk' },
  audio: { name: 'synthetic-spoken-promotion', kind: 'audio', path: 'qa/ai-synthetic-promo.wav', mimeType: 'audio/wav', endMs: 7743, locale: 'ru' },
};
const fixture = fixtures[process.argv[2] || 'slot'];
if (!fixture) throw new Error('Choose only slot, house or audio synthetic fixture.');
mkdirSync('qa', { recursive: true });
const ai = createAiService({ fetchImpl: async (url, options) => {
  const response = await fetch(url, options);
  if (url === 'http://127.0.0.1:11434/api/chat') {
    const raw = await response.clone().text();
    const payload = JSON.parse(options.body);
    writeFileSync(`qa/ai-raw-${fixture.name}.json`, JSON.stringify({ fixture: fixture.name, synthetic: true,
      recordedAt: new Date().toISOString(), httpStatus: response.status, options: payload.options, stream: payload.stream,
      think: payload.think, model: payload.model, body: raw.slice(0, 512 * 1024) }, null, 2));
  }
  return response;
} });
const media = createMediaService({ aiService: ai });
try {
  const result = await media.scan({ kind: fixture.kind, data: readFileSync(fixture.path).toString('base64'), mimeType: fixture.mimeType,
    url: 'https://www.instagram.com/reel/SYNTHETIC_TEST/', platform: 'instagram', startMs: 0, endMs: fixture.endMs, locale: fixture.locale });
  const report = { fixture: fixture.name, synthetic: true, recognizedText: result.recognizedText, coverage: result.coverage, ai: result.ai, score: result.analysis.score, evidence: result.evidence };
  writeFileSync(`qa/ai-diagnostic-${fixture.name}.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} finally { await media.close(); }

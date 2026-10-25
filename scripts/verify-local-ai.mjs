import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createAiService } from '../server/ai.mjs';
import { createMediaService } from '../server/media.mjs';

// Generated fixtures are intentionally separate from real monitoring cases.
const ai = createAiService();
const media = createMediaService({ aiService: ai });
const report = { createdAt: new Date().toISOString(), scope: 'Synthetic local fixtures; no live Instagram capture', status: await media.status(), results: [] };
mkdirSync('qa', { recursive: true });
try {
  for (const fixture of [
    { name: 'synthetic-slot', kind: 'frame', path: 'qa/ai-fixtures/synthetic-slot.png', mimeType: 'image/png', endMs: 0, locale: 'ru' },
    { name: 'synthetic-house', kind: 'frame', path: 'qa/ai-fixtures/synthetic-house.png', mimeType: 'image/png', endMs: 0, locale: 'kk' },
    { name: 'synthetic-spoken-promotion', kind: 'audio', path: 'qa/ai-synthetic-promo.wav', mimeType: 'audio/wav', endMs: 7743, locale: 'ru' },
  ]) {
    const started = Date.now();
    const result = await media.scan({ kind: fixture.kind, data: readFileSync(fixture.path).toString('base64'), mimeType: fixture.mimeType,
      url: 'https://www.instagram.com/reel/SYNTHETIC_TEST/', platform: 'instagram', startMs: 0, endMs: fixture.endMs, locale: fixture.locale });
    const row = { fixture: fixture.name, elapsedMs: Date.now() - started, recognizedText: result.recognizedText, coverage: result.coverage,
      ai: result.ai, score: result.analysis.score, evidence: result.evidence };
    report.results.push(row);
    writeFileSync('qa/ai-verification.json', JSON.stringify(report, null, 2));
    console.log(JSON.stringify(row));
  }
  report.runtimeModels = await (await fetch('http://127.0.0.1:11434/api/ps')).json();
  report.passed = report.results.every(row => row.ai?.ok)
    && report.results[0].ai.observations.some(item => ['slot_machine', 'casino_interface'].includes(item.kind))
    && report.results[1].ai.category === 'none' && report.results[1].score < 30
    && report.results[2].ai.category === 'gambling' && report.results[2].ai.promotional;
  writeFileSync('qa/ai-verification.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ passed: report.passed, output: 'qa/ai-verification.json' }));
  if (!report.passed) process.exitCode = 1;
} finally { await media.close(); }

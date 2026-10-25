import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { createMediaService } from '../server/media.mjs';

const service = createMediaService();
try {
  const result = await service.scan({ kind: 'frame', data: readFileSync('qa/qr-fixture.png').toString('base64'), mimeType: 'image/png',
    url: 'https://www.instagram.com/p/QR_SYNTHETIC_TEST/', platform: 'instagram', locale: 'ru', startMs: 4200, endMs: 4200 });
  assert.ok(result.qr.some(code => code.text === 'https://kaspi.kz.attacker.example/login'));
  assert.ok(result.evidence.some(item => item.kind === 'qr' && item.startMs === 4200));
  assert.ok(result.analysis.signals.some(signal => signal.id === 'brand_domain'));
  const report = { checkedAt: new Date().toISOString(), provenance: 'Synthetic QR fixture; real local OCR/OpenCV. No Instagram capture or remote URL request.', result };
  writeFileSync('qa/qr-verification.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ok: true, qrCount: result.qr.length, score: result.analysis.score, coverage: result.coverage }));
} finally { await service.close(); }

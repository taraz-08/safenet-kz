import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from './app.mjs';

// fetch() cannot set Host, so requests go through node:http to imitate a public domain.
function request(port, { path, method = 'GET', host = 'safenet.up.railway.app', body, auth }) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const headers = { host, ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}), ...(auth ? { authorization: `Basic ${Buffer.from(auth).toString('base64')}` } : {}) };
    const req = http.request({ hostname: '127.0.0.1', port, path, method, headers }, res => {
      let text = '';
      res.on('data', chunk => { text += chunk; });
      res.on('end', () => { let json = null; try { json = JSON.parse(text); } catch { /* html or empty */ } resolve({ status: res.statusCode, headers: res.headers, json }); });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function withApp(options, run) {
  const dir = mkdtempSync(join(tmpdir(), 'safenet-hosting-'));
  const app = createApp({ storePath: join(dir, 'cases.json'), seed: false, ...options });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  try { await run(server.address().port, app); } finally {
    server.close();
    for (const name of ['watchtower', 'pipeline', 'discovery', 'social']) app.locals[name]?.close?.();
    await app.locals.mediaService?.close?.();
    app.locals.aiService?.close?.();
    rmSync(dir, { recursive: true, force: true });
  }
}

test('a local install still refuses foreign hosts', async () => {
  await withApp({}, async port => {
    assert.equal((await request(port, { path: '/api/health' })).status, 403);
    assert.equal((await request(port, { path: '/api/health', host: '127.0.0.1' })).json.mode, 'local');
  });
});

test('a hosted install without an access key is a read-only public demo', async () => {
  await withApp({ hosted: true, allowedHosts: ['safenet.up.railway.app'] }, async (port, app) => {
    const health = await request(port, { path: '/api/health' });
    assert.equal(health.status, 200);
    assert.equal(health.json.mode, 'public_read_only');
    assert.equal((await request(port, { path: '/api/health', host: 'healthcheck.railway.app' })).status, 200);
    assert.equal((await request(port, { path: '/api/health', host: 'evil.example' })).status, 403);
    assert.equal((await request(port, { path: '/api/cases' })).status, 200);
    const analyzed = await request(port, { path: '/api/analyze', method: 'POST', body: { text: 'Вложи 5000 тг, получи 10000 тг завтра. Гарантированная прибыль. Пригласи двух друзей.' } });
    assert.equal(analyzed.status, 200);
    assert.equal(analyzed.json.stored, false);
    assert.ok(analyzed.json.analysis.score >= 30);
    assert.equal((await request(port, { path: '/api/cases' })).json.cases.length, 0, 'nothing is stored');
    for (const [method, path] of [['PATCH', '/api/cases/x'], ['POST', '/api/pipeline/reset'], ['PUT', '/api/social'], ['POST', '/api/discovery/seeds'], ['POST', '/api/inspect-link']]) {
      const refused = await request(port, { path, method, body: {} });
      assert.equal(refused.status, 403, `${method} ${path}`);
      assert.match(refused.json.error, /только для чтения/);
    }
    assert.equal(app.locals.social.snapshot().enabled, false);
  });
});

test('mixed-case API paths cannot bypass hosting and origin restrictions', async () => {
  await withApp({ hosted: true, allowedHosts: ['safenet.up.railway.app'] }, async port => {
    for (const path of ['/API/demo', '/Api/pipeline/reset', '/api/Social/run']) {
      assert.equal((await request(port, { path, method: 'POST', body: {} })).status, 403, path);
    }
    assert.equal((await request(port, { path: '/API/cases', host: 'evil.example' })).status, 403);
    assert.equal((await request(port, { path: '/api/cases' })).json.cases.length, 0);
  });
});

test('a hosted install with an access key asks for it everywhere except the health check', async () => {
  await withApp({ hosted: true, allowedHosts: ['safenet.up.railway.app'], accessKey: 'jury-2026' }, async port => {
    const locked = await request(port, { path: '/api/cases' });
    assert.equal(locked.status, 401);
    assert.match(locked.headers['www-authenticate'], /Basic/);
    assert.equal((await request(port, { path: '/api/cases', auth: 'jury:wrong' })).status, 401);
    assert.equal((await request(port, { path: '/api/health' })).status, 200);
    const open = await request(port, { path: '/api/health', auth: 'jury:jury-2026' });
    assert.equal(open.json.mode, 'hosted_private');
    const saved = await request(port, { path: '/api/analyze', method: 'POST', auth: 'jury:jury-2026', body: { text: 'Казино бонус 200% на депозит, промокод AZ777, фриспины' } });
    assert.equal(saved.status, 201);
    assert.equal((await request(port, { path: '/api/cases', auth: 'any:jury-2026' })).json.cases.length, 1);
  });
});

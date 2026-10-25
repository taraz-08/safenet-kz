import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from './app.mjs';
import { parseTelegramSeeds } from './discovery.mjs';

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
  try { await run(server.address().port, app, dir); } finally {
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

test('createApp merges deployment starting points with analyst and enabled Kazakhstan sources without persisting them', async () => {
  const telegramSeeds = parseTelegramSeeds('@Configured_Channel,analyst_channel');
  await withApp({ autoProfile: true, telegramSeeds }, async (_port, app, dir) => {
    const sources = app.locals.watchtower.snapshot().sources;
    assert.ok(sources.length > 0, 'the Kazakhstan reference profile is present');
    const snapshot = app.locals.discovery.addSeed('analyst_channel');
    assert.deepEqual(new Set(snapshot.configuredSeeds), new Set([...telegramSeeds, ...sources.filter(source => source.enabled).map(source => source.handle)]));
    assert.equal(snapshot.configuredSeeds.length, new Set(snapshot.configuredSeeds).size);
    assert.deepEqual(snapshot.seeds.map(seed => seed.handle), ['analyst_channel']);
    assert.deepEqual(app.locals.watchtower.snapshot().sources, sources, 'deployment starting points are not monitoring sources');
    const saved = JSON.parse(readFileSync(join(dir, 'discovery.json'), 'utf8'));
    assert.deepEqual(saved.seeds.map(seed => seed.handle), ['analyst_channel']);
    const disabled = sources.find(source => source.enabled);
    app.locals.watchtower.updateSource(disabled.id, { enabled: false });
    assert.ok(!app.locals.discovery.snapshot().configuredSeeds.includes(disabled.handle), 'disabled monitoring sources are still excluded');
    assert.ok(app.locals.discovery.snapshot().configuredSeeds.includes('configured_channel'));
  });
});

test('hosted read-only discovery processes deployment starting points and preserves findings after configuration removal', async () => {
  const handle = 'configured_channel';
  const telegramSeeds = parseTelegramSeeds(`@${handle},https://t.me/${handle}`);
  const fetched = [];
  const discoveryFetchPreview = async channel => {
    fetched.push(channel);
    return `<div class="tgme_widget_message" data-post="${channel}/1"><div class="tgme_widget_message_text">Поднял 380к за вечер. Промокод AZ777 даёт +150% к первому депу, ссылка в шапке профиля.</div></div>`;
  };
  await withApp({ hosted: true, telegramSeeds, discoveryFetchPreview }, async (port, app, dir) => {
    assert.equal((await request(port, { path: '/api/health' })).json.mode, 'public_read_only');
    const initial = await request(port, { path: '/api/discovery' });
    assert.equal(initial.status, 200);
    assert.deepEqual(initial.json.configuredSeeds, [handle]);
    assert.deepEqual(initial.json.seeds, []);
    assert.deepEqual(app.locals.watchtower.snapshot().sources, []);
    assert.deepEqual(fetched, [], 'configuration alone does not fetch channels');
    for (const [method, path, body] of [
      ['POST', '/api/discovery/seeds', { channel: 'visitor_channel' }],
      ['DELETE', `/api/discovery/seeds/${handle}`, undefined],
      ['PUT', '/api/discovery', { enabled: false }],
      ['POST', '/api/discovery/run', {}],
    ]) assert.equal((await request(port, { path, method, body })).status, 403, `${method} ${path}`);

    await app.locals.discovery.tick();
    assert.deepEqual(fetched, [handle], 'the server can process configured channels without public write access');
    const findings = (await request(port, { path: '/api/cases' })).json.cases;
    assert.equal(findings.length, 1);
    assert.equal(findings[0].source, 'telegram_discovery');
    assert.equal(findings[0].demo, false);
    assert.equal(findings[0].provenance.channel, handle);
    const saved = JSON.parse(readFileSync(join(dir, 'discovery.json'), 'utf8'));
    assert.deepEqual(saved.seeds, [], 'configured starting points never become analyst seeds');
    app.locals.discovery.close();

    await withApp({ hosted: true, storePath: join(dir, 'cases.json'), discoveryFetchPreview }, async restartPort => {
      const snapshot = (await request(restartPort, { path: '/api/discovery' })).json;
      assert.deepEqual(snapshot.configuredSeeds, []);
      assert.deepEqual(snapshot.seeds, []);
      assert.equal(snapshot.counts.channels, 1);
      assert.equal(snapshot.risky[0].handle, handle);
      assert.equal(snapshot.risky[0].checks, 1);
      assert.deepEqual((await request(restartPort, { path: '/api/cases' })).json.cases, findings);
    });
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

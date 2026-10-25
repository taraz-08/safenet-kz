import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.mjs';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'safenet-live-only-'));
  const storePath = join(dir, 'cases.json');
  const stops = [];
  t.after(async () => {
    for (const stop of stops) await stop();
    rmSync(dir, { recursive: true, force: true });
  });
  const start = async (options = {}) => {
    const app = createApp({ storePath, seed: false, aiService: { status: async () => ({}), close() {} }, mediaService: { close: async () => {} }, ...options });
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    let stopped = false;
    const stop = async () => {
      if (stopped) return;
      stopped = true;
      for (const name of ['watchtower', 'pipeline', 'discovery', 'social', 'aiService']) app.locals[name].close();
      await app.locals.mediaService.close();
      await new Promise(resolve => server.close(resolve));
    };
    stops.push(stop);
    const call = async (path, { method = 'GET', body, auth } = {}) => {
      const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
        method, headers: { 'content-type': 'application/json', ...(auth ? { authorization: `Basic ${Buffer.from(auth).toString('base64')}` } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const text = await response.text();
      let json = null;
      try { json = JSON.parse(text); } catch { /* HTML or empty response */ }
      return { status: response.status, json, text };
    };
    return { app, call, stop };
  };
  return { dir, storePath, start };
}

const genuine = (id, extra = {}) => ({
  id, source: 'telegram_discovery', demo: false, status: 'escalated', platform: 'telegram', author: `@fixture_${id}`,
  text: 'Previously collected public material', url: `https://t.me/fixture_${id}/1`, createdAt: '2026-10-25T00:00:00Z',
  analysisVersion: 'rules-v1', analysis: { score: 70, category: 'casino', signals: [], entities: { promoCodes: ['SHARED777'] } },
  review: { decision: 'escalated', reason: 'signs_confirmed', note: 'Keep this analyst decision', secondsToDecision: 45 },
  ...extra,
});

test('live-only archives once and removes only demo===true, preserving genuine cases and reviews across restarts', async t => {
  const { storePath, start } = fixture(t);
  const unmarked = genuine('unmarked', { source: 'pipeline', status: 'dismissed' });
  delete unmarked.demo;
  delete unmarked.analysisVersion;
  const kept = [genuine('reviewed'), unmarked, genuine('non_boolean', { demo: 'true' })];
  const original = JSON.stringify([...kept, genuine('demo_reviewed', { demo: true }), genuine('demo_new', { demo: true, status: 'new' })], null, 4);
  writeFileSync(storePath, original);
  const backup = `${storePath}.pre-live-only.bak`;
  const first = await start({ hosted: true, seed: true, autoProfile: false });
  assert.equal((await first.call('/api/health')).json.liveOnly, true);
  assert.deepEqual((await first.call('/api/cases')).json.cases, kept);
  assert.deepEqual(JSON.parse(readFileSync(storePath, 'utf8')), kept);
  assert.equal(readFileSync(backup, 'utf8'), original, 'archive contains the exact pre-conversion bytes');
  await first.stop();

  const later = [...kept, genuine('later'), genuine('later_demo', { demo: true })];
  writeFileSync(storePath, JSON.stringify(later));
  const second = await start({ hosted: true, seed: true, autoProfile: false });
  assert.deepEqual((await second.call('/api/cases')).json.cases, later.filter(record => record.demo !== true));
  assert.equal(readFileSync(backup, 'utf8'), original, 'restart never replaces the original archive');
});

test('hosted startup never seeds or resumes synthetic replay and never exposes old replay statistics', async t => {
  const { dir, storePath, start } = fixture(t);
  const replayPath = join(dir, 'pipeline.json');
  const savedReplay = JSON.stringify({ enabled: true, rate: 50, runId: 'old-demo-run', cursor: 1, processed: 123, queued: 99, cleared: 24, log: [{ preview: 'old synthetic sentinel', category: 'casino', groundTruth: 'casino' }] });
  writeFileSync(replayPath, savedReplay);
  for (let restart = 0; restart < 2; restart++) {
    const instance = await start({ hosted: true, seed: true, autoProfile: false, autoPipeline: true });
    instance.app.locals.pipeline.start();
    const snapshot = (await instance.call('/api/pipeline?limit=400')).json;
    assert.deepEqual(snapshot, { liveOnly: true, enabled: false, running: false, finished: false, total: 0, processed: 0, queued: 0, cleared: 0, log: [], corpus: null, streamQuality: null });
    for (const mutate of [() => instance.app.locals.pipeline.update({ enabled: true }), () => instance.app.locals.pipeline.reset(), () => instance.app.locals.pipeline.step(200)]) {
      assert.throws(mutate, error => error.status === 403);
    }
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.deepEqual((await instance.call('/api/cases')).json.cases, []);
    assert.equal(existsSync(storePath), false, 'an empty hosted install never writes demo cases');
    assert.equal(readFileSync(replayPath, 'utf8'), savedReplay, 'saved replay remains unused and untouched');
    await instance.stop();
  }
});

test('live-only blocks synthetic mutations even with a private access key and networks follow genuine cases', async t => {
  const { storePath, start } = fixture(t);
  const kept = [genuine('first'), genuine('second')];
  writeFileSync(storePath, JSON.stringify([...kept, genuine('demo', { demo: true })]));
  const { call } = await start({ hosted: true, accessKey: 'fixture-key' });
  const auth = 'jury:fixture-key';
  const health = (await call('/api/health')).json;
  assert.equal(health.mode, 'hosted_private');
  assert.equal(health.liveOnly, true);
  for (const [method, path, body] of [
    ['POST', '/api/demo', {}], ['PUT', '/api/pipeline', { enabled: true }],
    ['POST', '/api/pipeline/reset', {}], ['POST', '/api/pipeline/step', { count: 200 }],
    ['POST', '/API/Demo/', {}], ['POST', '/API/Pipeline/Step/', {}],
  ]) assert.equal((await call(path, { method, body, auth })).status, 403, `${method} ${path}`);
  assert.deepEqual((await call('/api/cases', { auth })).json.cases, kept);
  const networks = (await call('/api/networks', { auth })).json;
  assert.equal(networks.networks[0].size, 2);
  assert.equal(networks.networks[0].shared[0].value, 'SHARED777');
  assert.deepEqual(new Set(networks.accounts.map(account => account.handle)), new Set(kept.map(record => record.author)));
  assert.equal((await call(`/api/cases/${kept[1].id}`, { method: 'DELETE', auth })).status, 200);
  assert.equal((await call('/api/networks', { auth })).json.accounts.length, 1, 'networks use the current genuine case store');
});

test('live-only hides explicit and static demo routes while keeping the pitch accessible', async t => {
  const { dir, start } = fixture(t);
  writeFileSync(join(dir, 'demo-feed.html'), 'synthetic feed sentinel');
  for (const accessKey of [null, 'fixture-key']) {
    const { app, call, stop } = await start({ hosted: true, accessKey });
    app.get('/demo-feed', (_req, res) => res.send('synthetic feed sentinel'));
    app.get('/demo/content.js', (_req, res) => res.send('synthetic script sentinel'));
    app.get('/pitch', (_req, res) => res.send('pitch deliverable'));
    app.use(express.static(dir));
    for (const path of ['/demo-feed', '/demo/content.js', '/demo-feed.html', '/demo-feed.html?cache=1', '/DEMO-FEED.HTML/', '/%64emo-feed.html', '//demo-feed.html']) {
      assert.equal((await call(path)).status, 404, path);
      if (accessKey) assert.equal((await call(path, { auth: 'jury:fixture-key' })).status, 404, path);
    }
    assert.equal((await call('/pitch', { auth: accessKey ? 'jury:fixture-key' : undefined })).status, 200);
    await stop();
  }
});

test('local mode keeps demo seeding and replay, and live-only can be selected explicitly offline', async t => {
  const { start } = fixture(t);
  const local = await start({ seed: true, autoProfile: false });
  assert.equal((await local.call('/api/health')).json.liveOnly, false);
  const demoCases = (await local.call('/api/cases')).json.cases;
  assert.ok(demoCases.length > 0);
  assert.ok(demoCases.every(record => record.demo === true));
  assert.equal((await local.call('/api/demo', { method: 'POST', body: {} })).status, 200);
  assert.equal((await local.call('/api/pipeline/step', { method: 'POST', body: { count: 1 } })).json.processed, 1);
  await local.stop();
  const live = await start({ liveOnly: true });
  assert.equal((await live.call('/api/health')).json.liveOnly, true);
  assert.deepEqual((await live.call('/api/cases')).json.cases, []);
});

test('social opt-in defaults off, overrides saved state before scheduling, and undefined preserves it', async t => {
  const { dir, start } = fixture(t);
  let searches = 0, opens = 0;
  const options = { hosted: true, socialSearch: async () => { searches++; return { status: 200, html: '' }; }, socialOpenProfile: async () => { opens++; return { status: 'unavailable' }; } };
  const fresh = await start(options);
  assert.equal(fresh.app.locals.social.snapshot().enabled, false);
  assert.deepEqual(await fresh.app.locals.social.tick(), { skipped: true });
  await fresh.stop();
  for (const [socialEnabled, expected] of [[true, true], [undefined, true], [false, false], [undefined, false]]) {
    const instance = await start({ ...options, socialEnabled });
    assert.equal(instance.app.locals.social.snapshot().enabled, expected);
    assert.equal((await instance.call('/api/social')).json.enabled, expected);
    assert.equal((await instance.call('/api/social', { method: 'PUT', body: { enabled: !expected } })).status, 403);
    const priorSearches = searches;
    if (expected) assert.equal((await instance.app.locals.social.tick()).skipped, undefined);
    else {
      assert.deepEqual(await instance.app.locals.social.tick(), { skipped: true });
      assert.equal(searches, priorSearches);
    }
    assert.equal(JSON.parse(readFileSync(join(dir, 'social-discovery.json'), 'utf8')).enabled, expected);
    await instance.stop();
  }
  assert.equal(searches, 1, 'enabled search uses the stub and preserves its cooldown across restarts');
  assert.equal(opens, 0);
});

test('index rejects invalid social opt-in values before starting services', t => {
  const { dir } = fixture(t);
  for (const value of ['', 'true', '2']) {
    const child = spawnSync(process.execPath, [fileURLToPath(new URL('./index.mjs', import.meta.url))], {
      cwd: dir, env: { ...process.env, SAFENET_TELEGRAM_SEEDS: '', SAFENET_SOCIAL_ENABLED: value }, encoding: 'utf8', timeout: 10000, windowsHide: true,
    });
    assert.equal(child.status, 1);
    assert.match(child.stderr, /SAFENET_SOCIAL_ENABLED must be 1 or 0/);
    assert.equal(existsSync(join(dir, 'data')), false);
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from './app.mjs';
import { ADMIN_AUTH_LIMITS } from './admin-auth.mjs';

async function fixture(t, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'safenet-admin-'));
  const adminCode = randomBytes(24).toString('hex');
  const app = createApp({ storePath: join(dir, 'cases.json'), seed: false, hosted: true, allowedHosts: ['safenet.example'], adminCode,
    aiService: { status: async () => ({}), close() {} }, mediaService: { close: async () => {} }, ...options });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => {
    for (const name of ['watchtower', 'pipeline', 'discovery', 'social', 'aiService']) app.locals[name].close();
    await app.locals.mediaService.close();
    await new Promise(resolve => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  });
  const call = (path, { method = 'GET', body, raw, cookie, headers = {} } = {}) => new Promise((resolve, reject) => {
    const payload = raw ?? (body === undefined ? null : JSON.stringify(body));
    const req = http.request({ hostname: '127.0.0.1', port: server.address().port, path, method, headers: {
      host: options.hosted === false ? '127.0.0.1' : 'safenet.example',
      ...(payload === null ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }),
      ...(cookie ? { cookie } : {}), ...headers,
    } }, res => {
      let text = '';
      res.on('data', chunk => { text += chunk; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(text); } catch { /* Basic challenge or non-JSON response */ }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on('error', reject);
    if (payload !== null) req.write(payload);
    req.end();
  });
  return { adminCode: options.adminCode ?? adminCode, app, call };
}
const cookieOf = response => response.headers['set-cookie']?.[0]?.split(';')[0];
const basic = key => ({ authorization: `Basic ${Buffer.from(`jury:${key}`).toString('base64')}` });

test('admin login uses secure opaque cookies and unlocks only the current request', async t => {
  const { adminCode, call } = await fixture(t);
  assert.deepEqual((await call('/api/auth/session')).json, { enabled: true, authenticated: false, expiresAt: null });
  const health = (await call('/api/health')).json;
  assert.equal(health.mode, 'public_read_only');
  assert.equal(health.adminLoginEnabled, true);
  assert.equal(health.adminSessionExpiresAt, null);
  assert.equal((await call('/api/auth/login', { method: 'POST', body: { code: `${adminCode}wrong` } })).status, 401);
  assert.equal((await call('/api/auth/login', { method: 'POST', body: { code: { role: 'admin' } } })).status, 401);
  const login = await call('/api/auth/login', { method: 'POST', body: { code: adminCode }, headers: { 'x-forwarded-proto': 'http' } });
  assert.equal(login.status, 200);
  assert.deepEqual(Object.keys(login.json).sort(), ['authenticated', 'expiresAt']);
  assert.equal(login.json.authenticated, true);
  const cookie = cookieOf(login), setCookie = login.headers['set-cookie'][0];
  assert.match(cookie, /^__Host-safenet_admin=[A-Za-z0-9_-]{43}$/);
  for (const flag of ['HttpOnly', 'Secure', 'SameSite=Strict', 'Path=/', 'Max-Age=28800']) assert.ok(setCookie.includes(flag), flag);
  assert.ok(!/Domain=/i.test(setCookie));
  assert.equal(login.headers['cache-control'], 'no-store');
  assert.ok(!login.text.includes(adminCode));
  assert.ok(!login.text.includes(cookie.split('=')[1]));
  const [guest, admin] = await Promise.all([call('/api/health'), call('/api/health', { cookie })]);
  assert.equal(guest.json.mode, 'public_read_only');
  assert.equal(admin.json.mode, 'hosted_admin');
  assert.equal(admin.json.adminSessionExpiresAt, login.json.expiresAt);
  assert.deepEqual((await call('/api/auth/session', { cookie })).json, { enabled: true, authenticated: true, expiresAt: login.json.expiresAt });
  assert.equal((await call('/api/social', { method: 'PUT', body: { enabled: true } })).status, 403);
  assert.equal((await call('/api/social', { method: 'PUT', body: { enabled: true }, cookie })).status, 200);
  assert.equal((await call('/api/discovery/seeds', { method: 'POST', body: { channel: 'fixture_channel' }, cookie })).status, 200);
  const input = { text: 'Public text submitted for manual review.', role: 'admin', authenticated: true, code: adminCode };
  const guestAnalysis = await call('/api/analyze', { method: 'POST', body: input });
  assert.equal(guestAnalysis.status, 200);
  assert.equal(guestAnalysis.json.stored, false);
  assert.equal((await call('/api/cases')).json.cases.length, 0);
  const saved = await call('/api/analyze', { method: 'POST', body: input, cookie });
  assert.equal(saved.status, 201);
  assert.equal((await call('/api/cases')).json.cases[0].id, saved.json.id);
  assert.equal((await call(`/api/cases/${saved.json.id}`, { method: 'PATCH', body: { status: 'reviewing' }, cookie })).status, 200);
  assert.equal((await call(`/api/cases/${saved.json.id}`, { method: 'DELETE' })).status, 403);
  for (const path of ['/api/demo', '/api/pipeline/step', '/api/pipeline/reset']) assert.equal((await call(path, { method: 'POST', body: {}, cookie })).status, 403, path);
  assert.equal((await call('/api/pipeline', { method: 'PUT', body: { enabled: true }, cookie })).status, 403);
  assert.equal((await call('/demo-feed.html', { cookie })).status, 404);
});

test('logout revokes replay and rotation, failed login and other visitors never revoke another session', async t => {
  const { adminCode, call } = await fixture(t);
  const login = cookie => call('/api/auth/login', { method: 'POST', body: { code: adminCode }, cookie });
  const first = cookieOf(await login()), second = cookieOf(await login());
  assert.notEqual(first, second);
  assert.equal((await call('/api/auth/login', { method: 'POST', body: { code: 'wrong' }, cookie: first })).status, 401);
  assert.equal((await call('/api/auth/session', { cookie: first })).json.authenticated, true);
  const rotated = cookieOf(await login(first));
  assert.notEqual(rotated, first);
  assert.equal((await call('/api/auth/session', { cookie: first })).json.authenticated, false);
  assert.equal((await call('/api/auth/session', { cookie: second })).json.authenticated, true);
  assert.equal((await call('/api/auth/logout', { method: 'POST', body: { token: second } })).status, 200);
  const logout = await call('/api/auth/logout', { method: 'POST', cookie: rotated, body: { token: second } });
  assert.deepEqual(logout.json, { authenticated: false });
  assert.match(logout.headers['set-cookie'][0], /^__Host-safenet_admin=;/);
  assert.match(logout.headers['set-cookie'][0], /Expires=Thu, 01 Jan 1970/);
  assert.match(logout.headers['set-cookie'][0], /HttpOnly.*Secure.*SameSite=Strict/);
  assert.equal((await call('/api/social', { method: 'PUT', cookie: rotated, body: { enabled: true } })).status, 403);
  assert.equal((await call('/api/auth/session', { cookie: second })).json.authenticated, true);
  const ambiguous = `${rotated}; ${second}`;
  assert.equal((await call('/api/auth/session', { cookie: ambiguous })).json.authenticated, false);
  await call('/api/auth/logout', { method: 'POST', cookie: ambiguous });
  assert.equal((await call('/api/auth/session', { cookie: second })).json.authenticated, true);
  assert.equal((await call('/api/auth/session', { cookie: '__Host-safenet_admin=malformed' })).json.authenticated, false);
});

test('sessions expire after eight hours without sliding and a new app cannot replay old cookies', async t => {
  const start = Date.now();
  t.mock.timers.enable({ apis: ['Date'], now: start });
  const { adminCode, call } = await fixture(t);
  const login = await call('/api/auth/login', { method: 'POST', body: { code: adminCode } });
  const cookie = cookieOf(login);
  assert.equal(Date.parse(login.json.expiresAt), start + ADMIN_AUTH_LIMITS.ttlMs);
  const restarted = await fixture(t, { adminCode });
  assert.equal((await restarted.call('/api/auth/session', { cookie })).json.authenticated, false);
  t.mock.timers.setTime(start + ADMIN_AUTH_LIMITS.ttlMs - 1);
  assert.equal((await call('/api/auth/session', { cookie })).json.expiresAt, login.json.expiresAt);
  t.mock.timers.setTime(start + ADMIN_AUTH_LIMITS.ttlMs);
  assert.deepEqual((await call('/api/auth/session', { cookie })).json, { enabled: true, authenticated: false, expiresAt: null });
  const health = (await call('/api/health', { cookie })).json;
  assert.equal(health.mode, 'public_read_only');
  assert.equal(health.adminSessionExpiresAt, null);
  assert.equal((await call('/api/social', { method: 'PUT', cookie, body: { enabled: true } })).status, 403);
  const analyzed = await call('/api/analyze', { method: 'POST', cookie, body: { text: 'No longer authenticated.' } });
  assert.equal(analyzed.status, 200);
  assert.equal(analyzed.json.stored, false);
});

test('host, Origin and Fetch-Site checks protect mixed-case login/logout before attempts or cookie changes', async t => {
  const { adminCode, call } = await fixture(t);
  const body = { code: adminCode };
  const goodHeaders = { origin: 'https://safenet.example', 'sec-fetch-site': 'same-origin' };
  const cookie = cookieOf(await call('/API/Auth/Login/', { method: 'POST', body, headers: goodHeaders }));
  assert.equal((await call('/Api/Auth/Session/', { cookie })).json.authenticated, true);
  for (const path of ['/api/auth/login', '/API/Auth/Logout/']) {
    for (const headers of [
      { origin: 'https://attacker.example' }, { origin: 'null' }, { origin: `chrome-extension://${'a'.repeat(32)}` },
      { 'sec-fetch-site': 'cross-site' }, { ...goodHeaders, 'sec-fetch-site': 'cross-site' },
      { host: 'evil.example', 'x-forwarded-host': 'safenet.example' },
    ]) {
      const denied = await call(path, { method: 'POST', body, cookie, headers });
      assert.equal(denied.status, 403, path);
      assert.equal(denied.headers['set-cookie'], undefined);
    }
  }
  assert.equal((await call('/api/auth/session', { cookie })).json.authenticated, true);
  assert.equal((await call('/api/auth/login', { method: 'POST', body, headers: goodHeaders })).status, 200, 'denied origins never consume login attempts');
  assert.equal((await call('/Api/Social/', { method: 'PUT', body: { enabled: true } })).status, 403);
  assert.equal((await call('/Api/Social/', { method: 'PUT', body: { enabled: true }, cookie })).status, 200);
  assert.equal((await call('/API/Auth/Logout/', { method: 'POST', cookie, headers: goodHeaders })).status, 200);
  assert.equal((await call('/API/Health/', { cookie })).json.mode, 'public_read_only');
});

test('client roles and forwarding headers cannot grant admin access', async t => {
  const { call } = await fixture(t);
  const headers = { 'x-forwarded-for': '127.0.0.1', 'x-forwarded-host': 'localhost', 'x-forwarded-proto': 'https', 'x-admin-role': 'admin', authorization: 'Bearer admin' };
  const body = { enabled: true, role: 'admin', authenticated: true };
  assert.equal((await call('/api/social', { method: 'PUT', headers, body })).status, 403);
  assert.equal((await call('/api/health?role=admin', { headers })).json.mode, 'public_read_only');
});

test('login attempts are bounded, cannot use forwarded IPs to escape throttling and do not disable existing sessions', async t => {
  const start = Date.now();
  t.mock.timers.enable({ apis: ['Date'], now: start });
  const { adminCode, call } = await fixture(t);
  const cookie = cookieOf(await call('/api/auth/login', { method: 'POST', body: { code: adminCode } }));
  for (let i = 1; i < ADMIN_AUTH_LIMITS.attemptsPerPeer; i++) {
    assert.equal((await call('/api/auth/login', { method: 'POST', body: { code: 'wrong' }, headers: { 'x-forwarded-for': `192.0.2.${i}` } })).status, 401);
  }
  const denied = await call('/api/auth/login', { method: 'POST', body: { code: adminCode }, headers: { 'x-forwarded-for': '198.51.100.1' } });
  assert.equal(denied.status, 429);
  assert.equal(Number(denied.headers['retry-after']), ADMIN_AUTH_LIMITS.windowMs / 1000);
  assert.equal((await call('/api/health', { cookie })).json.mode, 'hosted_admin');
  assert.equal((await call('/api/auth/logout', { method: 'POST', cookie })).status, 200);
  t.mock.timers.setTime(start + ADMIN_AUTH_LIMITS.windowMs);
  assert.equal((await call('/api/auth/login', { method: 'POST', body: { code: adminCode } })).status, 200);
});

test('session capacity refuses a new user instead of evicting existing users, and expired slots are reclaimed', async t => {
  const start = Date.now();
  t.mock.timers.enable({ apis: ['Date'], now: start });
  const { adminCode, call } = await fixture(t);
  const cookies = [];
  for (let i = 0; i < ADMIN_AUTH_LIMITS.sessions; i++) {
    t.mock.timers.setTime(start + Math.floor(i / ADMIN_AUTH_LIMITS.attemptsPerPeer) * ADMIN_AUTH_LIMITS.windowMs);
    const login = await call('/api/auth/login', { method: 'POST', body: { code: adminCode } });
    assert.equal(login.status, 200);
    cookies.push(cookieOf(login));
  }
  assert.equal((await call('/api/auth/login', { method: 'POST', body: { code: adminCode } })).status, 503);
  assert.equal((await call('/api/auth/session', { cookie: cookies[0] })).json.authenticated, true);
  assert.equal((await call('/api/auth/session', { cookie: cookies[1] })).json.authenticated, true);
  const rotated = await call('/api/auth/login', { method: 'POST', body: { code: adminCode }, cookie: cookies[0] });
  assert.equal(rotated.status, 200, 'an existing user may rotate at capacity');
  assert.equal((await call('/api/auth/session', { cookie: cookies[1] })).json.authenticated, true);
  t.mock.timers.setTime(start + 2 * ADMIN_AUTH_LIMITS.ttlMs);
  assert.equal((await call('/api/auth/login', { method: 'POST', body: { code: adminCode } })).status, 200);
});

test('authentication bodies are bounded and parser errors never echo submitted secrets', async t => {
  const { adminCode, call } = await fixture(t);
  for (const path of ['/api/auth/login', '/API/Auth/Logout/']) {
    const huge = await call(path, { method: 'POST', body: { code: adminCode, extra: 'x'.repeat(ADMIN_AUTH_LIMITS.bodyBytes) } });
    assert.equal(huge.status, 413);
    assert.ok(!huge.text.includes(adminCode));
    const malformed = await call(path, { method: 'POST', raw: `{"code":"${adminCode}` });
    assert.equal(malformed.status, 400);
    assert.ok(!malformed.text.includes(adminCode));
  }
  assert.equal((await call('/api/auth/login', { method: 'POST', raw: `code=${adminCode}`, headers: { 'content-type': 'application/x-www-form-urlencoded' } })).status, 415);
  assert.equal((await call('/api/auth/login', { method: 'POST', body: {} })).status, 401);
});

test('unconfigured login reports disabled, while local and Basic-protected access keep their legacy behavior', async t => {
  const disabled = await fixture(t, { adminCode: null });
  assert.deepEqual((await disabled.call('/api/auth/session')).json, { enabled: false, authenticated: false, expiresAt: null });
  assert.equal((await disabled.call('/api/health')).json.adminLoginEnabled, false);
  assert.equal((await disabled.call('/api/auth/login', { method: 'POST', body: { code: 'anything' } })).status, 503);
  assert.deepEqual((await disabled.call('/api/auth/logout', { method: 'POST' })).json, { authenticated: false });
  const local = await fixture(t, { hosted: false });
  assert.equal((await local.call('/api/health')).json.mode, 'local');
  assert.equal((await local.call('/api/analyze', { method: 'POST', body: { text: 'Local saved material.' } })).status, 201);
  const localLogin = await local.call('/api/auth/login', { method: 'POST', body: { code: local.adminCode } });
  assert.match(cookieOf(localLogin), /^safenet_admin=/);
  assert.ok(!localLogin.headers['set-cookie'][0].includes('; Secure'));
  assert.equal((await local.call('/api/health', { cookie: cookieOf(localLogin) })).json.mode, 'local');
  const accessKey = randomBytes(24).toString('hex');
  const privateApp = await fixture(t, { accessKey });
  const headers = basic(accessKey);
  assert.equal((await privateApp.call('/api/health')).json.mode, 'hosted_private');
  assert.equal((await privateApp.call('/api/auth/login', { method: 'POST', body: { code: privateApp.adminCode } })).status, 401);
  const privateLogin = await privateApp.call('/api/auth/login', { method: 'POST', body: { code: privateApp.adminCode }, headers });
  const cookie = cookieOf(privateLogin);
  assert.equal(privateLogin.status, 200);
  assert.equal((await privateApp.call('/api/cases', { cookie })).status, 401, 'an admin cookie never bypasses the whole-site Basic gate');
  assert.equal((await privateApp.call('/api/cases', { cookie, headers: basic('wrong') })).status, 401);
  assert.equal((await privateApp.call('/api/health', { cookie, headers })).json.mode, 'hosted_admin');
  assert.equal((await privateApp.call('/api/analyze', { method: 'POST', body: { text: 'Legacy private save.' }, headers })).status, 201);
  assert.equal((await privateApp.call('/api/auth/logout', { method: 'POST', cookie, headers })).status, 200);
  assert.equal((await privateApp.call('/api/health', { headers })).json.mode, 'hosted_private');
  assert.equal((await privateApp.call('/api/demo', { method: 'POST', body: {}, cookie, headers })).status, 403);
});

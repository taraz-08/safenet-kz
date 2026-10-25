import test from 'node:test';
import assert from 'node:assert/strict';
import { getMetaLibraryStatus, searchMetaLibrary, META_LIBRARY_LIMITS } from './meta-library.mjs';

const token = 'fixture-secret-token-not-real';
const env = { SAFENET_META_ACCESS_TOKEN: token, SAFENET_META_API_VERSION: 'v99.0' };
const query = { query: 'education', country: 'KZ', adType: 'POLITICAL_AND_ISSUE_ADS' };
const json = (payload, options) => new Response(JSON.stringify(payload), { headers: { 'content-type': 'application/json' }, ...options });
const record = { id: '123456789', page_id: '99', page_name: 'Example advertiser', ad_creative_bodies: ['Educational services'], publisher_platforms: ['FACEBOOK', 'INSTAGRAM'] };

test('status is truthful for missing, partial, invalid and configured env without claiming verified access', () => {
  assert.equal(getMetaLibraryStatus({ env: {} }).status, 'not_configured');
  assert.equal(getMetaLibraryStatus({ env: { SAFENET_META_ACCESS_TOKEN: token } }).configured, false);
  assert.equal(getMetaLibraryStatus({ env: { SAFENET_META_API_VERSION: 'v99.0' } }).configured, false);
  for (const version of ['latest', 'v99.1', '99.0', 'v99.0/../../secret', 'https://evil.example']) {
    assert.equal(getMetaLibraryStatus({ env: { ...env, SAFENET_META_API_VERSION: version } }).status, 'invalid_configuration');
  }
  const status = getMetaLibraryStatus({ env });
  assert.equal(status.configured, true);
  assert.equal(status.status, 'configured');
  assert.equal(status.accessVerified, false);
  assert.equal(status.apiVersion, 'v99.0');
  assert.equal(JSON.stringify(status).includes(token), false);
  assert.equal(status.scope.allCountries.includes('GB'), true);
  assert.equal(status.scope.allCountries.includes('KZ'), false);
});

test('requires explicit configuration and validates scope before any request', async () => {
  let called = false;
  const fetch = async () => { called = true; return json({ data: [] }); };
  await assert.rejects(searchMetaLibrary(query, { env: {}, fetch }), { code: 'NOT_CONFIGURED' });
  await assert.rejects(searchMetaLibrary(query, { env: { ...env, SAFENET_META_API_VERSION: 'latest' }, fetch }), { code: 'INVALID_CONFIGURATION' });
  await assert.rejects(searchMetaLibrary({ ...query, adType: 'ALL' }, { env, fetch }), { code: 'UNSUPPORTED_SCOPE' });
  await assert.rejects(searchMetaLibrary({ ...query, country: 'US', adType: 'ALL' }, { env, fetch }), { code: 'UNSUPPORTED_SCOPE' });
  assert.equal(called, false);
});

test('validates known ISO countries, documented search length, control characters and ad type', async () => {
  const bad = [{ country: 'ZZ' }, { country: 'UK' }, { country: 'KAZ' }, { query: '' }, { query: 'a'.repeat(101) }, { query: 'x\ny' }, { adType: 'anything' }, { query: token }];
  for (const value of bad) await assert.rejects(searchMetaLibrary({ ...query, ...value }, { env, fetch: async () => { throw new Error('MUST NOT CALL'); } }), { code: 'INVALID_QUERY' });
});

test('uses fixed Graph endpoint, bearer header, known fields, one page and no token in query', async () => {
  let calls = 0;
  const result = await searchMetaLibrary(query, { env, fetch: async (url, options) => {
    calls++;
    assert.equal(url.origin, 'https://graph.facebook.com');
    assert.equal(url.pathname, '/v99.0/ads_archive');
    assert.equal(url.href.includes(token), false);
    assert.equal(url.searchParams.has('access_token'), false);
    assert.equal(url.searchParams.get('search_terms'), 'education');
    assert.equal(url.searchParams.get('ad_reached_countries'), '["KZ"]');
    assert.equal(url.searchParams.get('limit'), '25');
    assert.ok(url.searchParams.get('fields').includes('ad_creative_bodies'));
    assert.equal(options.headers.Authorization, `Bearer ${token}`);
    assert.equal(options.redirect, 'error');
    assert.equal(options.credentials, 'omit');
    assert.equal(options.method, 'GET');
    return json({ data: [{ ...record, ad_snapshot_url: `https://www.facebook.com/ads/archive/render_ad/?id=123456789&access_token=${token}`, debugToken: token }], paging: { next: `http://127.0.0.1/private?access_token=${token}` } });
  } });
  assert.equal(calls, 1);
  assert.equal(result.hasMore, true);
  assert.equal(result.pageLimit, 1);
  assert.equal(result.records[0].source, 'meta_ad_library');
  assert.equal(result.records[0].platform, 'instagram');
  assert.deepEqual(result.records[0].platforms, ['facebook', 'instagram']);
  assert.equal(result.records[0].url, 'https://www.facebook.com/ads/archive/render_ad/?id=123456789');
  assert.equal(JSON.stringify(result).includes(token), false);
  assert.equal(JSON.stringify(result).includes('127.0.0.1'), false);
});

test('allows ALL only for verified EU/UK set and permits KZ political scope', async () => {
  for (const country of ['DE', 'FR', 'GB', 'MT']) {
    const result = await searchMetaLibrary({ ...query, country, adType: 'ALL' }, { env, fetch: async () => json({ data: [] }) });
    assert.equal(result.country, country);
    assert.equal(result.adType, 'ALL');
  }
  const result = await searchMetaLibrary(query, { env, fetch: async () => json({ data: [] }) });
  assert.equal(result.country, 'KZ');
});

test('sanitizes records, deduplicates text, caps at25 and never returns arbitrary provider fields', async () => {
  const records = Array.from({ length: 30 }, (_, index) => ({ ...record, id: String(index + 1), ad_creative_bodies: ['A', 'A', token], ad_creative_link_titles: ['B'], page_name: token, ad_snapshot_url: 'javascript:alert(1)' }));
  const result = await searchMetaLibrary(query, { env, fetch: async () => json({ data: records }) });
  assert.equal(result.count, 25);
  assert.equal(result.hasMore, true);
  assert.equal(result.records[0].text, 'A\n[REDACTED]\nB');
  assert.equal(result.records[0].author, '[REDACTED]');
  assert.equal(JSON.stringify(result).includes(token), false);
  assert.equal(result.records[0].url.startsWith('https://www.facebook.com/ads/archive/render_ad/'), true);
});

test('never exposes raw upstream error bodies or thrown credential-bearing transport errors', async () => {
  const responses = [
    async () => { throw new Error(`request failed ${token}`); },
    async () => json({ error: { message: token } }, { status: 401 }),
    async () => json({ error: { message: token } }, { status: 500 }),
    async () => json({ error: { message: token } }),
    async () => new Response(token),
  ];
  for (const fetch of responses) {
    await assert.rejects(searchMetaLibrary(query, { env, fetch }), cause => {
      assert.equal(cause.message.includes(token), false);
      assert.equal(JSON.stringify(cause).includes(token), false);
      return ['UPSTREAM_ERROR', 'UPSTREAM_AUTH', 'INVALID_RESPONSE'].includes(cause.code);
    });
  }
});

test('rejects redirects without following them', async () => {
  let calls = 0;
  await assert.rejects(searchMetaLibrary(query, { env, fetch: async () => {
    calls++; return new Response('', { status: 302, headers: { location: 'https://evil.example' } });
  } }), { code: 'UPSTREAM_ERROR' });
  assert.equal(calls, 1);
});

test('bounds responses by actual streamed bytes and declared content length', async () => {
  await assert.rejects(searchMetaLibrary(query, { env, fetch: async () => new Response('x'.repeat(META_LIBRARY_LIMITS.responseBytes + 1)) }), { code: 'RESPONSE_TOO_LARGE' });
  await assert.rejects(searchMetaLibrary(query, { env, fetch: async () => new Response('{}', { headers: { 'content-length': String(META_LIBRARY_LIMITS.responseBytes + 1) } }) }), { code: 'RESPONSE_TOO_LARGE' });
});

test('bounds stalled fetch and streamed responses with shared deadline', async () => {
  await assert.rejects(searchMetaLibrary(query, { env, timeoutMs: 20, fetch: () => new Promise(() => {}) }), { code: 'TIMEOUT' });
  const stream = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('{')); } });
  await assert.rejects(searchMetaLibrary(query, { env, timeoutMs: 20, fetch: async () => new Response(stream) }), { code: 'TIMEOUT' });
});

test('handles empty data without fake records and rejects malformed payloads', async () => {
  const result = await searchMetaLibrary(query, { env, fetch: async () => json({ data: [] }) });
  assert.equal(result.count, 0);
  assert.equal(result.hasMore, false);
  await assert.rejects(searchMetaLibrary(query, { env, fetch: async () => json({ wrong: [] }) }), { code: 'INVALID_RESPONSE' });
});

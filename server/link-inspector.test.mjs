import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectLink, isPublicAddress, createPinnedLookup, LINK_INSPECTOR_LIMITS } from './link-inspector.mjs';

const publicAnswers = [{ address: '93.184.216.34', family: 4 }];
const response = (body = '<h1>Public page</h1>', extra = {}) => ({ statusCode: 200, headers: { 'content-type': 'text/html' }, body: Buffer.from(body), ...extra });
const baseDeps = transport => ({ resolve: async () => publicAnswers, transport });

test('rejects non-public IPv4, reserved IPv6 and every mapped representation', () => {
  for (const ip of ['0.0.0.0', '10.0.0.1', '100.64.1.2', '127.0.0.1', '169.254.169.254', '172.16.0.1', '192.0.0.9', '192.0.2.8', '192.168.1.1', '198.18.1.1', '198.51.100.2', '203.0.113.2', '224.0.0.1', '255.255.255.255', '::', '::1', 'fc00::1', 'fe80::1', 'ff02::1', '::ffff:127.0.0.1', '::ffff:8.8.8.8', '::ffff:808:808', '64:ff9b::808:808', '2001:db8::1', '2001::1', '2002:808:808::1', '3fff::1']) {
    assert.equal(isPublicAddress(ip), false, ip);
  }
  for (const ip of ['1.1.1.1', '8.8.8.8', '93.184.216.34', '2606:4700:4700::1111', '2001:4860:4860::8888']) assert.equal(isPublicAddress(ip), true, ip);
});

test('rejects dangerous URL schemes, credentials, ports and encoded loopback before transport', async () => {
  let requests = 0;
  const deps = baseDeps(async () => { requests++; return response(); });
  for (const url of ['file:///etc/passwd', 'ftp://example.com/a', 'https://user:secret@example.com', 'https://@example.com', 'https://example.com:444', 'http://127.1', 'http://2130706433', 'http://0x7f000001', 'http://[::ffff:127.0.0.1]', 'http://169.254.169.254/latest/meta-data']) {
    await assert.rejects(inspectLink({ url, compare: false }, deps), error => ['INVALID_URL', 'BLOCKED_ADDRESS'].includes(error.code), url);
  }
  assert.equal(requests, 0);
});

test('rejects entire DNS set when any answer is private or malformed', async () => {
  let called = false;
  for (const extra of [{ address: '127.0.0.1', family: 4 }, { address: '::ffff:8.8.8.8', family: 6 }, { address: '8.8.8.8', family: 6 }]) {
    await assert.rejects(inspectLink({ url: 'https://mixed.example', compare: false }, {
      resolve: async () => [...publicAnswers, extra], transport: async () => { called = true; return response(); },
    }), { code: 'BLOCKED_ADDRESS' });
  }
  assert.equal(called, false);
});

test('pins original DNS answer in transport lookup and preserves original TLS name', async () => {
  let lookups = 0;
  const result = await inspectLink({ url: 'https://secure.example/path', compare: false }, {
    resolve: async () => { lookups++; return lookups === 1 ? publicAnswers : [{ address: '127.0.0.1', family: 4 }]; },
    transport: async options => {
      assert.equal(options.address, publicAnswers[0].address);
      assert.equal(options.url.hostname, 'secure.example');
      assert.equal(options.servername, 'secure.example');
      assert.equal(options.headers.Cookie, undefined);
      assert.equal(options.headers.Authorization, undefined);
      assert.equal(options.headers['Accept-Encoding'], 'identity');
      const answer = await new Promise((resolve, reject) => options.lookup('secure.example', {}, (error, address, family) => error ? reject(error) : resolve({ address, family })));
      assert.deepEqual(answer, publicAnswers[0]);
      return response();
    },
  });
  assert.equal(lookups, 1);
  assert.equal(result.finalUrl, 'https://secure.example/path');
});

test('pinned lookup supports Node all:true without performing another resolution', async () => {
  const lookup = createPinnedLookup('2606:4700:4700::1111', 6);
  const answers = await new Promise((resolve, reject) => lookup('ignored.example', { all: true }, (error, value) => error ? reject(error) : resolve(value)));
  assert.deepEqual(answers, [{ address: '2606:4700:4700::1111', family: 6 }]);
});

test('checks DNS again on same-host redirects and blocks rebinding before second socket', async () => {
  let resolutions = 0, requests = 0;
  await assert.rejects(inspectLink({ url: 'https://rebind.example/start', compare: false }, {
    resolve: async () => ++resolutions === 1 ? publicAnswers : [{ address: '10.0.0.1', family: 4 }],
    transport: async () => { requests++; return response('', { statusCode: 302, headers: { location: '/private' } }); },
  }), { code: 'BLOCKED_ADDRESS' });
  assert.equal(resolutions, 2);
  assert.equal(requests, 1);
});

test('redirect to literal metadata address is blocked without DNS or second request', async () => {
  let requests = 0;
  await assert.rejects(inspectLink({ url: 'https://public.example', compare: false }, baseDeps(async () => {
    requests++;
    return response('', { statusCode: 302, headers: { location: 'http://169.254.169.254/latest/meta-data' } });
  })), { code: 'BLOCKED_ADDRESS' });
  assert.equal(requests, 1);
});

test('records relative/external redirects and bounded page evidence', async () => {
  const seen = [];
  const result = await inspectLink({ url: 'https://bit.ly/example', compare: false }, baseDeps(async ({ url }) => {
    seen.push(url.href);
    if (seen.length === 1) return response('', { statusCode: 302, headers: { Location: 'https://xn--e1afmkfd.xn--p1ai/start' } });
    if (seen.length === 2) return response('', { statusCode: 307, headers: { location: '/offer' } });
    return response('<script>casino bonus</script><h1>Казино: получите бонус за депозит</h1>');
  }));
  assert.equal(result.hops.length, 3);
  assert.equal(result.finalUrl, 'https://xn--e1afmkfd.xn--p1ai/offer');
  assert.ok(result.signals.some(s => s.id === 'shortener'));
  assert.ok(result.signals.some(s => s.id === 'punycode'));
  assert.ok(result.signals.some(s => s.id === 'external_redirect'));
  assert.ok(result.signals.some(s => s.id === 'gambling_promotion' && s.quote.includes('бонус')));
  assert.equal(result.comparison.requested, false);
});

test('script-only and binary occurrences do not create promotion signals', async () => {
  for (const reply of [response('<script>casino bonus</script><p>News</p>'), response('casino bonus', { headers: { 'content-type': 'application/octet-stream' } })]) {
    const result = await inspectLink({ url: 'https://public.example', compare: false }, baseDeps(async () => reply));
    assert.equal(result.signals.some(s => s.id === 'gambling_promotion'), false);
  }
});

test('limits redirects to five and detects cycles', async () => {
  let requests = 0;
  await assert.rejects(inspectLink({ url: 'https://public.example/0', compare: false }, baseDeps(async () => {
    requests++;
    return response('', { statusCode: 302, headers: { location: `/${requests}` } });
  })), { code: 'REDIRECT_LIMIT' });
  assert.equal(requests, LINK_INSPECTOR_LIMITS.maxRedirects + 1);
  await assert.rejects(inspectLink({ url: 'https://public.example/loop', compare: false }, baseDeps(async () => response('', { statusCode: 301, headers: { location: '/loop' } }))), { code: 'REDIRECT_LIMIT' });
});

test('hard deadline bounds stalled DNS and transports even if injected dependency ignores abort', async () => {
  const never = () => new Promise(() => {});
  for (const deps of [{ resolve: never, transport: async () => response() }, { resolve: async () => publicAnswers, transport: never }]) {
    const start = Date.now();
    await assert.rejects(inspectLink({ url: 'https://public.example', compare: false }, { ...deps, timeoutMs: 25 }), { code: 'TIMEOUT' });
    assert.ok(Date.now() - start < 1000);
  }
});

test('enforces body cap even on a noncompliant injected transport', async () => {
  const result = await inspectLink({ url: 'https://public.example', compare: false }, baseDeps(async () => response('a'.repeat(LINK_INSPECTOR_LIMITS.maxBytes) + ' casino bonus')));
  assert.equal(result.hops[0].bytes, LINK_INSPECTOR_LIMITS.maxBytes);
  assert.equal(result.hops[0].truncated, true);
  assert.equal(result.signals.some(s => s.id === 'gambling_promotion'), false);
  assert.ok(result.limitations.some(text => text.includes('усечён')));
});

test('compares independent desktop/mobile bodies by hash without a cloaking verdict', async () => {
  const result = await inspectLink({ url: 'https://public.example', compare: true }, baseDeps(async ({ headers }) => response(headers['User-Agent'].includes('Android') ? '<h1>Mobile layout</h1>' : '<h1>Desktop layout</h1>')));
  assert.equal(result.comparison.available, true);
  assert.equal(result.comparison.different, true);
  assert.equal(result.comparison.bodyDifferent, true);
  assert.equal(result.comparison.routeDifferent, false);
  assert.equal(result.comparison.desktopHash.length, 64);
  assert.match(result.comparison.note, /не доказательство клоакинга/);
  assert.equal(result.comparison.mobileHops.length, 1);
});

test('identical bodies cannot hide a changed mobile destination, route or HTTP status', async () => {
  for (const kind of ['destination', 'route', 'status']) {
    const result = await inspectLink({url:'https://public.example/start',compare:true}, baseDeps(async ({url,headers}) => {
      const mobile=headers['User-Agent'].includes('Android');
      if (mobile && url.pathname==='/start' && kind!=='status')return response('',{statusCode:302,headers:{location:kind==='destination'?'https://mobile.example/end':'/detour'}});
      if (mobile && url.pathname==='/detour')return response('',{statusCode:302,headers:{location:'/end'}});
      if (!mobile && url.pathname==='/start' && kind==='route')return response('',{statusCode:302,headers:{location:'/end'}});
      return response('Same response body',{statusCode:mobile&&kind==='status'?403:200});
    }));
    assert.equal(result.comparison.bodyDifferent,false,kind);
    assert.equal(result.comparison.routeDifferent,true,kind);
    assert.equal(result.comparison.different,true,kind);
  }
});

test('mobile-only promotion is analyzed with its exact quote and final source URL', async () => {
  const quote='Казино предлагает бонус за депозит';
  const result=await inspectLink({url:'https://public.example/start',compare:true},baseDeps(async({url,headers})=>{
    if(!headers['User-Agent'].includes('Android'))return response('<h1>Ordinary public page</h1>');
    if(url.pathname==='/start')return response('',{statusCode:302,headers:{location:'https://mobile.example/offer'}});
    return response(`<h1>${quote}</h1>`);
  }));
  const hits=result.signals.filter(signal=>signal.id==='gambling_promotion');
  assert.equal(hits.length,1);assert.equal(hits[0].variant,'mobile');assert.equal(hits[0].sourceUrl,'https://mobile.example/offer');assert.ok(quote.includes(hits[0].quote));
});

test('matching promotion in both variants keeps separate attributed evidence', async () => {
  const result=await inspectLink({url:'https://public.example',compare:true},baseDeps(async()=>response('<p>casino bonus</p>')));
  const hits=result.signals.filter(signal=>signal.id==='gambling_promotion');
  assert.deepEqual(hits.map(hit=>hit.variant),['desktop','mobile']);assert.equal(hits[0].quote,hits[1].quote);
  assert.equal(result.comparison.bodyDifferent,false);assert.equal(result.comparison.routeDifferent,false);assert.equal(result.comparison.different,false);
});

test('returns desktop result when mobile fails or shared deadline expires', async () => {
  let calls = 0;
  const result = await inspectLink({ url: 'https://public.example', compare: true }, {
    ...baseDeps(async () => ++calls === 1 ? response() : new Promise(() => {})), timeoutMs: 25,
  });
  assert.equal(result.hops.length, 1);
  assert.equal(result.comparison.available, false);
  assert.equal(result.comparison.errorCode, 'TIMEOUT');
});

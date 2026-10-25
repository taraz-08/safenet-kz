import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanBio, cleanCaption, parseSearchResults, parseSocialInput, searchHitAccount, socialRef, socialReferences } from './social.mjs';
import { createSocialDiscovery, SEARCH_QUERIES } from './social-discovery.mjs';
import { createDiscovery } from './discovery.mjs';
import { createApp } from './app.mjs';

// Fictional public profiles in the shape the page script returns.
const profiles = {
  'tiktok:spin_promo_kz': { name: 'Spin Promo', bio: '👇КАЗИНО👇 spinwin-kz.example/r1 промокод SPIN777 — бонус 150% на первый депозит и 100 фриспинов', links: ['https://spinwin-kz.example/r1'],
    posts: [{ url: 'https://www.tiktok.com/@spin_promo_kz/video/1', text: '«Занос x500 в слотах! Промокод SPIN777, фриспины в шапке. Ещё у @slots_friend_kz» от автора Spin Promo с композицией «звук»' },
      { url: 'https://www.tiktok.com/@spin_promo_kz/video/2', text: '«Утро, кофе, прогулка» от автора Spin Promo с композицией «звук»' }] },
  'tiktok:slots_friend_kz': { name: 'Friend', bio: 'Просто блог о путешествиях', posts: [] },
  'instagram:quiet_bakery_kz': { name: 'Bakery', bio: 'Свежий хлеб каждый день. Заказ по телефону', posts: [{ url: 'https://www.instagram.com/p/AAA/', text: 'Photo by Bakery on May 1, 2026. Возможно, это изображение хлеба.' }] },
  'instagram:bonus_hub_kz': { name: 'БОНУСЫ КАЗИНО', bio: 'ПРОМОКОДЫ КАЗИНО\nБОНУСЫ И ФРИСПИНЫ, забирай 4000 free spins\nt.me/cbonus_example', links: ['https://t.me/cbonus_example'], posts: [] },
};
const openProfile = async (platform, handle) => {
  const data = profiles[`${platform}:${handle}`];
  return data ? { loginWall: false, captcha: false, notFound: false, private: false, links: [], ...data } : { notFound: true, posts: [] };
};
const searchHtml = `<table>
<tr><td><a rel="nofollow" href="https://www.tiktok.com/@spin_promo_kz/video/9" class='result-link'>Промокод SPIN777 казино | TikTok</a></td></tr>
<tr><td class='result-snippet'>Бонус 150% на депозит и фриспины по промокоду SPIN777, переходи по ссылке</td></tr>
<tr><td><a rel="nofollow" href="https://www.instagram.com/p/XYZ/" class='result-link'>Розыгрыш</a></td></tr>
<tr><td class='result-snippet'>16 likes, 0 comments - quiet_bakery_kz on April 29, 2026: &quot;Свежий хлеб&quot;</td></tr>
<tr><td><a rel="nofollow" href="https://www.tiktok.com/api/img/?itemId=1" class='result-link'>TikTok</a></td></tr><tr><td class='result-snippet'>TikTok</td></tr>
</table>`;

function setup(extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'safenet-social-'));
  let cases = [];
  let clock = Date.parse('2026-10-25T00:00:00Z');
  const telegram = [];
  const social = createSocialDiscovery({ storePath: join(dir, 'social.json'), getCases: () => cases, persistCases: next => { cases = next; }, analysisVersion: 'rules-v5',
    openProfile, search: async () => ({ status: 200, html: '' }), onTelegramRef: (handle, via) => telegram.push({ handle, via }), now: () => clock, ...extra });
  social.update({ enabled: true });
  return { dir, social, telegram, cases: () => cases, advance: minutes => { clock += minutes * 60000; } };
}

test('profile links and prefixed names parse; post links without an author and short links are refused', () => {
  assert.deepEqual(socialRef('https://www.tiktok.com/@Spin_Promo_KZ/video/123'), { platform: 'tiktok', handle: 'spin_promo_kz' });
  assert.deepEqual(socialRef('instagram.com/bonus_hub_kz/'), { platform: 'instagram', handle: 'bonus_hub_kz' });
  assert.equal(socialRef('https://www.instagram.com/p/ABC123/'), null);
  assert.deepEqual(parseSocialInput('tt:@spin_promo_kz'), { platform: 'tiktok', handle: 'spin_promo_kz' });
  assert.deepEqual(parseSocialInput('@bonus_hub_kz', 'instagram'), { platform: 'instagram', handle: 'bonus_hub_kz' });
  assert.throws(() => parseSocialInput('https://vm.tiktok.com/ZMabc/'), /vm\.tiktok\.com/);
  assert.throws(() => parseSocialInput('https://www.instagram.com/reel/ABC/'), /не видно автора/);
  assert.throws(() => parseSocialInput('просто текст'), /ссылку на профиль/);
});

test('thumbnail text keeps the author words only', () => {
  assert.equal(cleanCaption('tiktok', '«Промокод SPIN777» от автора X с композицией «звук»'), 'Промокод SPIN777');
  assert.equal(cleanCaption('instagram', 'Photo by Бонусы on May 1, 2026. Возможно, это изображение текст "ФРИСПИНЫ ЗА РЕГИСТРАЦИЮ"'), 'ФРИСПИНЫ ЗА РЕГИСТРАЦИЮ');
  assert.equal(cleanCaption('instagram', 'Photo by Bakery on May 1, 2026. Возможно, это изображение хлеба.'), '');
  assert.equal(cleanCaption('instagram', 'Казино бонус в профиле'), 'Казино бонус в профиле');
  assert.equal(cleanBio('Zanos (@zanos)\nzanos\n61 подписчиков\n1 816 подписок\n12K followers\nZanos (@zanos)\nПромокод на депозит\nещё'), 'Zanos (@zanos)\nzanos\nПромокод на депозит');
});

test('references: same-platform mentions, cross-platform profiles, Telegram channels and other domains', () => {
  const refs = socialReferences('tiktok', 'spin_promo_kz', { bio: 'Мы в инсте instagram.com/bonus_hub_kz и в тг t.me/cbonus_example, сайт spinwin-kz.example/r1', links: ['https://www.youtube.com/@x'],
    posts: [{ url: 'u1', text: 'Привет @slots_friend_kz и @spin_promo_kz, пиши на mail@example.com' }] });
  assert.deepEqual(refs.accounts.map(ref => `${ref.platform}:${ref.handle}`).sort(), ['instagram:bonus_hub_kz', 'tiktok:slots_friend_kz']);
  assert.deepEqual(refs.telegram.map(ref => ref.handle), ['cbonus_example']);
  assert.ok(refs.domains.includes('spinwin-kz.example'));
  assert.ok(!refs.domains.some(domain => /youtube|instagram|t\.me/.test(domain)));
});

test('search results parse; image proxies are skipped and Instagram post hits name their author', () => {
  const hits = parseSearchResults(searchHtml);
  assert.equal(hits.length, 2);
  assert.deepEqual(searchHitAccount(hits[0]), { platform: 'tiktok', handle: 'spin_promo_kz' });
  assert.deepEqual(searchHitAccount(hits[1]), { platform: 'instagram', handle: 'quiet_bakery_kz' });
  assert.ok(SEARCH_QUERIES.every(query => /^site:(?:instagram|tiktok)\.com /.test(query)));
});

test('a risky seed is saved for review, its mentions are queued and its Telegram links go to the Telegram search', async () => {
  const { dir, social, telegram, cases } = setup();
  try {
    social.addSeed('https://www.tiktok.com/@spin_promo_kz');
    await social.tick();
    const snapshot = social.snapshot();
    assert.equal(snapshot.risky.length, 1);
    const account = snapshot.risky[0];
    assert.equal(account.key, 'tiktok:spin_promo_kz');
    assert.equal(account.categories.casino >= 1, true);
    assert.ok(account.domains.includes('spinwin-kz.example'));
    assert.ok(snapshot.queued.some(item => item.key === 'tiktok:slots_friend_kz' && item.foundVia[0].kind === 'mention'));
    const saved = cases();
    assert.ok(saved.length >= 1 && saved.every(record => record.source === 'social_discovery' && record.demo === false && record.platform === 'tiktok' && record.author === '@spin_promo_kz'));
    assert.ok(saved.every(record => record.provenance.loginUsed === false && /запрещают/.test(record.provenance.platformTermsNote)));
    assert.ok(!saved.some(record => /Утро, кофе/.test(record.text)), 'clean posts are not saved');
    await social.tick();
    assert.equal(social.snapshot().risky.length, 1, 'the mentioned travel blog is clean');
    assert.equal(telegram.length, 0, 'no Telegram links in this profile');
    social.addSeed('instagram.com/bonus_hub_kz');
    await social.tick();
    assert.deepEqual(telegram.map(item => item.handle), ['cbonus_example']);
    assert.equal(telegram[0].via.kind, 'instagram_link');
    const before = cases().length;
    social.addSeed('instagram.com/bonus_hub_kz');
    await social.tick();
    assert.equal(cases().length, before, 'the same evidence is not saved twice');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a captcha or login wall pauses the platform with growing waits; the other platform keeps going', async () => {
  let calls = 0;
  const { dir, social, advance } = setup({ openProfile: async (platform, handle) => { calls++; return platform === 'tiktok' ? { captcha: true, bio: '', posts: [] } : openProfile(platform, handle); } });
  try {
    social.addSeed('tt:@spin_promo_kz');
    social.addSeed('ig:quiet_bakery_kz');
    await social.tick();
    let snapshot = social.snapshot();
    assert.equal(snapshot.platforms.tiktok.reason, 'captcha');
    const firstWait = Date.parse(snapshot.platforms.tiktok.blockedUntil) - Date.parse('2026-10-25T00:00:00Z');
    await social.tick();
    snapshot = social.snapshot();
    assert.equal(snapshot.checked.find(item => item.key === 'instagram:quiet_bakery_kz')?.status, 'clean', 'Instagram is still checked');
    const tiktok = [...snapshot.queued, ...snapshot.risky].find(item => item.key === 'tiktok:spin_promo_kz');
    assert.equal(tiktok.status, 'queued', 'a blocked page says nothing about the account');
    advance(16);
    await social.tick();
    const secondWait = Date.parse(social.snapshot().platforms.tiktok.blockedUntil) - Date.parse('2026-10-25T00:16:00Z');
    assert.ok(secondWait > firstWait, 'the second pause is longer');
    assert.equal(calls, 3);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('an empty public page is a failed check, never a clean account or a saved finding', async () => {
  const { dir, social, cases } = setup({ search: async () => ({ status: 200, html: '' }), openProfile: async () => ({ name: 'Instagram', bio: '', posts: [], links: [] }) });
  try {
    social.addSeed('ig:@quiet_bakery_kz');
    await social.tick();
    const snapshot = social.snapshot();
    assert.equal(snapshot.counts.clean, 0);
    assert.equal(snapshot.counts.unavailable, 1);
    assert.equal(snapshot.checked[0].status, 'error');
    assert.equal(snapshot.checked[0].error.code, 'NO_PUBLIC_CONTENT');
    assert.equal(cases().length, 0);
    assert.equal(snapshot.stats.savedCases, 0);
  } finally { social.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('search hits become candidates; a refused search waits instead of retrying', async () => {
  let status = 200;
  const { dir, social, cases, advance } = setup({ search: async () => ({ status, html: searchHtml }), openProfile: async () => ({ notFound: true, posts: [] }) });
  try {
    await social.tick();
    const snapshot = social.snapshot();
    assert.equal(snapshot.stats.searches, 1);
    const all = [...snapshot.queued, ...snapshot.checked];
    assert.ok(all.some(item => item.key === 'tiktok:spin_promo_kz' && item.foundVia[0].kind === 'search'));
    assert.ok(cases().some(record => record.kind === 'search_snippet' && record.provenance.method === 'search_index'));
    const excerpt = cases().find(record => record.kind === 'search_snippet');
    assert.equal(excerpt.provenance.publicVisibilityVerified, false, 'a search hit does not verify a profile that was unavailable');
    assert.equal(excerpt.provenance.scope, 'public_search_index_excerpt');
    assert.match(excerpt.provenance.disclaimer, /не подтверждены/);
    status = 202;
    advance(21);
    await social.tick();
    const blocked = social.snapshot().search;
    assert.ok(Date.parse(blocked.blockedUntil) >= Date.parse('2026-10-25T00:21:00Z') + 60 * 60000);
    advance(30);
    await social.tick();
    assert.equal(social.snapshot().stats.searches, 2, 'no search while blocked');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('Telegram channels with risk signs hand their Instagram and TikTok links to the social search', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'safenet-cross-'));
  const refs = [];
  const html = `<html><body><div class="tgme_channel_info_header_title">Bonus</div><section class="tgme_channel_history"><div class="tgme_widget_message" data-post="bonus_cross_kz/1"><div class="tgme_widget_message_text">Промокод AZ777 даёт +150% к первому депу в казино, фриспины. Наш тикток https://www.tiktok.com/@spin_promo_kz</div><time datetime="2026-10-24T10:00:00+00:00"></time></div></section></body></html>`;
  try {
    let cases = [];
    const discovery = createDiscovery({ storePath: join(dir, 'd.json'), getCases: () => cases, persistCases: next => { cases = next; }, analysisVersion: 'rules-v5', fetchPreview: async () => ({ html }),
      onSocialRef: (ref, via) => refs.push({ ...ref, via }), now: () => Date.parse('2026-10-25T00:00:00Z'), sleep: async () => {} });
    discovery.addSeed('bonus_cross_kz');
    await discovery.tick();
    assert.deepEqual(refs.map(ref => `${ref.platform}:${ref.handle}`), ['tiktok:spin_promo_kz']);
    assert.equal(refs[0].via.from, 'telegram:bonus_cross_kz');
    assert.equal(discovery.addCandidate('cbonus_example', { from: 'instagram:bonus_hub_kz', kind: 'instagram_link' }), true);
    assert.equal(discovery.addCandidate('cbonus_example', { from: 'instagram:bonus_hub_kz', kind: 'instagram_link' }), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('social search API: seeds, strict toggle and run', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'safenet-social-api-'));
  const app = createApp({ storePath: join(dir, 'cases.json'), seed: false, socialOpenProfile: openProfile, socialSearch: async () => ({ status: 200, html: '' }) });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (path, method = 'GET', body) => fetch(base + path, { method, headers: { 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) }).then(async response => ({ status: response.status, body: await response.json() }));
  try {
    assert.equal((await call('/api/social/seeds', 'POST', { account: 'https://www.tiktok.com/@spin_promo_kz' })).status, 200);
    assert.equal((await call('/api/social/seeds', 'POST', { account: 'not a profile' })).status, 400);
    assert.equal((await call('/api/social', 'PUT', { enabled: 'no' })).status, 400);
    assert.equal((await call('/api/social', 'PUT', { enabled: true })).body.enabled, true);
    const run = await call('/api/social/run', 'POST', {});
    assert.equal(run.body.risky[0].key, 'tiktok:spin_promo_kz');
    const removed = await call('/api/social/seeds/tiktok/spin_promo_kz', 'DELETE');
    assert.equal(removed.body.seeds.length, 0);
  } finally {
    server.close();
    for (const name of ['watchtower', 'pipeline', 'discovery', 'social']) app.locals[name]?.close?.();
    await app.locals.mediaService?.close?.();
    app.locals.aiService?.close?.();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('social search stays off until the operator turns it on', async () => {
  const social = createSocialDiscovery({ getCases: () => [], persistCases: () => {}, analysisVersion: 'rules-v5', openProfile: async () => { throw new Error('must not open'); }, search: async () => { throw new Error('must not search'); } });
  assert.equal(social.snapshot().enabled, false);
  assert.deepEqual(await social.tick(), { skipped: true });
  assert.equal(social.update({ enabled: true }).enabled, true);
});

test('a full account list refuses a new seed cleanly and search hits beyond the cap are skipped', async () => {
  let cases = [];
  const social = createSocialDiscovery({ getCases: () => cases, persistCases: next => { cases = next; }, analysisVersion: 'rules-v5', openProfile, search: async () => ({ status: 200, html: searchHtml }) });
  social.update({ enabled: true });
  for (let i = 0; social.snapshot().counts.accounts < 600; i++) social.addCandidate('instagram', `filler_${i}`, { from: null, kind: 'search' });
  assert.throws(() => social.addSeed('tt:@spin_promo_kz'), error => error.status === 409);
  assert.equal(social.snapshot().seeds.length, 0);
  await assert.doesNotReject(social.tick());
});

test('saved social cases use the methodology priority with follower reach, and skip posts already queued from another source', async () => {
  let cases = [{ id: 'old', source: 'extension', url: 'https://www.tiktok.com/@spin_promo_kz/video/1', text: 'x' }];
  const social = createSocialDiscovery({ getCases: () => cases, persistCases: next => { cases = next; }, analysisVersion: 'rules-v5',
    openProfile: async (platform, handle) => ({ ...(await openProfile(platform, handle)), followers: '1 816' }), search: async () => ({ status: 200, html: '' }) });
  social.update({ enabled: true });
  social.addSeed('tt:@spin_promo_kz');
  await social.tick();
  const added = cases.filter(record => record.source === 'social_discovery');
  assert.ok(added.length >= 1);
  assert.ok(added.every(record => record.priorityParts.reach === 7 && record.priority === record.priorityParts.risk + 7));
  assert.equal(cases.filter(record => record.url === 'https://www.tiktok.com/@spin_promo_kz/video/1').length, 1);
});

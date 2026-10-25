import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDiscovery, channelReferences, parseChannelInput } from './discovery.mjs';

// Minimal public-preview HTML in Telegram's widget format (fictional channels).
function preview(handle, posts, { title = handle, forwardFrom } = {}) {
  const widgets = posts.map((text, index) => `<div class="tgme_widget_message" data-post="${handle}/${index + 1}">${forwardFrom ? `<a class="tgme_widget_message_forwarded_from_name" href="https://t.me/${forwardFrom}">src</a>` : ''}<div class="tgme_widget_message_text">${text}</div><time datetime="2026-10-24T10:0${index}:00+00:00"></time></div>`).join('');
  return `<html><body><div class="tgme_channel_info_header_title">${title}</div><section class="tgme_channel_history">${widgets}</section></body></html>`;
}
const pages = {
  seed_channel: preview('seed_channel', ['Новости дня. Подробнее у партнёров <a href="https://t.me/bonus_daily_kz">@bonus_daily_kz</a>']),
  bonus_daily_kz: preview('bonus_daily_kz', ['Поднял 380к за вечер 💰 Промокод AZ777 даёт +150% к первому депу, ссылка в шапке профиля. Ещё больше заносов у @lucky_spins_kz', 'Рабочее зеркало на сегодня: https://az777-mirror.example — старый сайт заблокирован.'], { title: 'Бонусы дня' }),
  lucky_spins_kz: preview('lucky_spins_kz', ['Сегодня кофе и прогулка в парке. Хорошего дня!'], { forwardFrom: 'third_level_kz' }),
};
const fakeFetch = async handle => { if (!pages[handle]) { const error = new Error('no preview'); error.code = 'PREVIEW_UNAVAILABLE'; throw error; } return { html: pages[handle] }; };

function setup(extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'safenet-discovery-'));
  let cases = [];
  let clock = Date.parse('2026-10-25T00:00:00Z');
  const discovery = createDiscovery({ storePath: join(dir, 'discovery.json'), getCases: () => cases, persistCases: next => { cases = next; }, analysisVersion: 'rules-v5', fetchPreview: fakeFetch, now: () => clock, sleep: async () => {}, ...extra });
  return { dir, discovery, cases: () => cases, advance: minutes => { clock += minutes * 60000; } };
}

test('channel input accepts names and public links, rejects private invites', () => {
  assert.equal(parseChannelInput('@Bonus_Daily_KZ'), 'bonus_daily_kz');
  assert.equal(parseChannelInput('https://t.me/s/bonus_daily_kz/15'), 'bonus_daily_kz');
  assert.throws(() => parseChannelInput('https://t.me/+AbCdEfGh123'), /Закрытые приглашения/);
});

test('references come from links, forwards and mentions; bots and self are skipped', () => {
  const html = preview('alpha_channel', ['см. @beta_channel и @helper_bot'], { forwardFrom: 'gamma_channel' }) + '<a href="https://t.me/+Secret12345">join</a>';
  const { refs, invites } = channelReferences(html, 'alpha_channel', [{ url: 'https://t.me/alpha_channel/1', text: 'см. @beta_channel и @helper_bot @alpha_channel', links: ['https://t.me/delta_channel/5'] }]);
  assert.deepEqual(refs.map(ref => ref.handle).sort(), ['beta_channel', 'delta_channel', 'gamma_channel']);
  assert.deepEqual(invites, ['t.me/+Secret12345']);
});

test('snowball: a seed leads to a risky channel, whose posts become real (non-demo) cases', async () => {
  const { dir, discovery, cases, advance } = setup();
  discovery.addSeed('seed_channel');
  await discovery.tick();           // seed → finds bonus_daily_kz
  advance(1);
  await discovery.tick();           // bonus_daily_kz → risky, finds lucky_spins_kz
  advance(1);
  await discovery.tick();           // lucky_spins_kz → clean, its forward is not followed
  const snapshot = discovery.snapshot();
  const risky = snapshot.risky.find(channel => channel.handle === 'bonus_daily_kz');
  assert.ok(risky, 'casino channel is flagged');
  assert.equal(risky.depth, 1);
  assert.equal(risky.foundVia[0].from, 'seed_channel');
  assert.ok(risky.flaggedPosts >= 2);
  assert.equal(risky.title, 'Бонусы дня');
  assert.ok(snapshot.checked.some(channel => channel.handle === 'lucky_spins_kz' && channel.status === 'clean'));
  assert.ok(!snapshot.queued.some(channel => channel.handle === 'third_level_kz'), 'clean channels do not expand the search');
  const saved = cases().filter(record => record.source === 'telegram_discovery');
  assert.ok(saved.length >= 2);
  for (const record of saved) {
    assert.equal(record.demo, false);
    assert.equal(record.author, '@bonus_daily_kz');
    assert.ok(record.analysis.score >= 30);
    assert.match(record.provenance.disclaimer, /не обвинение/);
  }
  advance(40);
  await discovery.tick();
  assert.equal(cases().filter(record => record.source === 'telegram_discovery').length, saved.length, 're-checks never duplicate cases');
  rmSync(dir, { recursive: true, force: true });
});

test('rate limiting pauses discovery and unavailable channels are backed off', async () => {
  const { dir, discovery, advance } = setup({ fetchPreview: async () => { const error = new Error('429'); error.code = 'RATE_LIMITED'; throw error; } });
  discovery.addSeed('seed_channel');
  await discovery.tick();
  const snapshot = discovery.snapshot();
  assert.ok(snapshot.stats.rateLimitedUntil);
  assert.deepEqual(await discovery.tick(), { skipped: true, rateLimited: true });
  advance(16);
  const outcome = await discovery.tick();
  assert.equal(outcome.skipped, undefined);
  rmSync(dir, { recursive: true, force: true });
});

/** SafeNet KZ — automatic discovery of real public Telegram channels ("snowball" from seed channels).
 *  Reads only public web previews (t.me/s/…), never logs in, joins chats or messages anyone.
 *  A channel with risk signs is a candidate for human review, not an accusation. */
import { existsSync, readFileSync } from 'node:fs';
import { randomUUID, createHash } from 'node:crypto';
import { analyzeItem } from './engine.mjs';
import { fetchTelegramPreview, parseTelegramPreview, telegramHandle } from './watchtower.mjs';
import { writeFileAtomic } from './storage.mjs';
import { socialRef } from './social.mjs';
import { addVia, queuePriority, ruleBackedRisk } from './review-queue.mjs';

export const DISCOVERY_LIMITS = Object.freeze({ channels: 400, seeds: 50, maxDepth: 3, probesPerTick: 2, tickMs: 20000, gapMs: 3000, casesPerProbe: 5, log: 120, cases: 5000 });
const MINUTE = 60000;
const RECHECK = { risky: 30, seed: 60, clean: 24 * 60, unavailable: 72 * 60, error: 30 };
const sha = value => createHash('sha256').update(value).digest('hex');
const iso = ms => new Date(ms).toISOString();

/** Accepts @name, name or https://t.me/name[/123]; private invites are rejected (they have no public preview). */
export function parseChannelInput(value) {
  const text = String(value ?? '').trim();
  const link = /^(?:https?:\/\/)?(?:www\.)?(?:t\.me|telegram\.me)\/(?:s\/)?([^/?#\s]+)/iu.exec(text);
  const raw = link ? link[1] : text;
  if (/^\+|^joinchat$/iu.test(raw)) { const error = new Error('Закрытые приглашения t.me/+… не имеют публичного предпросмотра — добавьте публичный канал.'); error.status = 400; throw error; }
  return telegramHandle(raw);
}

/** Channel references in a public preview: links, forwards and @mentions. Bots and the channel itself are skipped. */
export function channelReferences(html, self, posts = []) {
  const refs = new Map();
  const add = (handle, kind, postUrl) => {
    let clean;
    try { clean = telegramHandle(handle); } catch { return; }
    if (clean === self || clean.endsWith('bot')) return;
    if (!refs.has(clean)) refs.set(clean, { handle: clean, kind, postUrl: postUrl ?? null });
  };
  for (const match of String(html).matchAll(/tgme_widget_message_forwarded_from_name"[^>]*href="https?:\/\/t\.me\/([A-Za-z0-9_]{5,32})/gu)) add(match[1], 'forward');
  for (const post of posts) {
    for (const link of post.links ?? []) { const match = /^https?:\/\/(?:t\.me|telegram\.me)\/([A-Za-z0-9_]{5,32})(?:\/\d+)?\/?$/iu.exec(link); if (match) add(match[1], 'link', post.url); }
    for (const match of String(post.text ?? '').matchAll(/(?<![\p{L}\p{N}_.@])@([A-Za-z][A-Za-z0-9_]{4,31})(?![A-Za-z0-9_])/gu)) add(match[1], 'mention', post.url);
  }
  const invites = [...new Set([...String(html).matchAll(/https?:\/\/t\.me\/(?:\+|joinchat\/)([A-Za-z0-9_-]{8,40})/gu)].map(match => `t.me/+${match[1]}`))].slice(0, 10);
  return { refs: [...refs.values()], invites };
}

const blankChannel = (handle, depth, via, nowIso) => ({ handle, title: `@${handle}`, status: 'queued', depth, foundVia: via ? [via] : [], firstSeenAt: nowIso, lastCheckedAt: null, nextCheckAt: nowIso, checks: 0, postsChecked: 0, flaggedPosts: 0, maxScore: 0, categories: {}, sample: null, invites: [], error: null, consecutiveErrors: 0 });

export function createDiscovery({ storePath, getCases, persistCases, analysisVersion, fetchPreview = fetchTelegramPreview, analyze = analyzeItem, extraSeeds = () => [], onSocialRef = () => {}, now = () => Date.now(), sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  let state = { enabled: true, seeds: [], channels: {}, stats: { probes: 0, savedCases: 0, flaggedPosts: 0, rateLimitedUntil: null, lastRunAt: null, startedAt: null }, log: [] };
  if (storePath && existsSync(storePath)) {
    try { const saved = JSON.parse(readFileSync(storePath, 'utf8')); state = { ...state, ...saved, stats: { ...state.stats, ...saved.stats } }; } catch { /* a damaged file restarts discovery from the seeds */ }
  }
  let timer = null, busy = false, closed = false;
  const save = () => { if (storePath) writeFileAtomic(storePath, JSON.stringify(state, null, 2)); };
  const nowIso = () => iso(now());

  function seedHandles() {
    const handles = new Set(state.seeds.map(seed => seed.handle));
    for (const handle of extraSeeds()) { try { handles.add(telegramHandle(handle)); } catch { /* ignore invalid configured sources */ } }
    return [...handles];
  }
  function ensureSeedChannels() {
    for (const handle of seedHandles()) if (!state.channels[handle]) state.channels[handle] = { ...blankChannel(handle, 0, { from: null, kind: 'seed', postUrl: null }, nowIso()) };
  }

  function pickDue() {
    ensureSeedChannels();
    const t = now();
    const seeds = new Set(seedHandles());
    const due = Object.values(state.channels).filter(channel => !channel.nextCheckAt || Date.parse(channel.nextCheckAt) <= t);
    // Risky re-checks first, then seeds, then the shallowest new candidates.
    const rank = channel => (channel.status === 'risky' ? 0 : seeds.has(channel.handle) ? 1 : channel.status === 'queued' ? 2 + channel.depth : 9);
    return due.sort((a, b) => rank(a) - rank(b) || String(a.firstSeenAt).localeCompare(String(b.firstSeenAt))).slice(0, DISCOVERY_LIMITS.probesPerTick);
  }

  function pushLog(entry) { state.log = [{ at: nowIso(), ...entry }, ...state.log].slice(0, DISCOVERY_LIMITS.log); }

  async function probe(handle) {
    const channel = state.channels[handle];
    const seeds = new Set(seedHandles());
    const checkedAt = nowIso();
    state.stats.probes++;
    try {
      const response = await fetchPreview(handle);
      const html = typeof response === 'string' ? response : response.html;
      const parsed = parseTelegramPreview(html, handle);
      if (!parsed.available) {
        Object.assign(channel, { status: 'unavailable', lastCheckedAt: checkedAt, nextCheckAt: iso(now() + RECHECK.unavailable * MINUTE), checks: channel.checks + 1, error: null });
        pushLog({ handle, outcome: 'unavailable' });
        return;
      }
      let flagged = [], maxScore = 0;
      const categories = {};
      for (const post of parsed.posts) {
        const extraLinks = post.links.filter(link => !post.text.includes(link));
        const text = [post.text, ...extraLinks].join('\n').slice(0, 30000);
        if (!text) continue;
        const analysis = analyze({ text, url: post.url, platform: 'telegram' });
        // Real channels are flagged on rule evidence only; a model-only score is too noisy on live news and job posts.
        const risky = ruleBackedRisk(analysis);
        if (risky) { flagged.push({ post, text, analysis }); categories[analysis.category] = (categories[analysis.category] ?? 0) + 1; maxScore = Math.max(maxScore, analysis.score); }
      }
      flagged.sort((a, b) => b.analysis.score - a.analysis.score);
      const status = flagged.length ? 'risky' : 'clean';
      const top = flagged[0];
      Object.assign(channel, {
        title: parsed.title || channel.title, status, lastCheckedAt: checkedAt, checks: channel.checks + 1, postsChecked: channel.postsChecked + parsed.posts.length,
        // The channel card reflects the latest public posts; saved cases keep the history.
        flaggedPosts: flagged.length, maxScore, categories,
        sample: top ? { url: top.post.url, text: top.text.slice(0, 280), score: top.analysis.score, category: top.analysis.category } : null,
        nextCheckAt: iso(now() + (status === 'risky' ? RECHECK.risky : seeds.has(handle) ? RECHECK.seed : RECHECK.clean) * MINUTE), error: null, consecutiveErrors: 0,
      });
      const { refs, invites } = channelReferences(html, handle, parsed.posts);
      channel.invites = [...new Set([...channel.invites, ...invites])].slice(0, 10);
      // Expand only from seeds and channels that showed risk signs, so discovery follows schemes, not all of Telegram.
      let discovered = 0;
      if ((seeds.has(handle) || status === 'risky') && channel.depth < DISCOVERY_LIMITS.maxDepth) {
        for (const ref of refs) {
          const via = { from: handle, kind: ref.kind, postUrl: ref.postUrl };
          const known = state.channels[ref.handle];
          if (known) { known.foundVia = addVia(known.foundVia, via); continue; }
          if (Object.keys(state.channels).length >= DISCOVERY_LIMITS.channels) break;
          state.channels[ref.handle] = blankChannel(ref.handle, channel.depth + 1, via, nowIso());
          discovered++;
        }
        // Instagram and TikTok accounts these channels point to go to the social search.
        for (const post of parsed.posts) {
          for (const link of [...post.links, ...(post.text.match(/(?:https?:\/\/)?(?:www\.)?(?:instagram\.com|tiktok\.com)\/[^\s"'<>]+/giu) ?? [])]) {
            const ref = socialRef(link);
            if (ref) onSocialRef(ref, { from: `telegram:${handle}`, kind: 'telegram_link', postUrl: post.url });
          }
        }
      }
      const saved = saveCases(channel, flagged.slice(0, DISCOVERY_LIMITS.casesPerProbe));
      state.stats.flaggedPosts += flagged.length;
      pushLog({ handle, outcome: status, flagged: flagged.length, posts: parsed.posts.length, discovered, saved, score: maxScore });
    } catch (error) {
      if (error.code === 'RATE_LIMITED') state.stats.rateLimitedUntil = iso(now() + 15 * MINUTE);
      // Personal profiles and closed channels have no public preview: note it and look again only rarely.
      const unavailable = error.code === 'PREVIEW_UNAVAILABLE';
      const attempts = (channel.consecutiveErrors ?? 0) + 1;
      Object.assign(channel, { status: unavailable ? 'unavailable' : 'error', lastCheckedAt: checkedAt, checks: channel.checks + 1, consecutiveErrors: unavailable ? 0 : attempts,
        error: { code: error.code ?? 'ERROR', message: error.message }, nextCheckAt: iso(now() + (unavailable ? RECHECK.unavailable : Math.min(24 * 60, RECHECK.error * 2 ** Math.min(attempts, 6))) * MINUTE) });
      pushLog({ handle, outcome: unavailable ? 'unavailable' : 'error', code: error.code ?? 'ERROR' });
    }
  }

  function saveCases(channel, flagged) {
    if (!flagged.length) return 0;
    const cases = getCases();
    if (cases.length >= DISCOVERY_LIMITS.cases) return 0;
    // A post already queued by any source (monitoring, extension, an earlier probe) is not queued again.
    const known = new Set(cases.map(record => record.url).filter(Boolean));
    const observedAt = nowIso();
    const added = flagged.filter(item => !known.has(item.post.url)).map(({ post, text, analysis }) => ({
      id: randomUUID(), source: 'telegram_discovery', demo: false, status: 'new', kind: 'channel_post', platform: 'telegram',
      text, originalText: post.text, url: post.url, author: `@${channel.handle}`, createdAt: observedAt, publishedAt: post.publishedAt, capturedAt: observedAt,
      analysis, analysisVersion, analyzedAt: observedAt, ...queuePriority(analysis.score),
      links: post.links,
      provenance: { source: 'telegram_discovery', method: 'public_preview', scope: 'publicly_available_preview', canonicalUrl: post.url, fingerprint: sha(`${post.url}\n${text}`), observedAt, publishedAt: post.publishedAt,
        channel: channel.handle, channelTitle: channel.title, depth: channel.depth, discoveredVia: channel.foundVia.slice(0, 3), publicVisibilityVerified: true, locationVerified: false, mediaAnalyzed: false,
        disclaimer: 'Признаки риска в публичном канале, найденном автоматически. Требуется проверка человеком; это не обвинение владельца канала.' },
    }));
    if (added.length) { persistCases([...added, ...cases]); state.stats.savedCases += added.length; }
    return added.length;
  }

  async function tick() {
    if (busy || closed || !state.enabled) return { skipped: true };
    if (state.stats.rateLimitedUntil && Date.parse(state.stats.rateLimitedUntil) > now()) return { skipped: true, rateLimited: true };
    busy = true;
    try {
      const due = pickDue();
      for (let i = 0; i < due.length && !closed && state.enabled; i++) { if (i) await sleep(DISCOVERY_LIMITS.gapMs); await probe(due[i].handle); }
      state.stats.lastRunAt = nowIso();
      if (!state.stats.startedAt) state.stats.startedAt = state.stats.lastRunAt;
      save();
      return { probed: due.length };
    } finally { busy = false; }
  }

  const api = {
    start() { if (timer || closed) return; ensureSeedChannels(); save(); timer = setInterval(() => { void tick().catch(error => console.error('Discovery:', error.code || error.message)); }, DISCOVERY_LIMITS.tickMs); timer.unref?.(); setTimeout(() => void tick().catch(() => {}), 1500).unref?.(); },
    tick,
    snapshot() {
      ensureSeedChannels();
      const channels = Object.values(state.channels);
      const by = status => channels.filter(channel => channel.status === status);
      const order = (a, b) => b.flaggedPosts - a.flaggedPosts || b.maxScore - a.maxScore;
      return structuredClone({
        enabled: state.enabled, busy, seeds: state.seeds, configuredSeeds: seedHandles(),
        counts: { channels: channels.length, risky: by('risky').length, clean: by('clean').length, queued: by('queued').length, unavailable: by('unavailable').length + by('error').length },
        stats: state.stats, risky: by('risky').sort(order), queued: by('queued').sort((a, b) => a.depth - b.depth).slice(0, 40), checked: [...by('clean'), ...by('unavailable'), ...by('error')].sort((a, b) => String(b.lastCheckedAt).localeCompare(String(a.lastCheckedAt))).slice(0, 40),
        log: state.log.slice(0, 40), limits: DISCOVERY_LIMITS,
        notes: { ru: 'Только публичные каналы через веб-предпросмотр t.me/s. Система не входит в аккаунт, не вступает в закрытые группы и не пишет сообщения. Признаки — повод для проверки, не обвинение.', kk: 'Тек t.me/s арқылы ашық арналар. Жүйе аккаунтқа кірмейді, жабық топтарға қосылмайды және хат жазбайды. Белгілер — тексеру себебі, айып емес.' },
      });
    },
    update(patch = {}) {
      if (patch.enabled !== undefined) {
        if (typeof patch.enabled !== 'boolean') throw Object.assign(new Error('enabled должен быть true или false.'), { status: 400 });
        state.enabled = patch.enabled;
      }
      save();
      return api.snapshot();
    },
    addSeed(input, note = '') {
      const handle = parseChannelInput(input);
      if (state.seeds.some(seed => seed.handle === handle)) return api.snapshot();
      if (state.seeds.length >= DISCOVERY_LIMITS.seeds) { const error = new Error(`Не более ${DISCOVERY_LIMITS.seeds} стартовых каналов.`); error.status = 409; throw error; }
      state.seeds = [...state.seeds, { handle, addedAt: nowIso(), note: String(note).slice(0, 120) }];
      const channel = state.channels[handle];
      if (channel) Object.assign(channel, { depth: 0, nextCheckAt: nowIso() }); else state.channels[handle] = blankChannel(handle, 0, { from: null, kind: 'seed', postUrl: null }, nowIso());
      save();
      return api.snapshot();
    },
    removeSeed(handle) { state.seeds = state.seeds.filter(seed => seed.handle !== handle); save(); return api.snapshot(); },
    /** A channel referenced from outside Telegram (an Instagram or TikTok profile). Returns true when it is new. */
    addCandidate(handle, via) {
      let clean;
      try { clean = telegramHandle(handle); } catch { return false; }
      const known = state.channels[clean];
      if (known) { known.foundVia = addVia(known.foundVia, via); return false; }
      if (Object.keys(state.channels).length >= DISCOVERY_LIMITS.channels) return false;
      state.channels[clean] = blankChannel(clean, 1, via, nowIso());
      save();
      return true;
    },
    close() { closed = true; if (timer) clearInterval(timer); timer = null; },
  };
  return api;
}

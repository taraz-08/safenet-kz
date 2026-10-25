/** SafeNet KZ — automatic discovery of public Instagram and TikTok accounts with risk signs.
 *  A headless browser opens public profile pages without signing in; accounts come from seeds, search-index hits,
 *  @mentions and links in risky profiles, Telegram channels and the analyst's browser extension.
 *  Platform rules (Meta, TikTok) forbid automated collection: the operator switched this mode on knowingly.
 *  A captcha or login wall pauses the platform; nothing is solved or bypassed. Signs are a reason to review, not an accusation. */
import { existsSync, readFileSync } from 'node:fs';
import { randomUUID, createHash } from 'node:crypto';
import { analyzeItem } from './engine.mjs';
import { createBrowser } from './browser.mjs';
import { writeFileAtomic } from './storage.mjs';
import { addVia, parseFollowers, queuePriority, ruleBackedRisk } from './review-queue.mjs';
import { EXTRACT_PROFILE, PLATFORMS, accountKey, cleanBio, cleanCaption, parseSearchResults, parseSocialInput, profileUrl, searchHitAccount, socialHandle, socialReferences } from './social.mjs';

export const SOCIAL_LIMITS = Object.freeze({ accounts: 600, seeds: 80, maxDepth: 3, tickMs: 45000, casesPerProbe: 6, log: 150, cases: 5000, searchEveryMinutes: 20 });
const MINUTE = 60000;
const RECHECK = { risky: 6 * 60, seed: 12 * 60, clean: 3 * 24 * 60, unavailable: 7 * 24 * 60, private: 7 * 24 * 60, error: 60 };
const COOLDOWN = { platform: [15, 6 * 60], search: [60, 24 * 60] };
const TERMS_NOTE = 'Сбор с публичных страниц без входа в аккаунт. Правила Meta и TikTok запрещают автоматический сбор — режим включён оператором осознанно.';
const SEARCH_TERMS = ['казино промокод фриспины', 'казино бонус депозит казахстан', 'слоты занос промокод', 'ставки промокод бонус пополнение', 'заработок без вложений каспи',
  'инвестиции доход в день процентов', 'пассивный доход пригласи друга бонус', 'розыгрыш билет каспи перевод', 'розыгрыш айфон купи билет', 'казино ойын бонус промокод',
  'салымсыз табыс каспи', 'ұтыс билет каспи аударым'];
export const SEARCH_QUERIES = Object.freeze(SEARCH_TERMS.flatMap(term => [`site:instagram.com ${term}`, `site:tiktok.com ${term}`]));
const sha = value => createHash('sha256').update(value).digest('hex');
const iso = ms => new Date(ms).toISOString();
const backoff = ([base, max], strikes) => Math.min(max, base * 2 ** Math.max(0, strikes - 1));

/** Default fetchers: one shared headless browser for profiles, DuckDuckGo Lite for the search index. */
export function defaultOpenProfile(profileDir) {
  let browser = null;
  const open = (platform, handle) => {
    browser ??= createBrowser({ profileDir: process.env.SAFENET_BROWSER_PROFILE_DIR || profileDir, allowHosts: ['instagram.com', 'tiktok.com'] });
    return browser.open(profileUrl(platform, handle), { expression: EXTRACT_PROFILE });
  };
  open.close = () => browser?.close();
  return open;
}
export async function defaultSearch(query) {
  const response = await fetch('https://lite.duckduckgo.com/lite/', { method: 'POST', body: new URLSearchParams({ q: query, kl: 'kz-ru' }),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept-Language': 'ru,kk;q=0.9', 'User-Agent': 'SafeNetKZ-research/5.0 (+local analyst tool)' }, signal: AbortSignal.timeout(20000) });
  return { status: response.status, html: await response.text() };
}

const blankAccount = (platform, handle, depth, via, nowIso) => ({ key: accountKey(platform, handle), platform, handle, name: '', status: 'queued', depth, foundVia: via ? [via] : [],
  firstSeenAt: nowIso, lastCheckedAt: null, nextCheckAt: nowIso, checks: 0, postsChecked: 0, flaggedPosts: 0, maxScore: 0, categories: {}, sample: null, bio: '', followers: '',
  domains: [], telegram: [], hint: null, error: null, consecutiveErrors: 0 });

export function createSocialDiscovery({ storePath, getCases, persistCases, analysisVersion, openProfile, search = defaultSearch, analyze = analyzeItem,
  onTelegramRef = () => {}, now = () => Date.now() } = {}) {
  // Off until the operator turns it on in the interface (see docs/adr/0003).
  let state = { enabled: false, seeds: [], accounts: {}, platforms: Object.fromEntries(PLATFORMS.map(platform => [platform, { blockedUntil: null, strikes: 0, reason: null }])),
    search: { cursor: 0, nextAt: null, blockedUntil: null, strikes: 0, lastQuery: null }, stats: { probes: 0, savedCases: 0, flaggedPosts: 0, searches: 0, searchHits: 0, lastRunAt: null, startedAt: null }, log: [] };
  if (storePath && existsSync(storePath)) {
    try {
      const saved = JSON.parse(readFileSync(storePath, 'utf8'));
      state = { ...state, ...saved, platforms: { ...state.platforms, ...saved.platforms }, search: { ...state.search, ...saved.search }, stats: { ...state.stats, ...saved.stats } };
    } catch { /* a damaged file restarts from the seeds */ }
  }
  let timer = null, busy = false, closed = false;
  const save = () => { if (storePath) writeFileAtomic(storePath, JSON.stringify(state, null, 2)); };
  const nowIso = () => iso(now());
  const seedKeys = () => new Set(state.seeds.map(seed => accountKey(seed.platform, seed.handle)));
  const pushLog = entry => { state.log = [{ at: nowIso(), ...entry }, ...state.log].slice(0, SOCIAL_LIMITS.log); };
  const blocked = scope => scope.blockedUntil && Date.parse(scope.blockedUntil) > now();

  function addAccount(platform, handle, depth, via, hint = null) {
    const key = accountKey(platform, handle);
    const known = state.accounts[key];
    if (known) {
      known.foundVia = addVia(known.foundVia, via);
      if (hint && (!known.hint || hint.score > known.hint.score)) known.hint = hint;
      return false;
    }
    if (Object.keys(state.accounts).length >= SOCIAL_LIMITS.accounts) return false;
    state.accounts[key] = { ...blankAccount(platform, handle, depth, via, nowIso()), hint };
    return true;
  }

  function pickDue() {
    const t = now(), seeds = seedKeys();
    const rank = account => (account.status === 'risky' ? 0 : seeds.has(account.key) ? 1 : account.hint?.risky ? 2 : account.status === 'queued' ? 3 + account.depth : 9);
    return Object.values(state.accounts)
      .filter(account => !blocked(state.platforms[account.platform]) && (!account.nextCheckAt || Date.parse(account.nextCheckAt) <= t))
      .sort((a, b) => rank(a) - rank(b) || String(a.firstSeenAt).localeCompare(String(b.firstSeenAt)))[0] ?? null;
  }

  function block(platform, reason) {
    const scope = state.platforms[platform];
    scope.strikes += 1;
    scope.reason = reason;
    scope.blockedUntil = iso(now() + backoff(COOLDOWN.platform, scope.strikes) * MINUTE);
  }

  async function probe(account) {
    const { platform, handle } = account;
    const checkedAt = nowIso(), seeds = seedKeys();
    state.stats.probes++;
    try {
      const data = await openProfile(platform, handle);
      const visible = Boolean(data?.bio || data?.posts?.length);
      if (!data || data.loginWall || (data.captcha && !visible)) {
        block(platform, data?.loginWall ? 'login_wall' : 'captcha');
        Object.assign(account, { lastCheckedAt: checkedAt, nextCheckAt: state.platforms[platform].blockedUntil });
        pushLog({ key: account.key, outcome: 'blocked', reason: state.platforms[platform].reason });
        return;
      }
      // A captcha drawn over an already rendered profile: use what is public on screen, then let the platform rest.
      if (data.captcha) block(platform, 'captcha'); else Object.assign(state.platforms[platform], { strikes: 0, reason: null });
      if (data.notFound || data.private) {
        const status = data.notFound ? 'unavailable' : 'private';
        Object.assign(account, { status, lastCheckedAt: checkedAt, checks: account.checks + 1, nextCheckAt: iso(now() + RECHECK[status] * MINUTE), error: null, consecutiveErrors: 0 });
        pushLog({ key: account.key, outcome: status });
        return;
      }
      if (!visible) throw Object.assign(new Error('Публичные тексты профиля не загрузились; оценить риск не удалось.'), { code: 'NO_PUBLIC_CONTENT' });
      const url = profileUrl(platform, handle);
      const posts = (data.posts ?? []).map(post => ({ url: post.url, text: cleanCaption(platform, post.text) })).filter(post => post.text.length >= 8);
      const items = [{ kind: 'profile_bio', url, text: cleanBio([data.name, data.bio].filter(Boolean).join('\n')) }, ...posts.map(post => ({ kind: 'profile_post', ...post }))].filter(item => item.text);
      const flagged = [], categories = {};
      let maxScore = 0;
      for (const item of items) {
        const analysis = analyze({ text: item.text.slice(0, 30000), url: item.url, platform });
        // Live accounts are flagged on rule evidence only, as in the Telegram search: model-only scores are too noisy on real feeds.
        const risky = ruleBackedRisk(analysis);
        if (risky) { flagged.push({ item, analysis }); categories[analysis.category] = (categories[analysis.category] ?? 0) + 1; maxScore = Math.max(maxScore, analysis.score); }
      }
      flagged.sort((a, b) => b.analysis.score - a.analysis.score);
      const status = flagged.length ? 'risky' : 'clean';
      const refs = socialReferences(platform, handle, { bio: data.bio ?? '', links: data.links ?? [], posts });
      Object.assign(account, {
        name: (data.name ?? '').trim().slice(0, 120), bio: cleanBio(data.bio).slice(0, 600), followers: data.followers ?? '', status, lastCheckedAt: checkedAt, checks: account.checks + 1,
        postsChecked: account.postsChecked + posts.length, flaggedPosts: flagged.length, maxScore, categories,
        sample: flagged[0] ? { url: flagged[0].item.url, text: flagged[0].item.text.slice(0, 280), score: flagged[0].analysis.score, category: flagged[0].analysis.category } : null,
        domains: refs.domains, telegram: refs.telegram.map(ref => ref.handle).slice(0, 10),
        nextCheckAt: iso(now() + (status === 'risky' ? RECHECK.risky : seeds.has(account.key) ? RECHECK.seed : RECHECK.clean) * MINUTE), error: null, consecutiveErrors: 0,
      });
      // Expand only from seeds and risky accounts, so the search follows schemes rather than the whole platform.
      let discovered = 0;
      if ((seeds.has(account.key) || status === 'risky') && account.depth < SOCIAL_LIMITS.maxDepth) {
        for (const ref of refs.accounts) if (addAccount(ref.platform, ref.handle, account.depth + 1, { from: account.key, kind: ref.kind, postUrl: ref.postUrl })) discovered++;
        for (const ref of refs.telegram) onTelegramRef(ref.handle, { from: account.key, kind: `${platform}_link`, postUrl: ref.postUrl ?? url });
      }
      const saved = saveCases(account, flagged.slice(0, SOCIAL_LIMITS.casesPerProbe), 'headless_public_profile');
      state.stats.flaggedPosts += flagged.length;
      pushLog({ key: account.key, outcome: status, flagged: flagged.length, posts: posts.length, discovered, saved, score: maxScore, partial: Boolean(data.captcha) });
    } catch (error) {
      const attempts = (account.consecutiveErrors ?? 0) + 1;
      Object.assign(account, { status: 'error', lastCheckedAt: checkedAt, consecutiveErrors: attempts, error: { code: error.code ?? 'ERROR', message: error.message },
        nextCheckAt: iso(now() + Math.min(24 * 60, RECHECK.error * 2 ** Math.min(attempts - 1, 5)) * MINUTE) });
      pushLog({ key: account.key, outcome: 'error', code: error.code ?? 'ERROR' });
    }
  }

  function saveCases(account, flagged, method, query = null) {
    if (!flagged.length) return 0;
    const cases = getCases();
    if (cases.length >= SOCIAL_LIMITS.cases) return 0;
    const known = new Set(cases.filter(record => record.source === 'social_discovery').map(record => record.provenance?.fingerprint));
    // A post already queued by any source (extension, Telegram, an earlier probe) is not queued again.
    const queuedUrls = new Set(cases.filter(record => record.url && record.kind !== 'profile_bio').map(record => record.url));
    const observedAt = nowIso();
    const added = [];
    for (const { item, analysis } of flagged) {
      const fingerprint = sha(`${item.url}\n${item.text}`);
      if (known.has(fingerprint) || (item.kind !== 'profile_bio' && queuedUrls.has(item.url))) continue;
      known.add(fingerprint);
      added.push({
        id: randomUUID(), source: 'social_discovery', demo: false, status: 'new', kind: item.kind, platform: account.platform,
        text: item.text, originalText: item.text, url: item.url, author: `@${account.handle}`, createdAt: observedAt, capturedAt: observedAt,
        analysis, analysisVersion, analyzedAt: observedAt, ...queuePriority(analysis.score, parseFollowers(account.followers)),
        links: [],
        provenance: { source: 'social_discovery', method, scope: method === 'search_index' ? 'public_search_index_excerpt' : 'publicly_available_page', canonicalUrl: item.url, fingerprint, observedAt, platform: account.platform,
          account: account.handle, accountName: account.name, depth: account.depth, discoveredVia: account.foundVia.slice(0, 3), query,
          publicVisibilityVerified: method !== 'search_index', loginUsed: false, locationVerified: false, mediaAnalyzed: false, platformTermsNote: TERMS_NOTE,
          disclaimer: method === 'search_index'
            ? 'Признаки найдены в выдержке поисковой системы. Содержимое и текущая доступность исходной страницы не подтверждены; требуется ручная проверка. Это не обвинение владельца аккаунта.'
            : 'Признаки риска в публичном аккаунте, найденном автоматически. Требуется проверка человеком; это не обвинение владельца аккаунта.' },
      });
    }
    if (added.length) { persistCases([...added, ...cases]); state.stats.savedCases += added.length; }
    return added.length;
  }

  async function searchStep() {
    const scope = state.search;
    if (blocked(scope) || (scope.nextAt && Date.parse(scope.nextAt) > now())) return;
    const query = SEARCH_QUERIES[scope.cursor % SEARCH_QUERIES.length];
    scope.cursor = (scope.cursor + 1) % SEARCH_QUERIES.length;
    scope.lastQuery = query;
    scope.nextAt = iso(now() + SOCIAL_LIMITS.searchEveryMinutes * MINUTE);
    state.stats.searches++;
    try {
      const { status, html } = await search(query);
      const hits = status === 200 ? parseSearchResults(html) : [];
      if (status !== 200) {
        // The search engine asked us to slow down: wait longer each time instead of retrying.
        scope.strikes += 1;
        scope.blockedUntil = iso(now() + backoff(COOLDOWN.search, scope.strikes) * MINUTE);
        pushLog({ key: 'search', outcome: 'blocked', reason: `http_${status}`, query });
        return;
      }
      scope.strikes = 0;
      let added = 0, saved = 0;
      for (const hit of hits) {
        const ref = searchHitAccount(hit);
        if (!ref) continue;
        const text = `${hit.title}\n${hit.snippet}`.trim();
        const analysis = analyze({ text, url: hit.url, platform: ref.platform });
        const risky = ruleBackedRisk(analysis);
        if (addAccount(ref.platform, ref.handle, 1, { from: null, kind: 'search', postUrl: hit.url, query }, { risky, score: analysis.score })) added++;
        const account = state.accounts[accountKey(ref.platform, ref.handle)];
        if (risky && account) {
          saved += saveCases(account, [{ item: { kind: 'search_snippet', url: hit.url, text }, analysis }], 'search_index', query);
        }
      }
      state.stats.searchHits += hits.length;
      pushLog({ key: 'search', outcome: 'search', query, hits: hits.length, discovered: added, saved });
    } catch (error) {
      pushLog({ key: 'search', outcome: 'error', code: error.code ?? error.name ?? 'ERROR', query });
    }
  }

  async function tick() {
    if (busy || closed || !state.enabled) return { skipped: true };
    busy = true;
    try {
      await searchStep();
      const due = pickDue();
      if (due && !closed && state.enabled) await probe(due);
      state.stats.lastRunAt = nowIso();
      state.stats.startedAt ??= state.stats.lastRunAt;
      save();
      return { probed: due ? 1 : 0 };
    } finally { busy = false; }
  }

  const api = {
    start() {
      if (timer || closed) return;
      timer = setInterval(() => { void tick().catch(error => console.error('Social discovery:', error.code || error.message)); }, SOCIAL_LIMITS.tickMs);
      timer.unref?.();
      setTimeout(() => void tick().catch(() => {}), 5000).unref?.();
    },
    tick,
    snapshot() {
      const accounts = Object.values(state.accounts);
      const by = status => accounts.filter(account => account.status === status);
      const order = (a, b) => b.flaggedPosts - a.flaggedPosts || b.maxScore - a.maxScore;
      return structuredClone({
        enabled: state.enabled, busy, seeds: state.seeds, platforms: state.platforms, search: { ...state.search, queries: SEARCH_QUERIES.length },
        counts: { accounts: accounts.length, risky: by('risky').length, clean: by('clean').length, queued: by('queued').length, unavailable: by('unavailable').length + by('private').length + by('error').length,
          byPlatform: Object.fromEntries(PLATFORMS.map(platform => [platform, { accounts: accounts.filter(a => a.platform === platform).length, risky: by('risky').filter(a => a.platform === platform).length }])) },
        stats: state.stats, risky: by('risky').sort(order),
        queued: by('queued').sort((a, b) => (b.hint?.risky ? 1 : 0) - (a.hint?.risky ? 1 : 0) || a.depth - b.depth).slice(0, 40),
        checked: [...by('clean'), ...by('unavailable'), ...by('private'), ...by('error')].sort((a, b) => String(b.lastCheckedAt).localeCompare(String(a.lastCheckedAt))).slice(0, 40),
        log: state.log.slice(0, 40), limits: SOCIAL_LIMITS,
        notes: { ru: `Публичные профили Instagram и TikTok открываются в браузере без входа в аккаунт, по одному раз в ${SOCIAL_LIMITS.tickMs / 1000} с. ${TERMS_NOTE} Капча или стена входа ставит платформу на паузу. Признаки — повод для проверки, не обвинение.`,
          kk: `Instagram мен TikTok ашық профильдері аккаунтқа кірмей браузерде ашылады, ${SOCIAL_LIMITS.tickMs / 1000} с сайын біреуден. Meta мен TikTok ережелері автоматты жинауға тыйым салады — режимді оператор саналы түрде қосқан. Капча не кіру талабы платформаны кідіртеді. Белгілер — тексеру себебі, айып емес.` },
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
    addSeed(input, platform, note = '') {
      const ref = parseSocialInput(input, platform);
      const key = accountKey(ref.platform, ref.handle);
      if (!state.accounts[key] && Object.keys(state.accounts).length >= SOCIAL_LIMITS.accounts) throw Object.assign(new Error(`Список аккаунтов заполнен (${SOCIAL_LIMITS.accounts}). Удалите старые кандидаты, чтобы добавить новый.`), { status: 409 });
      if (!state.seeds.some(seed => accountKey(seed.platform, seed.handle) === key)) {
        if (state.seeds.length >= SOCIAL_LIMITS.seeds) throw Object.assign(new Error(`Не более ${SOCIAL_LIMITS.seeds} стартовых аккаунтов.`), { status: 409 });
        state.seeds = [...state.seeds, { ...ref, addedAt: nowIso(), note: String(note).slice(0, 120) }];
      }
      if (!addAccount(ref.platform, ref.handle, 0, { from: null, kind: 'seed', postUrl: null })) Object.assign(state.accounts[key], { depth: 0, nextCheckAt: nowIso() });
      save();
      return api.snapshot();
    },
    removeSeed(platform, handle) { state.seeds = state.seeds.filter(seed => !(seed.platform === platform && seed.handle === handle)); save(); return api.snapshot(); },
    /** An account seen elsewhere (Telegram post, extension, another profile). Returns true when it is new. */
    addCandidate(platform, handle, via) {
      let clean;
      try { clean = socialHandle(platform, handle); } catch { return false; }
      const added = addAccount(platform, clean, 1, via);
      if (added) save();
      return added;
    },
    close() { closed = true; if (timer) clearInterval(timer); timer = null; openProfile?.close?.(); },
  };
  return api;
}

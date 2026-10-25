/** SafeNet KZ — automatic screening pipeline: ingest → analyze → link → route. Humans only review the queue. */
import { readFileSync, existsSync } from 'node:fs';
import { writeFileAtomic } from './storage.mjs';
import { randomUUID } from 'node:crypto';
import { analyzeItem, applyExtraSignals } from './engine.mjs';
import { demoItems } from './demo.mjs';

import { QUEUE_THRESHOLD, queuePriority } from './review-queue.mjs';
export { QUEUE_THRESHOLD };
const LOG_LIMIT = 400;
const PLATFORM_DOMAIN = /(?:^|\.)(?:instagram\.com|tiktok\.com|t\.me|telegram\.org|whatsapp\.com|chat\.whatsapp\.com|wa\.me|youtube\.com|youtu\.be|kaspi\.kz|halykbank\.kz|halyk\.kz|facebook\.com|vk\.com|random\.org|bit\.ly|clck\.ru|cutt\.ly|t\.ly|goo\.su|tinyurl\.com|egov\.kz|gov\.kz)$/u;
const DEFAULT_STATE = { enabled: true, rate: 2, cursor: 0, runId: null, startedAt: null, finishedAt: null, processed: 0, cleared: 0, queued: 0, latencyTotalMs: 0, log: [] };
const TRACK_OF = { lottery: 1, casino: 2, pyramid: 3 };

const tokensOf = text => String(text ?? '').toLowerCase().normalize('NFKC').replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/u).filter(token => token.length > 1);
function shinglesOf(text) {
  const tokens = tokensOf(text);
  const result = new Set();
  for (let i = 0; i + 2 < tokens.length; i++) result.add(`${tokens[i]} ${tokens[i + 1]} ${tokens[i + 2]}`);
  if (!result.size && tokens.length) result.add(tokens.join(' '));
  return result;
}
const jaccard = (a, b) => { let inter = 0; for (const value of a) if (b.has(value)) inter++; return inter / (a.size + b.size - inter || 1); };
function fnv1a(value, seed) {
  let hash = (0x811c9dc5 ^ seed) >>> 0;
  for (let i = 0; i < value.length; i++) { hash ^= value.charCodeAt(i); hash = Math.imul(hash, 0x01000193) >>> 0; }
  return hash >>> 0;
}
// MinHash + LSH bands: near-duplicate candidates without comparing every pair, so the idea scales to large streams.
const BANDS = 10, ROWS = 3;
function minhashBands(shingles) {
  const signature = Array.from({ length: BANDS * ROWS }, (_, seed) => { let min = 0xffffffff; for (const value of shingles) min = Math.min(min, fnv1a(value, seed * 7919 + 1)); return min; });
  return Array.from({ length: BANDS }, (_, band) => `${band}:${signature.slice(band * ROWS, band * ROWS + ROWS).join('.')}`);
}

/** Near-duplicate clusters (template messages / copy-paste promotion). */
export function templateClusters(items, { threshold = 0.45, minTokens = 6 } = {}) {
  const prepared = items.filter(item => tokensOf(item.text).length >= minTokens).map(item => ({ ...item, shingles: shinglesOf(item.text) }));
  const buckets = new Map();
  for (const item of prepared) for (const band of minhashBands(item.shingles)) { if (!buckets.has(band)) buckets.set(band, []); buckets.get(band).push(item); }
  const parent = new Map(prepared.map(item => [item.id, item.id]));
  const find = id => { while (parent.get(id) !== id) { parent.set(id, parent.get(parent.get(id))); id = parent.get(id); } return id; };
  const checked = new Set();
  for (const bucket of buckets.values()) {
    if (bucket.length > 60) continue; // a huge bucket is boilerplate, not a template; skipping keeps the pass linear-ish
    for (let i = 0; i < bucket.length; i++) for (let j = i + 1; j < bucket.length; j++) {
      const key = [bucket[i].id, bucket[j].id].sort().join('|');
      if (checked.has(key)) continue;
      checked.add(key);
      if (jaccard(bucket[i].shingles, bucket[j].shingles) >= threshold) parent.set(find(bucket[i].id), find(bucket[j].id));
    }
  }
  const groups = new Map();
  for (const item of prepared) groups.set(find(item.id), [...(groups.get(find(item.id)) ?? []), item]);
  return [...groups.values()].filter(group => group.length >= 2).map(group => ({ size: group.length, authors: [...new Set(group.map(item => item.author))], ids: group.map(item => item.id), example: group[0].text }));
}

/** Strong shared indicators only: requisites, promo codes, invite/short links and non-platform domains. */
export function linkKeys(analysis) {
  const entities = analysis?.entities ?? {};
  const keys = [];
  for (const card of entities.cards ?? []) keys.push(['card', card]);
  for (const phone of entities.phones ?? []) keys.push(['phone', `+7 ${phone.replace(/\D/gu, '').slice(-10).replace(/^(\d{3})(\d{3})(\d{2})(\d{2})$/u, '$1 $2 $3 $4')}`]);
  for (const code of entities.promoCodes ?? []) keys.push(['promo', code]);
  for (const link of entities.inviteLinks ?? []) keys.push(['invite', link.replace(/^https?:\/\//iu, '').replace(/^www\./iu, '').toLowerCase()]);
  for (const link of entities.shortLinks ?? []) keys.push(['short', link.replace(/^https?:\/\//iu, '').toLowerCase()]);
  for (const domain of entities.domains ?? []) if (!PLATFORM_DOMAIN.test(domain)) keys.push(['domain', domain.replace(/^www\./u, '')]);
  return keys;
}

const LINK_LABELS = { card: ['карта', 'карта'], phone: ['номер Kaspi/телефон', 'Kaspi/телефон нөмірі'], promo: ['промокод', 'промокод'], invite: ['ссылка-приглашение', 'шақыру сілтемесі'], short: ['короткая ссылка', 'қысқа сілтеме'], domain: ['домен', 'домен'] };

/** Account network: union-find over accounts that share a strong indicator. */
export function buildNetworks(records) {
  const parent = new Map();
  const find = id => { if (!parent.has(id)) parent.set(id, id); while (parent.get(id) !== id) { parent.set(id, parent.get(parent.get(id))); id = parent.get(id); } return id; };
  const byKey = new Map();
  for (const record of records) {
    find(record.accountKey);
    for (const [type, value] of record.keys) {
      const key = `${type}:${value}`;
      if (!byKey.has(key)) byKey.set(key, { type, value, accounts: new Set(), items: new Set() });
      byKey.get(key).accounts.add(record.accountKey);
      byKey.get(key).items.add(record.id);
    }
  }
  for (const entry of byKey.values()) {
    const [first, ...rest] = [...entry.accounts];
    for (const other of rest) parent.set(find(other), find(first));
  }
  const clusters = new Map();
  for (const record of records) {
    const root = find(record.accountKey);
    if (!clusters.has(root)) clusters.set(root, { id: `net-${root.replace(/^[a-z]+:/u, '')}`, accounts: new Map(), shared: [], items: [] });
    const cluster = clusters.get(root);
    cluster.items.push(record);
    const account = cluster.accounts.get(record.accountKey) ?? { key: record.accountKey, handle: record.handle, platform: record.platform, followers: record.followers ?? null, kind: record.kind, items: 0, risky: 0, maxScore: 0, categories: {} };
    account.items++;
    if (record.score >= QUEUE_THRESHOLD) { account.risky++; account.categories[record.category] = (account.categories[record.category] ?? 0) + 1; }
    account.maxScore = Math.max(account.maxScore, record.score);
    cluster.accounts.set(record.accountKey, account);
  }
  for (const entry of byKey.values()) {
    if (entry.accounts.size < 2) continue;
    const cluster = clusters.get(find([...entry.accounts][0]));
    cluster.shared.push({ type: entry.type, value: entry.value, accounts: entry.accounts.size, items: entry.items.size, label: { ru: LINK_LABELS[entry.type][0], kk: LINK_LABELS[entry.type][1] } });
  }
  return [...clusters.values()].map(cluster => {
    const accounts = [...cluster.accounts.values()].sort((a, b) => b.risky - a.risky || b.maxScore - a.maxScore);
    const risky = cluster.items.filter(item => item.score >= QUEUE_THRESHOLD);
    const categories = {};
    for (const item of risky) categories[item.category] = (categories[item.category] ?? 0) + 1;
    const dominant = Object.entries(categories).sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'none';
    return { id: cluster.id, size: accounts.length, accounts, shared: cluster.shared.sort((a, b) => b.accounts - a.accounts || b.items - a.items), riskyItems: risky.length, items: cluster.items.length, maxScore: Math.max(0, ...cluster.items.map(item => item.score)), category: dominant, categories, itemIds: cluster.items.map(item => item.id) };
  }).sort((a, b) => Number(b.size > 1) - Number(a.size > 1) || b.riskyItems - a.riskyItems || b.maxScore - a.maxScore);
}

const ROLE_ORDER = ['organizer', 'curator', 'testimonial', 'member', 'skeptic', 'bot'];
const ANNOUNCEMENT = /основател\p{L}*|тариф\p{L}*|реферальн\p{L}*\s+программ\p{L}*|внимание|📢|коллеги|жаңалық|(?:^|\s)vip|кураторам|кураторларға|наш\p{L}*\s+(?:клуб|тариф|команд)|без\s+паники|уважаемые\s+участники|құрметті/iu;
/** Group chat: scheme signals across messages + roles + template messages. Members' warnings are kept apart as counter-evidence. */
export function analyzeGroup(group) {
  const messages = (group.messages ?? []).map((message, index) => ({ ...message, id: message.id ?? `${group.id}-m${index}`, analysis: analyzeItem({ text: message.text, ocrText: message.ocrText }) }));
  const counter = messages.filter(message => message.analysis.riskContext === 'warning_or_news');
  const offerMessages = messages.filter(message => message.analysis.riskContext !== 'warning_or_news');
  const base = analyzeItem({
    text: offerMessages.map(message => message.text).filter(Boolean).join('\n').slice(0, 30000),
    ocrText: offerMessages.map(message => message.ocrText).filter(Boolean).join('\n').slice(0, 8000),
  });
  const authors = new Map();
  for (const message of messages) {
    const key = message.authorId ?? message.author;
    const stats = authors.get(key) ?? { id: key, name: message.author, messages: 0, offers: 0, proofs: 0, recruit: 0, requisites: 0, announcements: 0, warnings: 0 };
    const rules = new Set(message.analysis.matchedRules ?? []);
    const text = `${message.text ?? ''} ${message.ocrText ?? ''}`;
    stats.messages++;
    if (['numeric_return', 'fast_returns', 'guaranteed_profit', 'entry_payment', 'slot_purchase'].some(id => rules.has(id))) stats.offers++;
    if (rules.has('payout_proof')) stats.proofs++;
    if (['recruitment', 'urgency', 'curator'].some(id => rules.has(id))) stats.recruit++;
    if ((message.analysis.entities.cards?.length ?? 0) + (message.analysis.entities.phones?.length ?? 0) > 0 || /чек\p{L}*\s+(?:—\s*)?(?:мне|маған|жібер|в\s+лс|в\s+личку|жеке)/iu.test(text)) stats.requisites++;
    if (ANNOUNCEMENT.test(text)) stats.announcements++;
    if (message.analysis.riskContext === 'warning_or_news') stats.warnings++;
    authors.set(key, stats);
  }
  const templates = templateClusters(messages.map(message => ({ id: message.id, text: message.text, author: message.authorId ?? message.author })));
  const strongTemplates = templates.filter(cluster => cluster.authors.length >= 2 || cluster.size >= 3);
  const templateAuthors = new Set(strongTemplates.flatMap(cluster => cluster.authors));
  // Organizers announce terms (tariffs, referral levels, "questions — to curators") and rarely post requisites themselves;
  // curators collect money: requisites, receipts, copy-paste templates.
  const isBot = author => /(?:^|\s)(?:bot|бот)(?:\s|$)/iu.test(author.name);
  const organizerScore = author => author.announcements * 3 + author.offers * 2 - author.requisites;
  const candidates = [...authors.values()].filter(author => !isBot(author) && author.offers + author.announcements > 0);
  const organizer = candidates.sort((a, b) => organizerScore(b) - organizerScore(a))[0] ?? null;
  const roles = [...authors.values()].map(author => ({
    ...author,
    role: isBot(author) ? 'bot'
      : author === organizer && organizerScore(author) > 0 ? 'organizer'
      : (author.requisites > 0 || templateAuthors.has(author.id) || author.recruit >= 2) && author.offers + author.recruit + author.requisites > 0 ? 'curator'
      : author.proofs > 0 ? 'testimonial' : author.warnings > 0 ? 'skeptic' : 'member',
  })).sort((a, b) => ROLE_ORDER.indexOf(a.role) - ROLE_ORDER.indexOf(b.role) || b.messages - a.messages);
  const curators = roles.filter(role => role.role === 'curator');
  const target = base.category === 'none' ? (base.categories[0]?.id ?? 'pyramid') : base.category;
  const extra = [];
  if (base.score >= 20 && strongTemplates.length) {
    const copies = strongTemplates.reduce((sum, cluster) => sum + cluster.size, 0);
    extra.push({ id: 'template_messages', category: target, weight: 14, quote: strongTemplates[0].example.slice(0, 160), modality: 'text',
      label: 'Үлгі хабарламалар', description: `${copies} бір-біріне ұқсас хабарлама ${templateAuthors.size} автордан — үйлестірілген «қыздыру» белгісі.`,
      labelRu: 'Шаблонные сообщения', descriptionRu: `${copies} почти одинаковых сообщений от ${templateAuthors.size} авторов — признак скоординированного «прогрева».` });
  }
  if (base.score >= 20 && organizer && curators.length) {
    extra.push({ id: 'group_roles', category: target, weight: 10, quote: organizer.name, modality: 'text',
      label: 'Рөлдер құрылымы', description: `Ұйымдастырушы ұсыныс пен деректемелерді жариялайды, ${curators.length} куратор шақыруды қайталайды.`,
      labelRu: 'Структура ролей', descriptionRu: `Организатор публикует предложения и реквизиты, кураторов, повторяющих призывы: ${curators.length}.` });
  }
  const analysis = applyExtraSignals(base, extra);
  const evidence = offerMessages.filter(message => message.analysis.score >= 20).sort((a, b) => b.analysis.score - a.analysis.score).slice(0, 6)
    .map(message => ({ id: message.id, author: message.author, text: message.text, ocrText: message.ocrText, score: message.analysis.score, minutesAgo: message.minutesAgo }));
  return { analysis, roles, templates: strongTemplates, evidence, counterMessages: counter.slice(0, 3).map(message => ({ author: message.author, text: message.text })), messageCount: messages.length };
}

function loadCorpus(path) {
  if (path && existsSync(path)) {
    try {
      const corpus = JSON.parse(readFileSync(path, 'utf8'));
      if (Array.isArray(corpus.items)) return corpus;
    } catch { /* fall through to the bundled demo */ }
  }
  return { name: 'SafeNet KZ bundled demo stream', provenance: { type: 'synthetic' }, accounts: [], groups: [],
    items: demoItems.map((item, index) => ({ id: `demo-${index}`, accountId: item.author, platform: item.platform, type: 'post', minutesAgo: (demoItems.length - index) * 45, text: item.text, url: item.url, groundTruth: null })) };
}

function eventsOf(corpus) {
  const accounts = new Map((corpus.accounts ?? []).map(account => [account.id, account]));
  const events = [
    ...corpus.items.map(item => ({ kind: 'item', id: item.id, minutesAgo: item.minutesAgo ?? 0, item, account: accounts.get(item.accountId) ?? { id: item.accountId, handle: item.accountId, platform: item.platform } })),
    ...(corpus.groups ?? []).map(group => ({ kind: 'group', id: group.id, minutesAgo: Math.min(...(group.messages ?? []).map(message => message.minutesAgo ?? 0)), group })),
  ];
  return events.sort((a, b) => b.minutesAgo - a.minutesAgo || a.id.localeCompare(b.id));
}

const PLATFORMS = new Set(['instagram', 'tiktok', 'telegram', 'whatsapp', 'youtube', 'other']);

function networkSnapshot(entries) {
  const networks = buildNetworks(entries);
  return {
    networks: networks.filter(cluster => cluster.riskyItems > 0).slice(0, 40).map(({ itemIds, ...cluster }) => cluster),
    accounts: networks.flatMap(cluster => cluster.accounts.map(account => ({ ...account, network: cluster.size > 1 ? cluster.id : null, networkSize: cluster.size }))).filter(account => account.risky > 0).sort((a, b) => b.risky - a.risky || b.maxScore - a.maxScore).slice(0, 60),
    disclaimer: { ru: 'Связи построены по совпадающим реквизитам, промокодам, ссылкам и доменам. Совпадение — повод для проверки, а не доказательство общего владельца.', kk: 'Байланыстар ортақ деректемелер, промокодтар, сілтемелер мен домендер бойынша құрылды. Сәйкестік — тексеру себебі, ортақ иенің дәлелі емес.' },
  };
}

export function createPipeline({ statePath, corpusPath, getCases, persistCases, analysisVersion, now = () => Date.now(), autoStart = true, liveOnly = false } = {}) {
  // Do not load the corpus or persisted replay state in live mode, even when previously enabled.
  if (liveOnly) {
    const disabled = () => { throw Object.assign(new Error('Демо-поток недоступен в режиме liveOnly.'), { status: 403 }); };
    return {
      start() {}, close() {}, update: disabled, reset: disabled, step: disabled,
      snapshot: () => ({ liveOnly: true, enabled: false, running: false, finished: false, total: 0, processed: 0, queued: 0, cleared: 0, log: [], corpus: null, streamQuality: null }),
      networks: () => networkSnapshot(getCases().filter(record => record.demo !== true).map(record => ({
        id: record.id, accountKey: record.accountKey || `${record.platform || 'other'}:${record.author || record.url || record.id}`,
        handle: record.author || record.url || record.id, platform: record.platform || 'other', kind: record.kind || 'account', followers: record.followers ?? null,
        score: record.analysis?.score ?? 0, category: record.analysis?.category ?? 'none', keys: linkKeys(record.analysis),
      }))),
    };
  }
  let state = { ...DEFAULT_STATE };
  if (statePath && existsSync(statePath)) {
    try { state = { ...DEFAULT_STATE, ...JSON.parse(readFileSync(statePath, 'utf8')) }; } catch { state = { ...DEFAULT_STATE }; }
  }
  let corpus = loadCorpus(corpusPath);
  let events = eventsOf(corpus);
  let index = [];
  let timer = null, closed = false;
  const save = () => { if (statePath) writeFileAtomic(statePath, JSON.stringify(state, null, 2)); };

  function analyzeEvent(event) {
    if (event.kind === 'group') {
      const result = analyzeGroup(event.group);
      const text = result.evidence.map(message => `${message.author}: ${message.text}`).join('\n')
        || (event.group.messages ?? []).slice(0, 4).map(message => `${message.author}: ${message.text}`).join('\n');
      const members = new Set((event.group.messages ?? []).map(message => message.authorId ?? message.author)).size;
      return { result, text, rawText: (event.group.messages ?? []).map(message => `${message.text ?? ''} ${message.ocrText ?? ''}`).join('\n'), accountKey: `group:${event.group.id}`, handle: event.group.title, platform: event.group.platform ?? 'whatsapp', kind: 'group', followers: members };
    }
    const { item, account } = event;
    const analysis = analyzeItem({ text: item.text, ocrText: item.ocrText, transcript: item.transcript, url: item.url, platform: item.platform });
    return { result: { analysis }, text: item.text, rawText: [item.text, item.ocrText, item.transcript].filter(Boolean).join('\n'), accountKey: `acc:${account.id}`, handle: account.handle ?? account.id, platform: item.platform ?? account.platform ?? 'other', kind: account.kind ?? 'account', followers: account.followers ?? null };
  }
  const entryOf = (event, analyzed) => ({ id: event.id, accountKey: analyzed.accountKey, handle: analyzed.handle, platform: analyzed.platform, kind: analyzed.kind, followers: analyzed.followers, score: analyzed.result.analysis.score, category: analyzed.result.analysis.category, keys: linkKeys(analyzed.result.analysis),
    // Code-shaped tokens (AZ777) are matched only against promo codes already seen in flagged items.
    codeTokens: [...new Set(String(analyzed.rawText ?? '').match(/(?<![A-Za-z0-9])[A-Z]{2,}[0-9]{2,}[A-Z0-9]*(?![A-Za-z0-9])/gu) ?? [])] });

  // A bare code that equals a promo code already seen in flagged items becomes a network link of its own.
  function attachKnownCodes(entry) {
    const known = new Set(index.filter(other => other.score >= QUEUE_THRESHOLD).flatMap(other => other.keys.filter(([type]) => type === 'promo').map(([, value]) => value)));
    for (const code of entry.codeTokens) if (known.has(code) && !entry.keys.some(([type, value]) => type === 'promo' && value === code)) entry.keys.push(['promo', code]);
  }

  function rebuildIndex() {
    index = [];
    for (const event of events.slice(0, state.cursor)) {
      const analyzed = analyzeEvent(event);
      const entry = entryOf(event, analyzed);
      attachKnownCodes(entry);
      const known = knownIndicatorSignal(entry, analyzed.result.analysis);
      if (known) Object.assign(entry, (({ score, category }) => ({ score, category }))(applyExtraSignals(analyzed.result.analysis, [known])));
      index.push(entry);
      const network = networkSignals(entry, buildNetworks(index));
      const extra = [...(known ? [known] : []), ...network.extra];
      if (extra.length) Object.assign(entry, (({ score, category }) => ({ score, category }))(applyExtraSignals(analyzed.result.analysis, extra)));
    }
  }

  // Network context is explainable and bounded: it can lift a weak item into review, never decide on its own.
  function networkSignals(entry, networks) {
    const cluster = networks.find(item => item.itemIds.includes(entry.id));
    const extra = [];
    if (!cluster || entry.score < 20) return { extra, cluster };
    const own = cluster.accounts.find(account => account.key === entry.accountKey);
    const others = cluster.accounts.filter(account => account.key !== entry.accountKey && account.risky > 0);
    const category = entry.category !== 'none' ? entry.category : Object.entries(own?.categories ?? {}).sort((a, b) => b[1] - a[1])[0]?.[0] ?? cluster.category;
    if (!category || category === 'none') return { extra, cluster };
    if (others.length) {
      const shared = cluster.shared.slice(0, 3);
      extra.push({ id: 'network_link', category, weight: Math.min(12, 4 + others.length * 2), quote: shared[0]?.value ?? '', modality: null,
        label: 'Аккаунттар желісімен байланыс', description: `${others.length} басқа белгіленген аккаунтпен ортақ: ${shared.map(item => `${item.label.kk} ${item.value}`).join(', ')}. Сәйкестік ортақ иені дәлелдемейді.`,
        labelRu: 'Связь с сетью аккаунтов', descriptionRu: `Общие индикаторы с другими помеченными аккаунтами (${others.length}): ${shared.map(item => `${item.label.ru} ${item.value}`).join(', ')}. Совпадение не доказывает общего владельца.` });
    }
    if ((own?.risky ?? 0) >= 2) {
      extra.push({ id: 'account_series', category, weight: 6, quote: entry.handle, modality: null,
        label: 'Аккаунттың қайталанатын жарияланымдары', description: `Бұл аккаунт ${own.risky} тәуекелді материал жариялаған.`,
        labelRu: 'Повторяющиеся публикации аккаунта', descriptionRu: `Аккаунт опубликовал рискованных материалов: ${own.risky}. Повторяемость повышает приоритет.` });
    }
    return { extra, cluster };
  }

  // Hidden promotion often carries no wording at all — only a promo code, mirror, requisites or a handle already
  // seen in several flagged items. Reuse of such an indicator is evidence worth a human look, bounded below "high".
  function knownIndicatorSignal(entry, analysis) {
    if (analysis.riskContext === 'warning_or_news') return null;
    const prior = index.filter(other => other.id !== entry.id && other.score >= QUEUE_THRESHOLD);
    let best = null;
    const candidates = [...entry.keys, ...entry.codeTokens.filter(code => !entry.keys.some(([type, value]) => type === 'promo' && value === code)).map(code => ['promo', code])];
    for (const [type, value] of candidates) {
      const hits = prior.filter(other => other.keys.some(([t, v]) => t === type && v === value));
      if (hits.length >= 2 && (!best || hits.length > best.hits.length)) best = { type, value, hits };
    }
    if (!best) {
      for (const handle of (analysis.entities?.handles ?? []).map(value => value.toLowerCase())) {
        const hits = prior.filter(other => String(other.handle).toLowerCase() === handle);
        if (hits.length >= 2) { best = { type: 'mention', value: handle, hits }; break; }
      }
    }
    if (!best) return null;
    const categories = {};
    for (const hit of best.hits) if (hit.category !== 'none') categories[hit.category] = (categories[hit.category] ?? 0) + 1;
    const category = Object.entries(categories).sort((a, b) => b[1] - a[1])[0]?.[0];
    if (!category) return null;
    const accounts = new Set(best.hits.map(hit => hit.accountKey)).size;
    const label = best.type === 'mention' ? { ru: 'упоминание аккаунта', kk: 'аккаунтты атау' } : { ru: LINK_LABELS[best.type][0], kk: LINK_LABELS[best.type][1] };
    return { id: 'known_indicator', category, weight: Math.min(34, 18 + best.hits.length * 4), quote: best.value, modality: null,
      label: 'Белгіленген материалдардағы индикатор', description: `${label.kk} ${best.value} бұрын ${best.hits.length} белгіленген материалда (${accounts} аккаунт) кездескен. Бұл байланыс, дәлел емес.`,
      labelRu: 'Индикатор уже встречался в помеченных материалах', descriptionRu: `${label.ru[0].toUpperCase()}${label.ru.slice(1)} ${best.value} уже был в помеченных материалах: ${best.hits.length} (аккаунтов: ${accounts}). Это связь, а не доказательство.` };
  }

  function priorityOf(score, followers, extra) {
    const { priority, priorityParts } = queuePriority(score, followers, extra.some(signal => signal.id === 'network_link'));
    return { value: priority, parts: priorityParts };
  }

  const networkSummary = cluster => cluster && cluster.size > 1 ? {
    id: cluster.id, size: cluster.size, riskyItems: cluster.riskyItems,
    accounts: cluster.accounts.slice(0, 8).map(account => ({ handle: account.handle, platform: account.platform, risky: account.risky, followers: account.followers })),
    shared: cluster.shared.slice(0, 6),
  } : null;

  function processNext(count) {
    const startedAt = now();
    const added = [];
    const logs = [];
    for (let n = 0; n < count && state.cursor < events.length; n++) {
      const event = events[state.cursor];
      const t0 = performance.now();
      const analyzed = analyzeEvent(event);
      const entry = entryOf(event, analyzed);
      attachKnownCodes(entry);
      const known = knownIndicatorSignal(entry, analyzed.result.analysis);
      if (known) {
        const lifted = applyExtraSignals(analyzed.result.analysis, [known]);
        entry.score = lifted.score;
        entry.category = lifted.category;
      }
      index.push(entry);
      const network = networkSignals(entry, buildNetworks(index));
      const { cluster } = network;
      const extra = [...(known ? [known] : []), ...network.extra];
      const analysis = extra.length ? applyExtraSignals(analyzed.result.analysis, extra) : analyzed.result.analysis;
      entry.score = analysis.score;
      entry.category = analysis.category;
      const latencyMs = Math.round((performance.now() - t0) * 100) / 100;
      const decision = analysis.score >= QUEUE_THRESHOLD ? 'queued' : 'cleared';
      state.cursor++;
      state.processed++;
      state.latencyTotalMs += latencyMs;
      state[decision]++;
      const isGroup = event.kind === 'group';
      const groundTruth = (isGroup ? event.group.groundTruth : event.item.groundTruth) ?? null;
      const kind = isGroup ? 'group' : event.item.type ?? 'post';
      logs.push({ id: event.id, at: new Date(now()).toISOString(), kind, handle: analyzed.handle, platform: analyzed.platform, score: analysis.score, level: analysis.level, category: analysis.category, decision, latencyMs, preview: String(analyzed.text ?? '').slice(0, 160), modalities: analysis.modalities ?? ['text'], groundTruth });
      if (decision !== 'queued') continue;
      const priority = priorityOf(analysis.score, analyzed.followers, extra);
      const result = analyzed.result;
      added.push({
        id: randomUUID(), source: 'pipeline', demo: true, status: 'new', kind,
        text: isGroup ? analyzed.text : event.item.text ?? '',
        ...(isGroup ? { url: event.group.inviteLink || '' } : {
          url: event.item.url || '',
          ...(event.item.ocrText ? { ocrText: event.item.ocrText } : {}),
          ...(event.item.transcript ? { transcript: event.item.transcript } : {}),
          ...(event.item.imageNote ? { imageNote: event.item.imageNote } : {}),
        }),
        platform: PLATFORMS.has(analyzed.platform) ? analyzed.platform : 'other', author: analyzed.handle, accountKey: analyzed.accountKey, followers: analyzed.followers,
        createdAt: new Date(now()).toISOString(), publishedAt: new Date(startedAt - (event.minutesAgo ?? 0) * 60000).toISOString(),
        analysis, analysisVersion, analyzedAt: new Date(now()).toISOString(),
        priority: priority.value, priorityParts: priority.parts,
        network: networkSummary(cluster),
        ...(isGroup ? { group: { title: event.group.title, messageCount: result.messageCount, roles: result.roles, templates: result.templates.slice(0, 3).map(cluster => ({ size: cluster.size, authors: cluster.authors.length, example: cluster.example })), evidence: result.evidence, counterMessages: result.counterMessages } } : {}),
        pipeline: { itemId: event.id, runId: state.runId, decision, latencyMs, groundTruth },
      });
    }
    if (!state.finishedAt && state.cursor >= events.length) state.finishedAt = new Date(now()).toISOString();
    state.log = [...logs.reverse(), ...state.log].slice(0, LOG_LIMIT);
    if (logs.length) {
      const cases = getCases();
      const known = new Set(cases.filter(record => record.pipeline?.runId === state.runId).map(record => record.pipeline.itemId));
      const fresh = added.filter(record => !known.has(record.pipeline.itemId));
      const next = withNetworkContext(fresh.length ? [...fresh, ...cases] : cases, fresh.length > 0);
      if (next !== cases) persistCases(next);
      save();
    }
    return { processed: logs.length, queued: added.length };
  }

  // Later items can reveal a network; earlier queued cases get the updated network context (their score is kept).
  function withNetworkContext(cases, added = false) {
    const networks = buildNetworks(index);
    let changed = added;
    const next = cases.map(record => {
      if (record.source !== 'pipeline' || record.pipeline?.runId !== state.runId) return record;
      const network = networkSummary(networks.find(item => item.itemIds.includes(record.pipeline.itemId)));
      if (JSON.stringify(network) === JSON.stringify(record.network ?? null)) return record;
      changed = true;
      return { ...record, network };
    });
    return changed ? next : cases;
  }

  function schedule() {
    clearTimeout(timer);
    if (closed || !state.enabled || state.cursor >= events.length) return;
    const rate = Math.min(50, Math.max(0.2, Number(state.rate) || 2));
    const batch = rate > 5 ? Math.round(rate / 5) : 1;
    timer = setTimeout(() => {
      try { processNext(batch); } catch (error) { console.error('Pipeline:', error); }
      schedule();
    }, Math.max(100, Math.round(1000 * batch / rate)));
    timer.unref?.();
  }

  function startRun() {
    state = { ...DEFAULT_STATE, enabled: true, rate: state.rate || DEFAULT_STATE.rate, runId: randomUUID(), startedAt: new Date(now()).toISOString() };
    index = [];
    save();
  }

  const api = {
    start() {
      if (!state.runId) { if (!autoStart) return; startRun(); }
      rebuildIndex();
      schedule();
    },
    snapshot({ logLimit = 80 } = {}) {
      const byCategory = {}, byPlatform = {}, byModality = { text: 0, ocrText: 0, transcript: 0 };
      for (const entry of state.log) {
        if (entry.decision === 'queued') byCategory[entry.category] = (byCategory[entry.category] ?? 0) + 1;
        byPlatform[entry.platform] = (byPlatform[entry.platform] ?? 0) + 1;
        for (const modality of entry.modalities ?? []) byModality[modality] = (byModality[modality] ?? 0) + 1;
      }
      const elapsed = state.startedAt ? ((state.finishedAt ? Date.parse(state.finishedAt) : now()) - Date.parse(state.startedAt)) / 1000 : 0;
      const labelled = state.log.filter(entry => entry.groundTruth !== null && entry.groundTruth !== undefined);
      const confusion = { tp: 0, fp: 0, tn: 0, fn: 0 };
      for (const entry of labelled) confusion[entry.groundTruth !== 'none' ? (entry.decision === 'queued' ? 'tp' : 'fn') : (entry.decision === 'queued' ? 'fp' : 'tn')]++;
      return {
        enabled: state.enabled, running: Boolean(state.enabled && state.cursor < events.length), finished: state.cursor >= events.length,
        rate: state.rate, cursor: state.cursor, total: events.length, processed: state.processed, queued: state.queued, cleared: state.cleared,
        threshold: QUEUE_THRESHOLD, startedAt: state.startedAt, finishedAt: state.finishedAt, elapsedSeconds: Math.round(elapsed),
        avgLatencyMs: state.processed ? Math.round(state.latencyTotalMs / state.processed * 100) / 100 : 0,
        corpus: { name: corpus.name, items: corpus.items.length, groups: (corpus.groups ?? []).length, accounts: (corpus.accounts ?? []).length, provenance: corpus.provenance ?? { type: 'synthetic' } },
        byCategory, byPlatform, byModality, streamQuality: labelled.length ? { ...confusion, labelled: labelled.length } : null,
        log: state.log.slice(0, logLimit),
      };
    },
    networks() {
      return networkSnapshot(index);
    },
    update(patch = {}) {
      if (patch.rate !== undefined) {
        const rate = Number(patch.rate);
        if (!Number.isFinite(rate) || rate < 0.2 || rate > 50) { const error = new Error('Скорость: от 0,2 до 50 публикаций в секунду.'); error.status = 400; throw error; }
        state.rate = rate;
      }
      if (patch.enabled !== undefined) {
        if (typeof patch.enabled !== 'boolean') { const error = new Error('enabled должен быть true или false.'); error.status = 400; throw error; }
        state.enabled = patch.enabled;
      }
      save();
      schedule();
      return api.snapshot();
    },
    reset() {
      // Reviewed decisions are analyst work and survive a demo restart; unreviewed demo items are replaced.
      persistCases(getCases().filter(record => record.source !== 'pipeline' || (record.status && record.status !== 'new')));
      corpus = loadCorpus(corpusPath);
      events = eventsOf(corpus);
      startRun();
      schedule();
      return api.snapshot();
    },
    step(count = 1) { return { ...processNext(count), snapshot: api.snapshot() }; },
    close() { closed = true; clearTimeout(timer); },
  };
  return api;
}

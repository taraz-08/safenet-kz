/** SafeNet KZ — Instagram and TikTok account handles, public-page extraction scripts and reference parsing.
 *  Pure functions; the headless browser and the discovery loop live in browser.mjs / social-discovery.mjs. */

export const PLATFORMS = Object.freeze(['instagram', 'tiktok']);
const IG_RESERVED = new Set(['p', 'reel', 'reels', 'explore', 'stories', 'accounts', 'direct', 'about', 'legal', 'developer', 'web', 'tv', 'tags', 'locations',
  'emails', 'challenge', 'privacy', 'terms', 'api', 'oauth', 'static', 'ar', 'sessions', 'graphql', 'nametag', 'invites', 'directory', 'lite', 'threads', 'meta', 'help', 'popular']);
const HANDLE = { instagram: /^[a-z0-9_](?:[a-z0-9_.]{0,28}[a-z0-9_])?$/, tiktok: /^[a-z0-9_](?:[a-z0-9_.]{0,22}[a-z0-9_])?$/ };
const bad = message => Object.assign(new Error(message), { status: 400 });

export function socialHandle(platform, value) {
  if (!PLATFORMS.includes(platform)) throw bad('Платформа: instagram или tiktok.');
  const handle = String(value ?? '').trim().replace(/^@/, '').replace(/\/+$/, '').toLowerCase();
  if (!HANDLE[platform].test(handle) || (platform === 'instagram' && IG_RESERVED.has(handle))) throw bad(`Некорректное имя аккаунта ${platform === 'tiktok' ? 'TikTok' : 'Instagram'}.`);
  return handle;
}

export const accountKey = (platform, handle) => `${platform}:${handle}`;
export const profileUrl = (platform, handle) => (platform === 'tiktok' ? `https://www.tiktok.com/@${handle}` : `https://www.instagram.com/${handle}/`);

/** A link or "platform:@handle" text → { platform, handle }, or null when it is not an account reference. */
export function socialRef(value) {
  const text = String(value ?? '').trim();
  let match = /^(?:https?:\/\/)?(?:(?:www|m)\.)?tiktok\.com\/@([A-Za-z0-9_.]{2,24})(?=[/?#\s]|$)/iu.exec(text);
  if (match) return safe('tiktok', match[1]);
  match = /^(?:https?:\/\/)?(?:(?:www|m)\.)?instagram\.com\/([A-Za-z0-9_.]{1,30})(?=[/?#\s]|$)/iu.exec(text);
  if (match) return safe('instagram', match[1]);
  match = /^(tiktok|tt|instagram|ig|insta)\s*:\s*@?([A-Za-z0-9_.]{1,30})$/iu.exec(text);
  if (match) return safe(/^t/i.test(match[1]) ? 'tiktok' : 'instagram', match[2]);
  return null;
}
function safe(platform, handle) { try { return { platform, handle: socialHandle(platform, handle) }; } catch { return null; } }

/** User input for a seed: a profile link, "tiktok:@name", or "@name" with an explicit platform. */
export function parseSocialInput(value, platform) {
  const text = String(value ?? '').trim();
  if (/^(?:https?:\/\/)?(?:vm|vt)\.tiktok\.com\//iu.test(text)) throw bad('Короткую ссылку vm.tiktok.com откройте в браузере и вставьте адрес профиля tiktok.com/@имя.');
  if (/instagram\.com\/(?:p|reel|reels)\//iu.test(text) && !/instagram\.com\/[^/]+\/(?:p|reel)\//iu.test(text)) throw bad('По ссылке на пост не видно автора — вставьте ссылку на профиль instagram.com/имя.');
  const ref = socialRef(text);
  if (ref) return ref;
  if (platform && /^@?[A-Za-z0-9_.]{1,30}$/u.test(text)) return { platform, handle: socialHandle(platform, text) };
  throw bad('Вставьте ссылку на профиль: tiktok.com/@имя или instagram.com/имя.');
}

/** Page script for a public profile. Returns JSON text: profile text, recent post captions and visible links. */
export const EXTRACT_PROFILE = String.raw`(async () => {
  const tiktok = /tiktok\.com$/.test(location.hostname);
  const page = () => document.body ? document.body.innerText : '';
  // Profiles render in steps: wait (up to ~20 s) for the post grid or a definite "missing / private / blocked" state.
  const settled = () => tiktok
    ? document.querySelector('a[href*="/video/"], a[href*="/photo/"], #captcha-verify-container') || /couldn.t find this account|не удалось найти|закрытый аккаунт|account is private|no content|нет контента|ещё не опубликовал/i.test(page())
    : document.querySelector('a[href*="/p/"], a[href*="/reel/"]') || /isn.t available|недоступна|закрытый аккаунт|account is private|no posts yet|публикаций пока нет/i.test(page()) || /^\/(?:accounts\/login|challenge)/.test(location.pathname);
  for (let i = 0; i < 40 && !settled(); i++) await new Promise(resolve => setTimeout(resolve, 500));
  await new Promise(resolve => setTimeout(resolve, 800));
  const body = page();
  const meta = key => (document.querySelector('meta[property="' + key + '"]') || document.querySelector('meta[name="' + key + '"]') || {}).content || '';
  const text = el => (el && el.innerText || '').trim();
  const out = { url: location.href, title: document.title, description: meta('og:description') || meta('description'), name: '', bio: '', followers: '',
    loginWall: false, captcha: false, notFound: false, private: false, links: [], posts: [] };
  const seen = new Set();
  const addPost = (href, caption) => { if (!href || seen.has(href) || !caption || caption.length < 8) return; seen.add(href); out.posts.push({ url: href.split('?')[0], text: caption.slice(0, 2200) }); };
  if (tiktok) {
    out.captcha = Boolean(document.querySelector('#captcha-verify-container, .captcha_verify_container, [id*="captcha-verify"]')) || /перетащите ползунок|drag the (?:slider|puzzle)|verify to continue/i.test(body);
    out.notFound = /couldn.t find this account|не удалось найти эту учетную запись|не удалось найти этот аккаунт/i.test(body);
    out.private = /this account is private|это закрытый аккаунт|аккаунт закрыт/i.test(body);
    out.name = text(document.querySelector('[data-e2e="user-title"]')) + ' ' + text(document.querySelector('[data-e2e="user-subtitle"]'));
    out.bio = text(document.querySelector('[data-e2e="user-bio"]'));
    out.followers = text(document.querySelector('[data-e2e="followers-count"]'));
    const link = document.querySelector('[data-e2e="user-link"]');
    if (link) out.links.push(link.href || text(link));
    try {
      const data = JSON.parse(document.getElementById('__UNIVERSAL_DATA_FOR_REHYDRATION__').textContent).__DEFAULT_SCOPE__['webapp.user-detail'].userInfo.user;
      if (!out.bio) out.bio = data.signature || '';
      if (data.bioLink && data.bioLink.link) out.links.push(data.bioLink.link);
    } catch (error) { /* the server-rendered profile data is optional */ }
    for (const a of document.querySelectorAll('a[href*="/video/"], a[href*="/photo/"]')) { const img = a.querySelector('img[alt]'); addPost(a.href, img ? img.alt : a.getAttribute('aria-label')); }
  } else {
    out.loginWall = /^\/(?:accounts\/login|challenge)/.test(location.pathname);
    out.notFound = /sorry, this page isn.t available|эта страница недоступна|страница недоступна/i.test(body);
    out.private = /this account is private|это закрытый аккаунт/i.test(body);
    const header = document.querySelector('header');
    out.bio = text(header).replace(/\n+/g, '\n');
    out.name = document.title.replace(/\s*[•|].*$/, '');
    for (const a of (header ? header.querySelectorAll('a[href]') : [])) {
      let href = a.href;
      try { const u = new URL(href); if (u.hostname === 'l.instagram.com') href = u.searchParams.get('u') || href; } catch (error) { /* keep as is */ }
      if (!/instagram\.com\/(?:[^/]+\/)?(?:followers|following)/.test(href)) out.links.push(href);
    }
    for (const a of document.querySelectorAll('a[href]')) { if (/instagram\.com\/(?:[^/]+\/)?(?:p|reel)\/[A-Za-z0-9_-]+/.test(a.href)) { const img = a.querySelector('img[alt]'); addPost(a.href, img ? img.alt : ''); } }
  }
  out.posts = out.posts.slice(0, 24);
  out.links = [...new Set(out.links.filter(Boolean))].slice(0, 20);
  return JSON.stringify(out);
})()`;

/** Profile header text → the author's words: counters, "more" buttons and repeated lines are dropped. */
export function cleanBio(text) {
  const counter = /^[\d\s.,]+\s*(?:k|m|тыс\.?|млн)?\s*(?:подписчик|подписок|публикац|followers?|following|posts?|жазылушы|жазылым|жарияланым|лайк|likes?)\p{L}*$/iu;
  const seen = new Set();
  return String(text ?? '').split('\n').map(line => line.trim())
    .filter(line => line && !counter.test(line) && !/^(?:ещё|еще|more|тағы|…|\.\.\.|п…)$/iu.test(line) && !seen.has(line.toLowerCase()) && seen.add(line.toLowerCase()))
    .join('\n');
}

/** Thumbnail text → the author's words. TikTok: «caption» от автора X с композицией …
 *  Instagram: "Photo by X on <date>." + an automatic description; only the text recognised in the image is kept. */
export function cleanCaption(platform, text) {
  const value = String(text ?? '').trim();
  if (platform === 'tiktok') {
    const match = /^[«"“](.*)[»"”]\s+(?:от автора|created by|by)\s/su.exec(value);
    return (match ? match[1] : value).trim();
  }
  const rest = value.replace(/^(?:Photo|Video|Фото|Видео)(?: shared)?\s+by\s+.*?\s+on\s+[^.]*?\d{4}(?:\s+tagging\s+[^.]*)?\.\s*/su, '');
  if (rest === value) return value;
  const quoted = [...rest.matchAll(/(?:текст|text that says|text)\s*[«"'“]([^«»"'“”]{3,})[»"'”]/giu)].map(match => match[1].trim());
  return quoted.join('\n');
}

const URLISH = /(?:https?:\/\/)?(?:[a-z0-9-]+\.)+[a-z]{2,24}(?:\/[^\s"'<>«»()]*)?/giu;
const MENTION = /(?<![\p{L}\p{N}_.@/])@([A-Za-z0-9_.]{2,30})(?![A-Za-z0-9_])/gu;
const SOCIAL_HOSTS = /(?:^|\.)(?:instagram\.com|tiktok\.com|t\.me|telegram\.me|facebook\.com|youtube\.com|youtu\.be|wa\.me|whatsapp\.com|google\.com|apple\.com|linktr\.ee)$/iu;

/** Accounts and channels a profile points to: @mentions (same platform), profile links on either platform, t.me channels, other domains. */
export function socialReferences(platform, self, data) {
  const accounts = new Map(), telegram = new Map(), domains = new Set();
  const addAccount = (ref, kind, postUrl) => { if (!ref || (ref.platform === platform && ref.handle === self)) return; const key = accountKey(ref.platform, ref.handle); if (!accounts.has(key)) accounts.set(key, { ...ref, kind, postUrl: postUrl ?? null }); };
  const sources = [{ text: data.bio ?? '', url: null, links: data.links ?? [] }, ...(data.posts ?? []).map(post => ({ text: post.text, url: post.url, links: [] }))];
  for (const source of sources) {
    for (const match of source.text.matchAll(MENTION)) addAccount(safe(platform, match[1].replace(/\.+$/, '')), 'mention', source.url);
    for (const raw of [...source.links, ...source.text.match(URLISH) ?? []]) {
      const link = raw.replace(/[.,;:!?]+$/, '');
      const ref = socialRef(link);
      if (ref) { addAccount(ref, 'link', source.url); continue; }
      const tg = /^(?:https?:\/\/)?(?:t\.me|telegram\.me)\/(?:s\/)?([A-Za-z][A-Za-z0-9_]{4,31})(?:[/?#]|$)/iu.exec(link);
      if (tg) { const handle = tg[1].toLowerCase(); if (!handle.endsWith('bot') && !telegram.has(handle)) telegram.set(handle, { handle, postUrl: source.url }); continue; }
      try {
        const host = new URL(/^https?:/i.test(link) ? link : `https://${link}`).hostname.toLowerCase().replace(/^www\./, '');
        if (host.includes('.') && !SOCIAL_HOSTS.test(host) && !/^\d+(?:\.\d+)+$/.test(host)) domains.add(host);
      } catch { /* not a link */ }
    }
  }
  return { accounts: [...accounts.values()], telegram: [...telegram.values()], domains: [...domains].slice(0, 20) };
}

/** DuckDuckGo Lite result page → [{ url, title, snippet }]. */
export function parseSearchResults(html) {
  const decode = value => value.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').trim();
  const links = [...String(html).matchAll(/<a rel="nofollow" href="([^"]+)" class=['"]result-link['"]>([\s\S]*?)<\/a>/gu)];
  const snippets = [...String(html).matchAll(/class=['"]result-snippet['"]>([\s\S]*?)<\/td>/gu)];
  return links.map((match, index) => ({ url: decode(match[1]), title: decode(match[2]), snippet: decode(snippets[index]?.[1] ?? '') }))
    .filter(item => /^https?:\/\//.test(item.url) && !/\/api\/img\//.test(item.url));
}

/** A search hit → the account it belongs to. Instagram post hits name their author in the snippet ("name on June 1, 2026:"). */
export function searchHitAccount(hit) {
  const direct = socialRef(hit.url);
  if (direct) return direct;
  if (/instagram\.com\/(?:p|reel)\//iu.test(hit.url)) {
    const match = /(?:^|\s)([A-Za-z0-9_.]{2,30}) on [A-Z][a-z]+ \d{1,2}, \d{4}/u.exec(hit.snippet) ?? /\(@([A-Za-z0-9_.]{2,30})\)/u.exec(`${hit.title} ${hit.snippet}`);
    if (match) return safe('instagram', match[1]);
  }
  return null;
}

import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import http from 'node:http';
import https from 'node:https';
import { createHash } from 'node:crypto';

export const LINK_INSPECTOR_LIMITS = Object.freeze({ timeoutMs: 8000, maxBytes: 256 * 1024, maxRedirects: 5 });
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const SHORTENERS = new Set(['bit.ly', 't.co', 'tinyurl.com', 't.ly', 'cutt.ly', 'is.gd', 'goo.gl', 'rebrand.ly', 'rb.gy']);
const USER_AGENTS = {
  desktop: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 SafeNetLinkInspector/1.0',
  mobile: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36 SafeNetLinkInspector/1.0',
};

function failure(code, message) { return Object.assign(new Error(message), { code }); }
function ipv4Number(address) { return address.split('.').reduce((value, part) => value * 256 + Number(part), 0); }
function inV4(address, network, bits) {
  const size = 2 ** (32 - bits);
  return Math.floor(ipv4Number(address) / size) === Math.floor(ipv4Number(network) / size);
}
function ipv6Number(address) {
  // IPv4-mapped/translated notation is intentionally disallowed before expansion.
  if (address.includes('.') || address.includes('%')) return null;
  const halves = address.split('::');
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length > 1 && halves[1] ? halves[1].split(':') : [];
  const groups = halves.length === 1 ? left : [...left, ...Array(8 - left.length - right.length).fill('0'), ...right];
  if (groups.length !== 8) return null;
  return groups.reduce((number, group) => (number << 16n) + BigInt(parseInt(group, 16)), 0n);
}
function inV6(address, network, bits) {
  const shift = BigInt(128 - bits);
  return (address >> shift) === (ipv6Number(network) >> shift);
}

/** Conservative public-unicast allowlist, rejecting every private/special-use answer. */
export function isPublicAddress(address) {
  if (isIP(address) === 4) {
    return ![
      ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
      ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
      ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
      ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
    ].some(([network, bits]) => inV4(address, network, bits));
  }
  if (isIP(address) !== 6) return false;
  const number = ipv6Number(address);
  if (number === null || !inV6(number, '2000::', 3)) return false;
  return ![
    ['2001::', 23], // IETF special-purpose, Teredo, benchmarking and ORCHID ranges.
    ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20],
  ].some(([network, bits]) => inV6(number, network, bits));
}

function normalizedUrl(input) {
  if (typeof input !== 'string' || input.length > 4096) throw failure('INVALID_URL', 'Укажите ссылку длиной до 4096 символов.');
  let url;
  try { url = new URL(input.trim()); } catch { throw failure('INVALID_URL', 'Укажите полную ссылку http:// или https://.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || /^(?:https?):\/\/[^/?#]*@/i.test(input.trim())) {
    throw failure('INVALID_URL', 'Разрешены только HTTP(S)-ссылки без данных авторизации.');
  }
  if (url.port && !['80', '443'].includes(url.port)) throw failure('INVALID_URL', 'Разрешены только порты 80 и 443.');
  if (!url.hostname || /[\u0000-\u0020\u007f]/.test(input.trim())) throw failure('INVALID_URL', 'Некорректная ссылка.');
  url.hash = '';
  return url;
}

function abortable(promise, signal) {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const aborted = () => { cleanup(); reject(signal.reason); };
    const cleanup = () => signal.removeEventListener('abort', aborted);
    signal.addEventListener('abort', aborted, { once: true });
    Promise.resolve(promise).then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
  });
}

/** A socket cannot resolve the hostname again after validation, including all:true callers. */
export function createPinnedLookup(address, family) {
  return (_hostname, options, callback) => {
    if (typeof options === 'function') { callback = options; options = {}; }
    queueMicrotask(() => options?.all ? callback(null, [{ address, family }]) : callback(null, address, family));
  };
}

async function resolvePinned(url, resolve, signal) {
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  let answers;
  try {
    answers = isIP(hostname) ? [{ address: hostname, family: isIP(hostname) }]
      : await abortable(resolve(hostname, { all: true, verbatim: true }), signal);
  } catch (error) {
    if (signal.aborted) throw signal.reason;
    throw failure('DNS_ERROR', 'Не удалось разрешить имя сервера.');
  }
  if (!Array.isArray(answers) || !answers.length) throw failure('DNS_ERROR', 'Сервер не имеет доступных DNS-адресов.');
  if (answers.some(answer => !isPublicAddress(answer.address) || Number(answer.family) !== isIP(answer.address))) {
    throw failure('BLOCKED_ADDRESS', 'Ссылка ведёт на локальный, зарезервированный или недопустимый адрес.');
  }
  return { hostname, address: answers[0].address, family: Number(answers[0].family) };
}

function boundedTransport({ url, lookup, servername, headers, signal, maxBytes }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, value) => { if (settled) return; settled = true; error ? reject(error) : resolve(value); };
    const client = url.protocol === 'https:' ? https : http;
    const request = client.request(url, {
      method: 'GET', headers, lookup, servername, signal, agent: false, maxHeaderSize: 16 * 1024,
      rejectUnauthorized: true,
    }, response => {
      const chunks = [];
      let bytes = 0;
      const result = truncated => ({ statusCode: response.statusCode, headers: response.headers, body: Buffer.concat(chunks, bytes), bytes, truncated });
      if (REDIRECTS.has(response.statusCode) && response.headers.location) {
        finish(null, result(false)); response.destroy(); return;
      }
      response.on('data', chunk => {
        const remaining = maxBytes - bytes;
        if (remaining > 0) { const piece = chunk.subarray(0, remaining); chunks.push(piece); bytes += piece.length; }
        if (chunk.length > remaining) { finish(null, result(true)); response.destroy(); }
      });
      response.once('end', () => finish(null, result(false)));
      response.once('error', error => finish(error));
      response.once('aborted', () => finish(failure('REQUEST_ERROR', 'Сервер прервал ответ.')));
    });
    request.once('error', error => finish(error));
    request.end();
  });
}

function header(headers, name) {
  const value = Object.entries(headers || {}).find(([key]) => key.toLowerCase() === name)?.[1];
  return Array.isArray(value) ? String(value[0] || '') : String(value || '');
}
function readableText(body, contentType) {
  if (!/^(text\/|application\/(?:xhtml\+xml|json))/i.test(contentType)) return '';
  return body.toString('utf8').replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, ' ').replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;|&#160;/gi, ' ').replace(/&amp;/gi, '&').replace(/\s+/g, ' ').trim();
}
const hash = value => createHash('sha256').update(value).digest('hex');

/** Read-only bounded inspection. Dependencies exist for deterministic, network-free tests. */
export async function inspectLink({ url: input, compare = true } = {}, dependencies = {}) {
  const original = normalizedUrl(input);
  const timeoutMs = Math.max(1, Math.min(LINK_INSPECTOR_LIMITS.timeoutMs, dependencies.timeoutMs ?? LINK_INSPECTOR_LIMITS.timeoutMs));
  const maxBytes = Math.max(1, Math.min(LINK_INSPECTOR_LIMITS.maxBytes, dependencies.maxBytes ?? LINK_INSPECTOR_LIMITS.maxBytes));
  const maxRedirects = Math.max(0, Math.min(LINK_INSPECTOR_LIMITS.maxRedirects, dependencies.maxRedirects ?? LINK_INSPECTOR_LIMITS.maxRedirects));
  const resolve = dependencies.resolve || dnsLookup;
  const transport = dependencies.transport || boundedTransport;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(failure('TIMEOUT', 'Проверка превысила лимит времени.')), timeoutMs);
  const signals = [];
  const signalKeys = new Set();
  const addSignal = (id, label, description, quote, severity = 'info', variant = 'desktop', sourceUrl) => {
    const key = `${variant}:${id}:${quote}`;
    if (!signalKeys.has(key)) { signalKeys.add(key); signals.push({ id, label, description, quote, severity, variant, ...(sourceUrl ? {sourceUrl} : {}) }); }
  };
  function inspectPageText(page, variant) {
    const gambling = /(?:казино|casino|букмекер|ставк[аиу]|betting|құмар\s*ойын|бәс\s*тіг)[\s\S]{0,180}(?:бонус|bonus|депозит|deposit|регистр|тіркел|игра[йт]|play)|(?:бонус|bonus|депозит|deposit|тіркел)[\s\S]{0,180}(?:казино|casino|букмекер|betting|құмар\s*ойын|бәс\s*тіг)/iu.exec(page.text);
    if (gambling) addSignal('gambling_promotion', 'Возможное продвижение азартных игр', 'В тексте рядом обнаружены упоминания азартных игр и стимулирующего предложения. Новость или предупреждение могут содержать те же слова.', gambling[0].slice(0, 250), 'warning', variant, page.finalUrl);
  }
  async function follow(variant) {
    let current = original;
    const hops = [];
    const seen = new Set();
    for (let redirects = 0; ; redirects++) {
      if (controller.signal.aborted) throw controller.signal.reason;
      if (seen.has(current.href)) throw failure('REDIRECT_LIMIT', 'Обнаружен цикл перенаправлений.');
      seen.add(current.href);
      const pinned = await resolvePinned(current, resolve, controller.signal);
      if (variant === 'desktop') {
        if (current.hostname.split('.').some(label => label.startsWith('xn--'))) addSignal('punycode', 'Международное доменное имя', 'Punycode может обозначать обычное международное имя или похожий на известный домен. Проверьте написание.', current.hostname);
        if (SHORTENERS.has(current.hostname.replace(/^www\./, ''))) addSignal('shortener', 'Сокращённая ссылка', 'Сокращение скрывает конечный адрес до перехода; само по себе это не доказывает обман.', current.hostname);
      }
      let response;
      try {
        response = await abortable(transport({
          url: current, ...pinned, lookup: createPinnedLookup(pinned.address, pinned.family),
          servername: isIP(pinned.hostname) ? undefined : pinned.hostname,
          headers: { 'User-Agent': USER_AGENTS[variant], Accept: 'text/html,text/plain;q=0.9,*/*;q=0.1', 'Accept-Encoding': 'identity' },
          signal: controller.signal, maxBytes, timeoutMs,
        }), controller.signal);
      } catch (error) {
        if (controller.signal.aborted) throw controller.signal.reason;
        throw failure(error.code === 'TIMEOUT' ? 'TIMEOUT' : 'REQUEST_ERROR', 'Не удалось безопасно получить ответ сайта.');
      }
      const received = Buffer.isBuffer(response.body) ? response.body : Buffer.from(response.body || '');
      const body = received.subarray(0, maxBytes);
      const truncated = !!response.truncated || received.length > maxBytes;
      const contentType = header(response.headers, 'content-type').slice(0, 200);
      const status = Number(response.statusCode ?? response.status);
      if (!Number.isInteger(status) || status < 100 || status > 599) throw failure('REQUEST_ERROR', 'Некорректный ответ сайта.');
      const location = header(response.headers, 'location');
      const hop = { url: current.href, status, contentType, bytes: body.length, truncated };
      hops.push(hop);
      if (REDIRECTS.has(status) && location) {
        if (redirects >= maxRedirects) throw failure('REDIRECT_LIMIT', 'Превышен лимит перенаправлений.');
        let next;
        try { next = normalizedUrl(new URL(location, current).href); } catch (error) { throw failure('INVALID_URL', 'Перенаправление ведёт на недопустимую ссылку.'); }
        hop.location = next.href;
        if (variant === 'desktop' && next.hostname !== current.hostname) addSignal('external_redirect', 'Перенаправление на другой домен', 'Переход меняет домен. Это может быть обычная навигация или партнёрская ссылка; проверьте конечный адрес.', `${current.hostname} → ${next.hostname}`);
        current = next;
        continue;
      }
      return { finalUrl: current.href, hops, body, text: readableText(body, contentType), truncated, contentType };
    }
  }
  try {
    const desktop = await follow('desktop');
    inspectPageText(desktop, 'desktop');
    const comparison = { requested: !!compare, available: false, note: 'Сравнение не запрошено.' };
    if (compare) {
      try {
        const mobile = await follow('mobile');
        inspectPageText(mobile, 'mobile');
        comparison.available = true;
        comparison.desktopHash = hash(desktop.body);
        comparison.mobileHash = hash(mobile.body);
        comparison.bodyDifferent = comparison.desktopHash !== comparison.mobileHash;
        // Equal bodies (e.g. an empty or blocked response) do not imply equal routes.
        const routeFingerprint = page => JSON.stringify(page.hops.map(hop => [hop.url, hop.status, hop.location || null]));
        comparison.routeDifferent = desktop.finalUrl !== mobile.finalUrl || routeFingerprint(desktop) !== routeFingerprint(mobile);
        comparison.different = comparison.bodyDifferent || comparison.routeDifferent;
        comparison.desktopFinalUrl = desktop.finalUrl;
        comparison.mobileFinalUrl = mobile.finalUrl;
        comparison.desktopStatus = desktop.hops.at(-1)?.status;
        comparison.mobileStatus = mobile.hops.at(-1)?.status;
        comparison.mobileHops = mobile.hops;
        comparison.truncated = desktop.truncated || mobile.truncated;
        comparison.note = comparison.different
          ? 'Ответы или маршрут для desktop/mobile User-Agent отличаются. Причиной могут быть адаптивная версия, реклама или динамические данные. Это не доказательство клоакинга.'
          : 'Полученные ограниченные ответы и маршруты совпадают. Это не исключает различий для других посетителей.';
      } catch (error) {
        comparison.errorCode = error.code || 'REQUEST_ERROR';
        comparison.note = 'Мобильный вариант не удалось получить в безопасных пределах. Сравнение недоступно.';
      }
    }
    return {
      url: original.href, finalUrl: desktop.finalUrl, hops: desktop.hops, signals, comparison,
      limitations: [
        'Только HTTP(S), порты 80/443, общедоступные IP. Каждый переход повторно проверяется; соединение закреплено за проверенным DNS-адресом.',
        'Не более 5 перенаправлений на вариант, 8 секунд суммарно и 256 КиБ каждого ответа. Более длинный ответ усечён.',
        'JavaScript не выполняется. Авторизация, cookies, формы, видео и изображения не используются. Проверка не отправляет ваши браузерные данные.',
        'Признаки и различия ответов не являются доказательством мошенничества, незаконности или клоакинга.',
        ...(desktop.truncated ? ['Ответ усечён; признаки за пределами полученного фрагмента не анализировались.'] : []),
      ],
    };
  } finally { clearTimeout(timeout); controller.abort(failure('CANCELLED', 'Проверка завершена.')); }
}

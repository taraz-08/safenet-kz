// Scope and fields verified against Meta's official API documentation:
// https://br-fr.facebook.com/ads/library/api/ (2026-10-24).
// Access/identity approval belongs to the operator; configuration is not verification.
export const META_LIBRARY_LIMITS = Object.freeze({ queryLength: 100, items: 25, timeoutMs: 10_000, responseBytes: 512 * 1024 });
const DOCS_URL = 'https://www.facebook.com/ads/library/api/';
const PUBLIC_URL = 'https://www.facebook.com/ads/library/';
const EU_UK = Object.freeze('AT BE BG HR CY CZ DK EE FI FR DE GR HU IE IT LV LT LU MT NL PL PT RO SK SI ES SE GB'.split(' '));
const ISO_COUNTRIES = new Set(('AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW').split(' '));
const FIELDS = 'id,ad_creative_bodies,ad_creative_link_titles,ad_creative_link_descriptions,ad_snapshot_url,page_id,page_name,publisher_platforms,ad_delivery_start_time,ad_delivery_stop_time';
const SAFE_ERROR = Symbol('safe-meta-connector-error');

function error(code, message, status = 400) { return Object.assign(new Error(message), { code, status, [SAFE_ERROR]: true }); }
function configuration(env = process.env) {
  const rawToken = env.SAFENET_META_ACCESS_TOKEN;
  const rawVersion = env.SAFENET_META_API_VERSION;
  const token = typeof rawToken === 'string' ? rawToken.trim() : '';
  const version = typeof rawVersion === 'string' ? rawVersion.trim() : '';
  const invalidToken = !!token && (token.length > 8192 || /\s|[\u0000-\u001f\u007f]/.test(token));
  const invalidVersion = !!version && !/^v[1-9]\d{0,2}\.0$/.test(version);
  return { token, version, invalid: invalidToken || invalidVersion, configured: !!token && !!version && !invalidToken && !invalidVersion };
}

/** No network access and no credential values are exposed by this status. */
export function getMetaLibraryStatus({ env = process.env } = {}) {
  const config = configuration(env);
  return {
    configured: config.configured,
    status: config.invalid ? 'invalid_configuration' : config.configured ? 'configured' : 'not_configured',
    apiVersion: config.version && !config.invalid ? config.version : null,
    accessVerified: false,
    publicLibraryUrl: PUBLIC_URL,
    docsUrl: DOCS_URL,
    limits: META_LIBRARY_LIMITS,
    scope: { political: 'worldwide', allCountries: [...EU_UK] },
    message: config.invalid ? 'Проверьте SAFENET_META_ACCESS_TOKEN и формат SAFENET_META_API_VERSION (например vNN.0).'
      : config.configured ? 'Параметры заданы. Доступ Meta и разрешения не проверены; результат зависит от одобрения аккаунта и действительности токена.'
        : 'Для API нужны SAFENET_META_ACCESS_TOKEN и SAFENET_META_API_VERSION, а также одобренный Meta доступ. Публичная библиотека доступна отдельно.',
  };
}

function validateInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw error('INVALID_QUERY', 'Передайте параметры поиска.');
  if (typeof input.query !== 'string') throw error('INVALID_QUERY', 'Введите поисковый запрос.');
  const query = input.query.trim();
  if (!query || [...query].length > META_LIBRARY_LIMITS.queryLength || /[\u0000-\u001f\u007f]/.test(query)) {
    throw error('INVALID_QUERY', 'Поисковый запрос должен содержать от 1 до 100 символов без управляющих символов.');
  }
  const country = typeof input.country === 'string' ? input.country.trim().toUpperCase() : 'KZ';
  if (!/^[A-Z]{2}$/.test(country) || !ISO_COUNTRIES.has(country)) throw error('INVALID_QUERY', 'Укажите известный двухбуквенный ISO-код страны, например KZ или GB.');
  const adType = input.adType ?? 'POLITICAL_AND_ISSUE_ADS';
  if (!['POLITICAL_AND_ISSUE_ADS', 'ALL'].includes(adType)) throw error('INVALID_QUERY', 'Поддерживаются только ALL и POLITICAL_AND_ISSUE_ADS.');
  if (adType === 'ALL' && !EU_UK.includes(country)) {
    throw error('UNSUPPORTED_SCOPE', 'Официальный API Meta предоставляет все категории рекламы только для ЕС и Великобритании. Для KZ и других стран используйте POLITICAL_AND_ISSUE_ADS либо публичную библиотеку.');
  }
  return { query, country, adType };
}

function abortable(promise, signal) {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const cleanup = () => signal.removeEventListener('abort', abort);
    const abort = () => { cleanup(); reject(signal.reason); };
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise).then(value => { cleanup(); resolve(value); }, reason => { cleanup(); reject(reason); });
  });
}

async function boundedJson(response, signal, byteLimit) {
  const contentLength = Number(response.headers?.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > byteLimit) {
    response.body?.cancel().catch(() => {});
    throw error('RESPONSE_TOO_LARGE', 'Ответ Meta превысил безопасный лимит 512 КиБ.', 502);
  }
  if (!response.body?.getReader) throw error('INVALID_RESPONSE', 'Meta вернула недоступный для чтения ответ.', 502);
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await abortable(reader.read(), signal);
      if (done) break;
      bytes += value.byteLength;
      if (bytes > byteLimit) throw error('RESPONSE_TOO_LARGE', 'Ответ Meta превысил безопасный лимит 512 КиБ.', 502);
      chunks.push(Buffer.from(value));
    }
    try { return JSON.parse(Buffer.concat(chunks, bytes).toString('utf8')); }
    catch { throw error('INVALID_RESPONSE', 'Meta вернула некорректный JSON.', 502); }
  } finally {
    reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

function normalizeRecord(record, token) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return null;
  const id = String(record.id ?? '');
  if (!/^\d{1,40}$/.test(id)) return null;
  const clean = (value, max = 30000) => typeof value === 'string' ? value.split(token).join('[REDACTED]').slice(0, max) : '';
  const parts = [record.ad_creative_bodies, record.ad_creative_link_titles, record.ad_creative_link_descriptions]
    .flatMap(value => Array.isArray(value) ? value.slice(0, 25).map(part => clean(part)) : []);
  const text = [...new Set(parts.filter(Boolean))].join('\n').slice(0, 30000);
  const knownPlatforms = new Set(['facebook', 'instagram', 'messenger', 'audience_network', 'whatsapp', 'oculus', 'threads', 'streaming_services']);
  const platforms = Array.isArray(record.publisher_platforms)
    ? [...new Set(record.publisher_platforms.filter(value => typeof value === 'string').map(value => value.toLowerCase()).filter(value => knownPlatforms.has(value)))] : [];
  // Meta's documented snapshot URLs may embed access_token. Reconstruct from the numeric ad ID;
  // do not expose raw snapshot URLs, paging URLs, arbitrary provider fields or credentials.
  const url = new URL('https://www.facebook.com/ads/archive/render_ad/');
  url.searchParams.set('id', id);
  return {
    id, text, url: url.href, author: clean(record.page_name, 200),
    platform: platforms.includes('instagram') ? 'instagram' : platforms.includes('whatsapp') ? 'whatsapp' : 'other',
    platforms, source: 'meta_ad_library', pageId: /^\d{1,40}$/.test(String(record.page_id ?? '')) ? String(record.page_id) : '',
    deliveryStart: clean(record.ad_delivery_start_time, 64), deliveryStop: clean(record.ad_delivery_stop_time, 64),
  };
}

/** One explicit read-only query. No token discovery, pagination, account setup or persistence. */
export async function searchMetaLibrary(input, dependencies = {}) {
  const parameters = validateInput(input);
  const config = configuration(dependencies.env || process.env);
  if (config.invalid) throw error('INVALID_CONFIGURATION', 'Некорректные настройки Meta API. Проверьте токен и явно заданную версию vNN.0.', 503);
  if (!config.configured) throw error('NOT_CONFIGURED', 'Официальный Meta API не настроен. Задайте токен и версию API на сервере либо используйте публичную библиотеку.', 503);
  if (parameters.query.includes(config.token)) throw error('INVALID_QUERY', 'Не используйте данные авторизации в поисковом запросе.');
  const requestUrl = new URL(`https://graph.facebook.com/${config.version}/ads_archive`);
  requestUrl.searchParams.set('search_terms', parameters.query);
  requestUrl.searchParams.set('ad_reached_countries', JSON.stringify([parameters.country]));
  requestUrl.searchParams.set('ad_type', parameters.adType);
  requestUrl.searchParams.set('ad_active_status', 'ALL');
  requestUrl.searchParams.set('fields', FIELDS);
  requestUrl.searchParams.set('limit', String(META_LIBRARY_LIMITS.items));
  const controller = new AbortController();
  const timeoutMs = Math.max(1, Math.min(META_LIBRARY_LIMITS.timeoutMs, dependencies.timeoutMs ?? META_LIBRARY_LIMITS.timeoutMs));
  const byteLimit = Math.max(1, Math.min(META_LIBRARY_LIMITS.responseBytes, dependencies.maxBytes ?? META_LIBRARY_LIMITS.responseBytes));
  const timeout = setTimeout(() => controller.abort(error('TIMEOUT', 'Meta API не ответила в течение 10 секунд.', 504)), timeoutMs);
  try {
    let response;
    try {
      response = await abortable((dependencies.fetch || globalThis.fetch)(requestUrl, {
        method: 'GET', headers: { Authorization: `Bearer ${config.token}`, Accept: 'application/json' },
        redirect: 'error', credentials: 'omit', signal: controller.signal,
      }), controller.signal);
    } catch {
      if (controller.signal.aborted) throw controller.signal.reason;
      throw error('UPSTREAM_ERROR', 'Не удалось получить ответ официального Meta API. Проверьте сеть и настройки доступа.', 502);
    }
    if (response.status === 401 || response.status === 403) {
      response.body?.cancel().catch(() => {});
      throw error('UPSTREAM_AUTH', 'Meta отклонила доступ. Проверьте действительность токена и разрешения аккаунта.', 502);
    }
    if (!response.ok || response.redirected) {
      response.body?.cancel().catch(() => {});
      throw error('UPSTREAM_ERROR', 'Официальный Meta API отклонил запрос. Проверьте разрешения, версию API и доступность выбранного охвата.', 502);
    }
    const payload = await boundedJson(response, controller.signal, byteLimit);
    if (payload?.error) throw error('UPSTREAM_ERROR', 'Официальный Meta API вернул ошибку. Проверьте настройки доступа и выбранный охват.', 502);
    if (!Array.isArray(payload?.data)) throw error('INVALID_RESPONSE', 'Meta вернула ответ без списка объявлений.', 502);
    const records = payload.data.slice(0, META_LIBRARY_LIMITS.items).map(record => normalizeRecord(record, config.token)).filter(Boolean);
    return {
      records, count: records.length, hasMore: !!payload.paging?.next || payload.data.length > META_LIBRARY_LIMITS.items,
      pageLimit: 1, ...parameters,
      limitations: [
        'Получена только первая страница, до 25 объявлений. Это не полная выборка и не мониторинг всей платформы.',
        'Для KZ официальный API охватывает только общественно-политическую рекламу. Все категории доступны лишь для ЕС и Великобритании.',
        'Наличие рекламы в библиотеке не подтверждает её безопасность или мошеннический характер.',
        'Токен не передаётся браузеру. Ссылки на снимки очищены от данных авторизации; Meta может потребовать вход для просмотра.',
      ],
    };
  } catch (cause) {
    if (controller.signal.aborted) throw controller.signal.reason;
    if (cause?.[SAFE_ERROR]) throw cause;
    // Never propagate transport/provider messages: they may contain credentials or request URLs.
    throw error('UPSTREAM_ERROR', 'Не удалось обработать ответ официального Meta API.', 502);
  } finally { clearTimeout(timeout); controller.abort(); }
}

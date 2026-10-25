import { inspectLink } from './link-inspector.mjs';
import { getMetaLibraryStatus, searchMetaLibrary } from './meta-library.mjs';

const kkSignals = {
  punycode: ['Халықаралық домен атауы', 'Punycode қалыпты халықаралық атау да, таныс доменге ұқсас атау да болуы мүмкін. Жазылуын тексеріңіз.'],
  shortener: ['Қысқартылған сілтеме', 'Қысқартылған сілтеме соңғы мекенжайды жасырады. Бұл өздігінен алаяқтықтың дәлелі емес.'],
  external_redirect: ['Басқа доменге бағыттау', 'Өту кезінде домен өзгерді. Бұл қалыпты немесе серіктестік сілтеме болуы мүмкін; соңғы мекенжайды тексеріңіз.'],
  gambling_promotion: ['Құмар ойынды жарнамалау белгісі', 'Құмар ойын атауы мен ынталандыру ұсынысы қатар кездесті. Мұндай сөздер жаңалықта немесе ескертуде де кездесуі мүмкін.'],
};
export function localizeLinkResult(result, locale) {
  if (locale !== 'kk') return result;
  return { ...result,
    signals: result.signals.map(signal => ({ ...signal, label: kkSignals[signal.id]?.[0] || signal.label, description: kkSignals[signal.id]?.[1] || signal.description })),
    comparison: { ...result.comparison, note: !result.comparison.requested ? 'Салыстыру сұралмады.'
      : !result.comparison.available ? 'Мобильді нұсқаны қауіпсіз шектерде алу мүмкін болмады. Салыстыру қолжетімсіз.'
        : result.comparison.different ? 'Компьютер және телефонға арналған жауап не өту жолы әртүрлі. Себебі бейімделген бет, жарнама немесе өзгермелі деректер болуы мүмкін. Бұл клоакингтің дәлелі емес.'
          : 'Алынған жауаптар бірдей. Басқа келушілер үшін айырмашылық болуы мүмкін.' },
    limitations: [
      'Тек HTTP(S), 80/443 порттары және ашық IP-мекенжайлар. Әр бағыттау тексеріледі; байланыс тексерілген DNS-мекенжайға бекітіледі.',
      'Әр нұсқаға ең көбі 5 бағыттау, барлығына 8 секунд және әр жауапқа 256 КиБ. Ұзын жауап қысқартылады.',
      'JavaScript орындалмайды. Аккаунт, cookies, формалар, видео және суреттер қолданылмайды. Браузердің жеке деректері жіберілмейді.',
      'Белгілер мен жауап айырмашылығы алаяқтықтың, заңсыздықтың немесе клоакингтің дәлелі емес.',
      ...(result.hops.some(hop => hop.truncated) ? ['Жауап қысқартылды; қалған бөлігі талданбады.'] : []),
    ],
  };
}

function linkError(code, kk) {
  const messages = {
    INVALID_URL: ['Толық HTTP(S) сілтемесін көрсетіңіз. Логин/парольсіз, тек 80/443 порттары.', 'Укажите полную HTTP(S)-ссылку без логина/пароля, только порты 80/443.'],
    BLOCKED_ADDRESS: ['Ішкі, жергілікті немесе резервтік мекенжайға өту тоқтатылды.', 'Обращение к внутреннему, локальному или зарезервированному адресу остановлено.'],
    DNS_ERROR: ['Домен мекенжайын анықтау мүмкін болмады.', 'Не удалось определить адрес домена.'],
    TIMEOUT: ['Тексеруге бөлінген 8 секунд аяқталды.', 'Истекли 8 секунд, отведённые на проверку.'],
    REDIRECT_LIMIT: ['Бағыттау циклі немесе 5 бағыттау шегінен асу анықталды.', 'Обнаружен цикл или превышен предел 5 перенаправлений.'],
    REQUEST_ERROR: ['Сайт жауабын қауіпсіз түрде алу мүмкін болмады.', 'Не удалось безопасно получить ответ сайта.'],
  };
  return (messages[code] || messages.REQUEST_ERROR)[kk ? 0 : 1];
}

export function registerIntegrations(app, { linkInspector = inspectLink, metaSearch = searchMetaLibrary, metaStatus = getMetaLibraryStatus } = {}) {
  let busy = false, windowStart = Date.now(), count = 0;
  const bounded = handler => async (req, res) => {
    if (Date.now() - windowStart > 60000) { windowStart = Date.now(); count = 0; }
    if (busy || ++count > 12) {
      res.setHeader('Retry-After', '10');
      return res.status(429).json({ code: 'BUSY', error: req.body?.locale === 'kk' ? 'Бір тексеру орындалып жатыр немесе минуттық шекке жетті. Сәл күтіңіз.' : 'Проверка уже выполняется или достигнут минутный лимит. Подождите немного.' });
    }
    busy = true;
    try { await handler(req, res); } finally { busy = false; }
  };
  app.post('/api/inspect-link', bounded(async (req, res) => {
    try {
      const result = await linkInspector({ url: req.body?.url, compare: req.body?.compare !== false });
      const kkResult = localizeLinkResult(result, 'kk');
      res.json({ ...(req.body?.locale === 'kk' ? kkResult : result), checkedAt: new Date().toISOString(), translations: { ru: result, kk: kkResult } });
    } catch (error) {
      const status = ['INVALID_URL', 'BLOCKED_ADDRESS', 'REDIRECT_LIMIT'].includes(error.code) ? 400 : error.code === 'TIMEOUT' ? 504 : 502;
      res.status(status).json({ code: error.code || 'REQUEST_ERROR', error: linkError(error.code, req.body?.locale === 'kk') });
    }
  }));
  app.get('/api/connectors/meta/status', (_req, res) => res.json(metaStatus()));
  app.post('/api/connectors/meta/search', bounded(async (req, res) => {
    try { res.json(await metaSearch(req.body)); }
    catch (error) {
      res.status(Number.isInteger(error.status) ? error.status : 400).json({ code: error.code || 'META_ERROR', error: req.body?.locale === 'kk'
        ? 'Meta іздеуін орындау мүмкін болмады. Қосылу күйін, сұрауды және елге қолжетімді жарнама түрін тексеріңіз.'
        : 'Не удалось выполнить поиск Meta. Проверьте подключение, запрос и доступный для страны тип рекламы.' });
    }
  }));
}

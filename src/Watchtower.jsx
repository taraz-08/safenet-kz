import {fetchWithAccess, SESSION_DATA_EVENT} from './access-session.js';
import React, {useCallback, useEffect, useRef, useState} from 'react';
import {Activity, ArrowUpRight, Check, ChevronDown, Clock3, ExternalLink, FileCheck2, Globe2, Info, LoaderCircle, Pause, Play, Plus, Radio, RefreshCw, Search, Settings2, ShieldCheck, Trash2, X} from 'lucide-react';
import {getLanguage} from './i18n.js';
import './watchtower.css';

const PRESET_WORDS = ['казино','ставки','букмекер','фриспины','гарантированный доход','легкий заработок','кредит без отказа','кепілді табыс','оңай ақша','несие шығару','ақша көбейту','Kaspi'];
const SOURCE_STATUS = {
  never_checked: ['Ожидает проверки','Тексеру күтілуде'],
  ok: ['Проверен','Тексерілді'],
  empty_preview: ['Нет доступных постов','Қолжетімді жазба жоқ'],
  unavailable: ['Предпросмотр недоступен','Алдын ала қарау қолжетімсіз'],
  error: ['Не удалось проверить','Тексеру мүмкін болмады'],
  paused: ['Приостановлен','Кідіртілген'],
};
const ERROR_TEXT = {
  CHANNEL_UNAVAILABLE: ['Публичный предпросмотр канала недоступен.','Арнаның ашық алдын ала қарауы қолжетімсіз.'],
  FETCH_TIMEOUT: ['Telegram не ответил вовремя. Проверка будет повторена.','Telegram уақытында жауап бермеді. Тексеру қайталанады.'],
  TIMEOUT: ['Telegram не ответил вовремя. Проверка будет повторена.','Telegram уақытында жауап бермеді. Тексеру қайталанады.'],
  NETWORK_ERROR: ['Ошибка подключения к Telegram.','Telegram-ға қосылу қатесі.'],
  INVALID_HANDLE: ['Укажите публичный @username канала.','Арнаның ашық @username атауын көрсетіңіз.'],
  SOURCE_LIMIT: ['Можно подключить до 20 открытых каналов.','20 ашық арнаға дейін қосуға болады.'],
  MONITORING_DISABLED: ['Сначала возобновите мониторинг.','Алдымен бақылауды жалғастырыңыз.'],
  DISABLED: ['Сначала возобновите мониторинг.','Алдымен бақылауды жалғастырыңыз.'],
  BUSY: ['Проверка уже выполняется.','Тексеру орындалып жатыр.'],
  DUPLICATE_SOURCE: ['Этот канал уже добавлен в наблюдение.','Бұл арна бақылауға бұрын қосылған.'],
  INVALID_SOURCE: ['Укажите @username: 5–32 латинских символа, цифры или подчёркивание, начинается с буквы.','@username көрсетіңіз: 5–32 латын әрпі, сан немесе астыңғы сызық, әріптен басталады.'],
  SOURCE_NOT_FOUND: ['Источник не найден. Обновите список.','Дереккөз табылмады. Тізімді жаңартыңыз.'],
  PREVIEW_UNAVAILABLE: ['У канала нет доступного публичного предпросмотра.','Арнаның қолжетімді ашық алдын ала қарауы жоқ.'],
  RATE_LIMITED: ['Telegram ограничил запросы. Следующая проверка отложена.','Telegram сұрауларды шектеді. Келесі тексеру кейінге қалдырылды.'],
  BLOCKED_ADDRESS: ['Адрес Telegram не прошёл проверку безопасности.','Telegram мекенжайы қауіпсіздік тексеруінен өтпеді.'],
  RESPONSE_TOO_LARGE: ['Страница превысила лимит обработки.','Бет өңдеу шегінен асып кетті.'],
  INVALID_RESPONSE: ['Telegram вернул неподдерживаемый формат страницы.','Telegram қолдау көрсетілмейтін бет пішімін қайтарды.'],
  COLLECTION_ERROR: ['Не удалось обработать источник. Следующая проверка будет повторена.','Дереккөзді өңдеу мүмкін болмады. Тексеру қайталанады.'],
  INVALID_CONFIG: ['Проверьте правила: интервал 5–1440 минут, балл 0–100, до 20 фраз по 2–80 символов.','Ережелерді тексеріңіз: аралық 5–1440 минут, балл 0–100, ұзындығы 2–80 таңба болатын 20 тіркеске дейін.'],
};

async function request(path, options = {}) {
  const response = await fetchWithAccess(path, {...options, headers: {'Content-Type': 'application/json', ...options.headers}});
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(typeof body.error === 'string' ? body.error : body.error?.message || body.message || 'REQUEST_FAILED');
    error.code = body.code || body.error?.code;
    throw error;
  }
  return body;
}

export default function Watchtower({locale, onCasesChange, readOnly}) {
  const language = locale || getLanguage();
  const L = (ru, kk) => language === 'kk' ? kk : ru;
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState('');
  const [handle, setHandle] = useState('');
  const [removeId, setRemoveId] = useState(null);
  const [rules, setRules] = useState({intervalMinutes: 10, minScore: 30, keywords: ''});
  const [dirty, setDirty] = useState(false);
  const [notice, setNotice] = useState('');
  const initialized = useRef(false);
  const savedCount = useRef(null);
  const casesCallback = useRef(onCasesChange);
  const mounted = useRef(true);
  const requestVersion = useRef(0);
  useEffect(() => {casesCallback.current = onCasesChange;}, [onCasesChange]);
  useEffect(() => {mounted.current = true; return () => {mounted.current = false;};}, []);

  const applyData = useCallback(value => {
    if (!mounted.current) return;
    setData(value);
    if (!initialized.current) {
      setRules({intervalMinutes: value.intervalMinutes, minScore: value.minScore, keywords: (value.keywords || []).join(', ')});
      initialized.current = true;
    }
    if (savedCount.current !== null && savedCount.current !== value.stats?.savedCases) casesCallback.current?.();
    savedCount.current = value.stats?.savedCases;
  }, []);
  const reload = useCallback(async () => {
    const version = ++requestVersion.current;
    try {
      const value = await request('/api/watchtower');
      if (version !== requestVersion.current || !mounted.current) return;
      applyData(value);
      setError(null);
    } catch (e) {if (version === requestVersion.current && mounted.current) setError(e);}
  }, [applyData]);
  useEffect(() => {reload();window.addEventListener(SESSION_DATA_EVENT,reload);return()=>window.removeEventListener(SESSION_DATA_EVENT,reload);}, [reload]);
  useEffect(() => {
    if (busy || (!data?.enabled && !data?.running)) return;
    const interval = setInterval(reload, 10000);
    return () => clearInterval(interval);
  }, [data?.enabled, data?.running, busy, reload]);

  const formatDate = value => {
    if (!value || Number.isNaN(new Date(value).getTime())) return L('Пока нет данных','Әзірге дерек жоқ');
    return new Date(value).toLocaleString(language === 'kk' ? 'kk-KZ' : 'ru-RU', {day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit'});
  };
  const displayError = item => {
    if (!item) return '';
    if (ERROR_TEXT[item.code]) return L(...ERROR_TEXT[item.code]);
    const localized = item.translations?.[language] || (typeof item.message === 'object' ? item.message[language] : null);
    if (localized) return localized;
    if (language === 'ru' && item.message && item.message !== 'REQUEST_FAILED' && item.message !== 'Failed to fetch') return item.message;
    return L('Запрос не выполнен. Проверьте соединение и повторите.','Сұрау орындалмады. Байланысты тексеріп, қайталаңыз.');
  };
  async function action(key, path, method, body, success) {
    if (readOnly) return false;
    setBusy(key); setError(null); setNotice('');
    ++requestVersion.current;
    try {
      const value = await request(path, {method, ...(body === undefined ? {} : {body: JSON.stringify(body)})});
      if (!mounted.current) return false;
      if (Array.isArray(value.sources) && value.stats) applyData(value);
      else await reload();
      const runNotice = {cooldown:'runWaiting', no_sources:'runNoSources', cancelled:'runCancelled', completed:'run'}[value.runOutcome?.status];
      setNotice(success === 'run' ? runNotice || (value.stats?.runs === data?.stats?.runs ? 'runWaiting' : 'run') : success || '');
      return true;
    } catch (e) {if (mounted.current) setError(e); return false;}
    finally {if (mounted.current) setBusy('');}
  }
  async function addSource(event) {
    event.preventDefault();
    if (await action('add', '/api/watchtower/sources', 'POST', {platform:'telegram', handle:handle.trim()}, 'added')) setHandle('');
  }
  async function saveRules(event) {
    event.preventDefault();
    const keywords = rules.keywords.split(/[,\n]+/).map(word => word.trim()).filter(Boolean);
    if (keywords.length > 20 || keywords.some(word => word.length < 2 || word.length > 80)) {
      setError({translations:{ru:'Укажите до 20 слов или фраз длиной от 2 до 80 символов.',kk:'Ұзындығы 2–80 таңба болатын 20 сөз не тіркеске дейін көрсетіңіз.'}});
      return;
    }
    if (await action('rules', '/api/watchtower', 'PUT', {enabled:data.enabled, intervalMinutes:Number(rules.intervalMinutes), minScore:Number(rules.minScore), keywords}, 'saved')) setDirty(false);
  }
  async function restoreProfile() {
    if (readOnly) return;
    initialized.current = false;
    if (await action('profile', '/api/watchtower/profile', 'POST', {profile:'kazakhstan'}, 'restored')) setDirty(false);
    else initialized.current = true;
  }
  const sources = data?.sources || [];
  const activeSources = sources.filter(source => source.enabled).length;
  const checkedSources = sources.filter(source => source.lastSuccessAt).length;
  const pending = readOnly || !!busy || !!data?.running;
  const notices = {
    added:L('Источник добавлен. Он будет проверяться вместе с остальными каналами.','Дереккөз қосылды. Ол басқа арналармен бірге тексеріледі.'),
    saved:L('Правила сохранены.','Ережелер сақталды.'),
    restored:L('Профиль Казахстана восстановлен.','Қазақстан профилі қалпына келтірілді.'),
    run:L('Проверка завершена. Счётчики и кейсы обновлены.','Тексеру аяқталды. Есептегіштер мен кейстер жаңартылды.'),
    runWaiting:L(`Новых проверок не запущено: источники ожидают следующего доступного интервала. Следующая проверка: ${formatDate(data?.nextRunAt)}.`,`Жаңа тексеру басталмады: дереккөздер келесі рұқсат етілген аралықты күтуде. Келесі тексеру: ${formatDate(data?.nextRunAt)}.`),
    runNoSources:L('Проверка не запущена: нет включённых источников.','Тексеру басталмады: қосылған дереккөз жоқ.'),
    runCancelled:L('Проверка остановлена. Уже сохранённые результаты остаются в кейсах.','Тексеру тоқтатылды. Бұрын сақталған нәтижелер кейстерде қалады.'),
    removed:L('Источник удалён из наблюдения. Сохранённые кейсы остаются.','Дереккөз бақылаудан алынды. Сақталған кейстер қалады.'),
  };

  return <div className="watchtower">
    {error && <div className="wt-alert wt-error" role="alert"><Info size={18}/><span>{displayError(error)}</span><button type="button" onClick={() => setError(null)} aria-label={L('Закрыть сообщение','Хабарламаны жабу')}><X size={17}/></button></div>}
    {notice && <div className={`wt-alert ${['runWaiting','runNoSources','runCancelled'].includes(notice) ? 'wt-info' : 'wt-success'}`} role="status">{['runWaiting','runNoSources','runCancelled'].includes(notice) ? <Info size={18}/> : <Check size={18}/>}<span>{notices[notice] || notice}</span></div>}
    <section className="wt-hero">
      <div className="wt-hero-copy">
        <span className="wt-eyebrow"><span className={data?.enabled ? 'wt-live-dot' : 'wt-live-dot paused'}/>{L('SAFENET · ПРОФИЛЬ КАЗАХСТАНА','SAFENET · ҚАЗАҚСТАН ПРОФИЛІ')}</span>
        <h2>{L('Мониторинг Казахстана','Қазақстан бойынша бақылау')}</h2>
        <p>{L('Проверяем открытые источники, находим признаки рискованных схем и сохраняем объяснения в кейсах. На русском и казахском.','Ашық дереккөздерді тексеріп, қауіпті схемалардың белгілерін табамыз және түсіндірмелерді кейстерде сақтаймыз. Қазақша және орысша.')}</p>
        <div className="wt-hero-actions">
          <button type="button" className="button wt-light-button" disabled={readOnly || !data || !!busy} onClick={() => action('toggle','/api/watchtower','PUT',{enabled:!data.enabled})}>
            {busy === 'toggle' ? <LoaderCircle className="spin" size={17}/> : data?.enabled ? <Pause size={17}/> : <Play size={17}/>}
            {data?.enabled ? L('Приостановить','Кідірту') : L('Продолжить мониторинг','Бақылауды жалғастыру')}
          </button>
          <button type="button" className="wt-hero-secondary" disabled={!data?.enabled || !activeSources || pending} onClick={() => action('run','/api/watchtower/run','POST',{},'run')}>
            {busy === 'run' || data?.running ? <LoaderCircle className="spin" size={16}/> : <RefreshCw size={16}/>}{L('Проверить сейчас','Қазір тексеру')}
          </button>
        </div>
        <div className="wt-status-line" aria-live="polite"><Radio size={14}/>{!data ? L('Соединяемся с сервером…','Серверге қосылуда…') : data.running ? L('Проверка источников идёт сейчас','Дереккөздер қазір тексерілуде') : data.enabled ? L(`Проверка каждые ${data.intervalMinutes} мин · сервер должен работать`,`${data.intervalMinutes} минут сайын тексереді · сервер жұмыс істеуі керек`) : L('Автоматические проверки приостановлены','Автоматты тексерулер кідіртілген')}</div>
      </div>
      <div className="wt-radar" aria-hidden="true"><div className="wt-radar-ring ring-a"/><div className="wt-radar-ring ring-b"/><div className="wt-radar-ring ring-c"/><div className="wt-radar-cross horizontal"/><div className="wt-radar-cross vertical"/><span className="wt-radar-dot dot-a"/><span className="wt-radar-dot dot-b"/><span className="wt-radar-dot dot-c"/><div className="wt-radar-center"><ShieldCheck size={45} strokeWidth={1.4}/><span>KZ</span></div><span className="wt-radar-caption">ҚАЗАҚША / РУССКИЙ</span></div>
    </section>

    <div className="wt-metrics">
      {[[activeSources,L('Активных источников','Белсенді дереккөз'),Globe2,L(`${checkedSources} проверены успешно`,`${checkedSources} сәтті тексерілді`)],
        [data?.stats?.newPosts,L('Уникальных постов','Бірегей жазба'),Activity,L('Из подключённых каналов','Қосылған арналардан')],
        [data?.stats?.reportCases,L('Сообщений о схемах','Схема туралы хабар'),FileCheck2,L('Предупреждения и официальные сообщения','Ескертулер мен ресми хабарлар')],
        [data?.stats?.reviewCases,L('Для оценки риска','Қаупін бағалау қажет'),Search,L('Индикаторы требуют проверки','Белгілерді тексеру қажет')]].map(([value,label,Icon,note]) => <div className="panel wt-metric" key={label}><div><span>{label}</span><Icon size={19}/></div><strong>{data ? value ?? 0 : '—'}</strong><small>{note}</small></div>)}
    </div>

    <section className="panel wt-coverage" aria-label={L('Подключение платформ','Платформалардың қосылуы')}>
      <div className="wt-coverage-intro"><span className="section-kicker">{L('КАК ПОСТУПАЮТ ДАННЫЕ','ДЕРЕКТЕР ҚАЛАЙ КЕЛЕДІ')}</span><h3>{L('Три платформы. Прозрачные границы.','Үш платформа. Қамту аясы анық.')}</h3><p>{L('Счётчики отражают только обработанные источники, а не весь интернет Казахстана.','Есептегіштер бүкіл Қазақстан интернетін емес, тек өңделген дереккөздерді көрсетеді.')}</p></div>
      <div className="wt-platform-grid">
        <div className="wt-platform-card"><div className="wt-platform-top"><span className="wt-platform-letter telegram">T</span><strong>Telegram</strong><span className={`wt-pill ${activeSources && data?.enabled ? 'on' : ''}`}>{data?.enabled && activeSources ? L('По расписанию','Кесте бойынша') : L('Пауза','Кідіртілген')}</span></div><p>{L('Сервер читает последние публичные посты выбранных каналов. Открытая вкладка Telegram не нужна.','Сервер таңдалған арналардың соңғы ашық жазбаларын оқиды. Telegram қойындысын ашу қажет емес.')}</p></div>
        <div className="wt-platform-card"><div className="wt-platform-top"><span className="wt-platform-letter instagram">I</span><strong>Instagram</strong><span className="wt-pill">{L('Через расширение','Кеңейтім арқылы')}</span></div><p>{L('Проверка загруженных постов в вашем браузере. Этот сервер не обходит весь Instagram.','Браузеріңізге жүктелген жазбалар тексеріледі. Бұл сервер бүкіл Instagram-ды араламайды.')}</p><a href="#/sources" className="wt-text-link">{L('О расширении','Кеңейтім туралы')}<ArrowUpRight size={14}/></a></div>
        <div className="wt-platform-card"><div className="wt-platform-top"><span className="wt-platform-letter tiktok">T</span><strong>TikTok</strong><span className="wt-pill">{L('Через расширение','Кеңейтім арқылы')}</span></div><p>{L('Расширение анализирует доступные посты в активной вкладке TikTok. Доступ ко всей платформе не подключён.','Кеңейтім белсенді TikTok қойындысындағы қолжетімді жазбаларды талдайды. Бүкіл платформаға қолжетімділік қосылмаған.')}</p><a href="#/sources" className="wt-text-link">{L('О расширении','Кеңейтім туралы')}<ArrowUpRight size={14}/></a></div>
      </div>
    </section>

    <div className="wt-main-grid">
      <section className="panel wt-sources">
        <div className="panel-heading"><div><h2><Radio size={18}/>{L('Открытые каналы','Ашық арналар')}<span className="count-badge">{sources.length}</span></h2><p>{L('Проверяем доступный публичный предпросмотр. Приватные чаты и личные сообщения не читаются.','Қолжетімді ашық алдын ала қарауды тексереміз. Жабық чаттар мен жеке хаттар оқылмайды.')}</p></div><button type="button" className="icon-button" disabled={!!busy} onClick={reload} aria-label={L('Обновить состояние','Күйін жаңарту')}><RefreshCw size={17}/></button></div>
        {!data ? <div className="wt-empty"><LoaderCircle className="spin" size={27}/><p>{L('Загрузка источников…','Дереккөздер жүктелуде…')}</p></div> : !sources.length ? <div className="wt-empty"><Globe2 size={33}/><h3>{L('Источники ещё не подключены','Дереккөздер әлі қосылмаған')}</h3><p>{L('Подключите профиль Казахстана или добавьте открытый Telegram-канал ниже.','Қазақстан профилін қосыңыз немесе төменде ашық Telegram арнасын қосыңыз.')}</p><button type="button" className="button primary" disabled={readOnly || !!busy} onClick={restoreProfile}>{busy === 'profile' ? <LoaderCircle className="spin" size={16}/> : <Plus size={16}/>} {L('Подключить профиль Казахстана','Қазақстан профилін қосу')}</button></div> : <div className="wt-source-list">{sources.map(source => {
          const status = source.enabled ? source.status : 'paused';
          const statusText = SOURCE_STATUS[status] || SOURCE_STATUS.never_checked;
          const failed = status === 'error' || status === 'unavailable';
          return <article className="wt-source-row" key={source.id}>
            <div className="wt-source-heading"><span className="wt-channel-icon"><Radio size={17}/></span><div><a href={`https://t.me/s/${encodeURIComponent(source.handle.replace(/^@/,''))}`} target="_blank" rel="noopener noreferrer">{source.title || `@${source.handle.replace(/^@/,'')}`}<ExternalLink size={13}/></a><small>@{source.handle.replace(/^@/,'')}{source.kind === 'official_reports' ? L(' · Официальные сообщения',' · Ресми хабарлар') : ''}</small></div><span className={`wt-pill ${failed ? 'issue' : status === 'ok' ? 'on' : ''}`}>{L(...statusText)}</span></div>
            <div className="wt-source-meta"><span><Clock3 size={13}/>{formatDate(source.lastCheckedAt)}</span><span>{L('Постов','Жазба')}: <b>{source.newPosts ?? 0}</b></span><span>{L('Сообщений о схемах','Схема туралы хабар')}: <b>{source.reportCases ?? 0}</b></span><span>{L('Для оценки','Бағалау қажет')}: <b>{source.reviewCases ?? 0}</b></span></div>
            {source.lastError && <p className="wt-source-error"><Info size={13}/>{displayError(source.lastError)}</p>}
            <div className="wt-source-actions"><label className="wt-switch"><input type="checkbox" role="switch" checked={!!source.enabled} disabled={pending} onChange={() => action(`source-${source.id}`,`/api/watchtower/sources/${encodeURIComponent(source.id)}`,'PATCH',{enabled:!source.enabled})} aria-label={`${L('Наблюдать за','Бақылау')} @${source.handle}`}/><span>{source.enabled ? L('Наблюдать','Бақылау') : L('На паузе','Кідіртілген')}</span></label><button type="button" className="wt-text-link" disabled={!data.enabled || !source.enabled || pending} onClick={() => action(`run-${source.id}`,'/api/watchtower/run','POST',{sourceId:source.id},'run')}>{busy === `run-${source.id}` ? <LoaderCircle className="spin" size={14}/> : <RefreshCw size={14}/>} {L('Проверить','Тексеру')}</button><button type="button" className="wt-remove-button" disabled={pending} onClick={() => setRemoveId(source.id)} aria-label={`${L('Удалить источник','Дереккөзді алып тастау')} @${source.handle}`}><Trash2 size={15}/></button></div>
            {removeId === source.id && <div className="wt-remove-confirm"><span>{L('Убрать канал из наблюдения? Кейсы сохранятся.','Арнаны бақылаудан алу керек пе? Кейстер сақталады.')}</span><button type="button" disabled={pending} onClick={async () => {if (await action(`remove-${source.id}`,`/api/watchtower/sources/${encodeURIComponent(source.id)}`,'DELETE',undefined,'removed')) setRemoveId(null);}}>{L('Убрать','Алып тастау')}</button><button type="button" onClick={() => setRemoveId(null)}>{L('Отмена','Бас тарту')}</button></div>}
          </article>;
        })}</div>}
        <form className="wt-add-source" onSubmit={addSource}><label htmlFor="wt-channel">{L('Добавить свой открытый канал','Өзіңіздің ашық арнаңызды қосу')}</label><div><input disabled={readOnly} id="wt-channel" className="standalone-input" value={handle} onChange={event => setHandle(event.target.value)} placeholder="@channel_name" maxLength={33} pattern="@?[A-Za-z][A-Za-z0-9_]{4,31}" autoComplete="off" required aria-describedby="wt-channel-help"/><button type="submit" className="button primary" disabled={readOnly || !!busy || !handle.trim() || sources.length >= 20}>{busy === 'add' ? <LoaderCircle className="spin" size={16}/> : <Plus size={16}/>} {L('Добавить','Қосу')}</button></div><p id="wt-channel-help">{L('До 20 каналов. Укажите @username: 5–32 латинских символа, цифры или подчёркивание.','20 арнаға дейін. @username көрсетіңіз: 5–32 латын әрпі, сан немесе астыңғы сызық.')}</p></form>
      </section>

      <aside className="wt-sidebar">
        <section className="panel wt-schedule"><div className="wt-aside-icon"><Clock3 size={23}/></div><h3>{L('Следующая проверка','Келесі тексеру')}</h3><strong>{data?.running ? L('Выполняется сейчас','Қазір орындалуда') : data?.enabled ? formatDate(data.nextRunAt) : L('Приостановлена','Кідіртілген')}</strong><p>{L('Последняя: ','Соңғысы: ')}{formatDate(data?.lastRunAt)}</p><div className="wt-schedule-rule"><span>{L('Порог сохранения','Сақтау шегі')}</span><b>{data?.minScore ?? '—'} / 100</b></div><div className="wt-schedule-rule"><span>{L('Фраз для наблюдения','Бақылау тіркесі')}</span><b>{data?.keywords?.length ?? '—'}</b></div><div className="wt-schedule-rule"><span>{L('Всего новых кейсов','Барлық жаңа кейс')}</span><b>{data?.stats?.savedCases ?? '—'}</b></div><a className="button wt-cases-link" href="#/cases"><FileCheck2 size={16}/>{L('Открыть кейсы','Кейстерді ашу')}<ArrowUpRight size={15}/></a></section>
        <section className="panel wt-scope"><Info size={20}/><h3>{L('Что означает «Казахстан»','«Қазақстан» нені білдіреді')}</h3><p>{L('Профиль объединяет выбранные источники и русские и казахские фразы. Упоминание города, тенге или Kaspi — подсказка контекста, а не подтверждённое местоположение автора.','Профиль таңдалған дереккөздерді және қазақша, орысша тіркестерді біріктіреді. Қала, теңге немесе Kaspi атауы — контекст белгісі; автордың орналасқан жерін растамайды.')}</p><p>{L('«Сообщения о схемах» — сохранённые официальные публикации и предупреждения. Эти каналы не помечаются как мошеннические.','«Схема туралы хабарлар» — сақталған ресми жазбалар мен ескертулер. Бұл арналар алаяқтық арна ретінде белгіленбейді.')}</p><p>{L('Другие совпадения отправляются на оценку риска. Флаг сам по себе не доказывает мошенничество или нарушение закона.','Басқа сәйкестіктер қауіпті бағалауға жіберіледі. Белгінің өзі алаяқтықты не заң бұзуды дәлелдемейді.')}</p></section>
      </aside>
    </div>

    <details className="panel wt-settings"><summary><Settings2 size={19}/><span><strong>{L('Изменить правила мониторинга','Бақылау ережелерін өзгерту')}</strong><small>{L('Расписание, порог и поисковые фразы','Кесте, шек және іздеу тіркестері')}</small></span><ChevronDown size={19}/></summary><form onSubmit={saveRules}><div className="wt-settings-fields"><label><span>{L('Интервал проверки, минуты','Тексеру аралығы, минут')}</span><input disabled={readOnly} className="standalone-input" type="number" min="5" max="1440" step="1" required value={rules.intervalMinutes} onChange={event => {setRules(old => ({...old,intervalMinutes:event.target.value}));setDirty(true);}}/><small>{L('От 5 минут до 24 часов','5 минуттан 24 сағатқа дейін')}</small></label><label><span>{L('Минимальный балл риска','Қауіптің ең төменгі балы')}</span><input disabled={readOnly} className="standalone-input" type="number" min="0" max="100" step="1" required value={rules.minScore} onChange={event => {setRules(old => ({...old,minScore:event.target.value}));setDirty(true);}}/><small>{L('0–100. Это оценка признаков, не вероятность.','0–100. Бұл ықтималдық емес, белгілердің бағасы.')}</small></label></div><label className="wt-keywords-label" htmlFor="wt-keywords">{L('Слова и фразы через запятую','Үтірмен бөлінген сөздер мен тіркестер')}</label><textarea disabled={readOnly} id="wt-keywords" rows={3} value={rules.keywords} onChange={event => {setRules(old => ({...old,keywords:event.target.value}));setDirty(true);}}/><p className="wt-settings-hint">{L('До 20 фраз по 2–80 символов. Совпадение сохранит пост независимо от балла, в том числе новость или предупреждение об обмане.','Ұзындығы 2–80 таңба болатын 20 тіркеске дейін. Сәйкестік болса, жазба балға қарамастан сақталады, соның ішінде жаңалық немесе алаяқтық туралы ескерту де.')}</p><button type="button" disabled={readOnly} className="wt-text-link" onClick={() => {setRules(old => ({...old,keywords:PRESET_WORDS.join(', ')}));setDirty(true);}}>{L('Подставить фразы Казахстана','Қазақстанға арналған тіркестерді қою')}<ArrowUpRight size={14}/></button><div className="wt-settings-footer"><button className="button primary" disabled={readOnly || !data || !!busy}>{busy === 'rules' ? <LoaderCircle className="spin" size={16}/> : <Check size={16}/>} {L('Сохранить правила','Ережелерді сақтау')}</button><span>{dirty ? L('Есть несохранённые изменения','Сақталмаған өзгерістер бар') : ''}</span><button type="button" className="wt-text-link" disabled={readOnly || !!busy} onClick={restoreProfile}>{L('Восстановить профиль Казахстана','Қазақстан профилін қалпына келтіру')}</button></div></form></details>
    <p className="wt-footnote"><ShieldCheck size={15}/>{L('Обработка и случаи — на этом сервере. Telegram предоставляет ограниченное число последних постов; исчезнувшие и недоступные записи могут быть пропущены.','Өңдеу мен жағдайлар осы серверде сақталады. Telegram соңғы жазбалардың шектеулі санын береді; жойылған не қолжетімсіз жазбалар тексерілмеуі мүмкін.')}</p>
  </div>;
}

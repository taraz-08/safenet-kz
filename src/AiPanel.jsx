import React, {useEffect, useRef, useState} from 'react';
import {BrainCircuit, Check, ChevronRight, Eye, Info, LoaderCircle, LockKeyhole, RefreshCw, ScanText, Volume2} from 'lucide-react';
import {getLanguage} from './i18n.js';
import './ai-panel.css';

const REASONS = {
  model_missing: ['Модель ещё не установлена. Визуальный AI пока недоступен.', 'Модель әлі орнатылмаған. Бейнені талдайтын AI әзірге қолжетімсіз.'],
  runtime_unavailable: ['Локальный сервис модели не отвечает. Проверьте его запуск и повторите проверку.', 'Модельдің жергілікті сервисі жауап бермейді. Іске қосылғанын тексеріп, қайта тексеріңіз.'],
  vision_unavailable: ['У выбранной модели нет подтверждённой поддержки изображений.', 'Таңдалған модельдің кескінді талдау мүмкіндігі расталмаған.'],
  completion_unavailable: ['Выбранная модель не поддерживает нужный режим анализа.', 'Таңдалған модель қажетті талдау режимін қолдамайды.'],
  cloud_model_disallowed: ['Для этого режима нужна локальная модель. Облачная модель не используется.', 'Бұл режимге жергілікті модель қажет. Бұлттағы модель қолданылмайды.'],
  invalid_configuration: ['Настройки локальной модели не прошли проверку.', 'Жергілікті модель баптаулары тексеруден өтпеді.'],
  closed: ['Сервис анализа остановлен.', 'Талдау сервисі тоқтатылған.'],
};

export default function AiPanel({locale}) {
  const language = locale === 'kk' || (!locale && getLanguage() === 'kk') ? 'kk' : 'ru';
  const L = (ru, kk) => language === 'kk' ? kk : ru;
  const [data, setData] = useState(null);
  const [checking, setChecking] = useState(true);
  const [error, setError] = useState('');
  const [checkedAt, setCheckedAt] = useState(null);
  const requestRef = useRef(null);
  const refreshRef = useRef(null);

  useEffect(() => {
    let live = true;
    let inFlight = false;
    async function refresh(manual = false) {
      if (inFlight || !live) return;
      inFlight = true;
      const controller = new AbortController();
      requestRef.current = controller;
      const timeout = setTimeout(() => controller.abort(), 25000);
      setChecking(true);
      try {
        const response = await fetch(manual ? '/api/ai/check' : '/api/ai/status', {
          method: manual ? 'POST' : 'GET',
          ...(manual ? {headers: {'Content-Type': 'application/json'}, body: '{}'} : {}),
          signal: controller.signal,
          cache: 'no-store',
        });
        if (!response.ok) throw new Error('server_error');
        const result = await response.json();
        if (!result || typeof result.available !== 'boolean' || typeof result.reachable !== 'boolean') {
          throw new Error('invalid_response');
        }
        if (live) {
          setData(result);
          setError('');
          setCheckedAt(new Date());
        }
      } catch (failure) {
        if (live) setError(failure.name === 'AbortError' ? 'timeout' : 'server_error');
      } finally {
        clearTimeout(timeout);
        inFlight = false;
        if (live) setChecking(false);
      }
    }
    refreshRef.current = refresh;
    refresh();
    const interval = setInterval(() => {
      if (document.visibilityState !== 'hidden') refresh();
    }, 15000);
    return () => {
      live = false;
      refreshRef.current = null;
      clearInterval(interval);
      requestRef.current?.abort();
    };
  }, []);

  const fresh = !!data && !error;
  const visionReady = fresh && data.available === true && data.vision === true;
  const busy = fresh && data.busy === true;
  const audio = data?.media?.audio ?? data?.audio;
  const frame = data?.media?.frame;
  const speechReady = fresh && audio?.available === true;
  const status = error ? 'error' : !data ? 'checking' : busy ? 'busy' : visionReady ? 'ready' : 'waiting';
  const statusText = {
    ready: L('Модель доступна', 'Модель қолжетімді'),
    busy: L('Модель занята', 'Модель өңдеп жатыр'),
    waiting: L('Пока не готова', 'Әзірге дайын емес'),
    checking: L('Проверяем модель…', 'Модель тексерілуде…'),
    error: L('Нет связи с сервером', 'Сервермен байланыс жоқ'),
  }[status];
  const reason = REASONS[data?.reason] || REASONS[data?.status];
  const detail = error
    ? error === 'timeout'
      ? L('Сервер не ответил за 25 секунд. Готовность модели не подтверждена.', 'Сервер 25 секунд ішінде жауап бермеді. Модельдің дайындығы расталмады.')
      : L('Не удалось получить состояние AI. Повторите проверку, когда сервер будет доступен.', 'AI күйін алу мүмкін болмады. Сервер қолжетімді болғанда қайта тексеріңіз.')
    : !data
      ? L('Запрашиваем состояние локального сервиса и установленной модели.', 'Жергілікті сервис пен орнатылған модельдің күйі тексерілуде.')
      : busy
        ? L('Уже выполняется анализ. Время обработки зависит от модели и мощности компьютера.', 'Талдау орындалып жатыр. Өңдеу уақыты модель мен компьютердің қуатына байланысты.')
        : visionReady
          ? L('Сервис отвечает, модель установлена и поддерживает изображения. Это готовность к анализу, а не подтверждение захвата вкладки.', 'Сервис қолжетімді, модель орнатылған және кескіндерді қолдайды. Бұл талдауға дайын екенін білдіреді, қойындыны түсіру қосылғанын растамайды.')
          : reason
            ? reason[language === 'kk' ? 1 : 0]
            : L('Готовность визуальной модели пока не подтверждена.', 'Бейнені талдайтын модельдің дайындығы әзірге расталмаған.');

  return <section className="panel ai-panel" aria-labelledby="ai-panel-title">
    <div className="ai-panel-heading">
      <div className="ai-panel-title-icon"><BrainCircuit size={25} aria-hidden="true"/></div>
      <div className="ai-panel-heading-copy">
        <span className="section-kicker">{L('ВИДЕО · РЕЧЬ · КОНТЕКСТ', 'ВИДЕО · СӨЙЛЕУ · МӘНМӘТІН')}</span>
        <h2 id="ai-panel-title">{L('Предобученная AI-модель', 'Алдын ала үйретілген AI')}</h2>
        <p>{L('Модель анализирует отобранные кадры и распознанную речь на вашем компьютере.', 'Модель іріктелген кадрлар мен танылған сөйлеуді компьютеріңізде талдайды.')}</p>
      </div>
      <span className="ai-local-tag"><LockKeyhole size={13} aria-hidden="true"/>{L('Локально', 'Жергілікті')}</span>
    </div>

    <div className="ai-model-status">
      <div className="ai-model-description">
        <div className="ai-model-name"><strong>{data?.model || L('Локальная модель', 'Жергілікті модель')}</strong><span>{data?.provider === 'ollama' ? 'Ollama' : L('Локальный сервис', 'Жергілікті сервис')}</span></div>
        <div className={`ai-status-pill ai-status-${status}`} role="status" aria-live="polite">
          {status === 'checking' || status === 'busy' ? <LoaderCircle size={13} className="spin" aria-hidden="true"/> : <span className="ai-status-dot"/>}
          {statusText}
        </div>
        <p className={error ? 'ai-status-explanation ai-status-error-text' : 'ai-status-explanation'} role={error ? 'alert' : undefined}>{detail}</p>
      </div>
      <div className="ai-check-control">
        <button type="button" className="button secondary" disabled={checking} onClick={() => refreshRef.current?.(true)}>
          <RefreshCw size={15} className={checking ? 'spin' : undefined} aria-hidden="true"/>
          {checking ? L('Проверка…', 'Тексерілуде…') : L('Проверить модель', 'Модельді тексеру')}
        </button>
        <small>{checkedAt ? L('Ответ сервера: ', 'Сервер жауабы: ') + checkedAt.toLocaleTimeString(language === 'kk' ? 'kk-KZ' : 'ru-RU', {hour: '2-digit', minute: '2-digit', second: '2-digit'}) : L('Ожидаем ответ сервера', 'Сервер жауабы күтілуде')}</small>
      </div>
    </div>

    <div className="ai-senses">
      <div className="ai-sense">
        <Eye size={20} aria-hidden="true"/>
        <span className="ai-sense-index">01</span>
        <h3>{L('Видеть кадр', 'Кадрды көру')}</h3>
        <span className={`ai-sense-state ${visionReady ? 'ai-sense-ready' : ''}`}>
          {visionReady ? <Check size={12} aria-hidden="true"/> : null}
          {visionReady ? L('Визуальная модель доступна', 'Кескін моделі қолжетімді') : L('Визуальная модель не готова', 'Кескін моделі дайын емес')}
        </span>
        <p>{L('Ищет признаки рекламы и азартных игр в отдельных кадрах. Между кадрами часть видео может быть пропущена.', 'Жеке кадрлардан жарнама мен құмар ойын белгілерін іздейді. Кадрлардың арасындағы бейне бөлігі өткізіліп кетуі мүмкін.')}</p>
      </div>
      <ChevronRight size={17} className="ai-sense-arrow" aria-hidden="true"/>
      <div className="ai-sense">
        <Volume2 size={20} aria-hidden="true"/>
        <span className="ai-sense-index">02</span>
        <h3>{L('Распознать речь', 'Сөйлеуді тану')}</h3>
        <span className={`ai-sense-state ${speechReady ? 'ai-sense-ready' : ''}`}>
          {speechReady ? <Check size={12} aria-hidden="true"/> : null}
          {speechReady ? L('Whisper доступен', 'Whisper қолжетімді') : fresh && audio?.available === false ? L('Whisper не готов', 'Whisper дайын емес') : L('Готовность Whisper не подтверждена', 'Whisper дайындығы расталмаған')}
        </span>
        <p>{L('Переводит звук вкладки в текст для анализа. Қазақша / Русский. Захват звука включается в расширении.', 'Талдау үшін қойынды дыбысын мәтінге айналдырады. Қазақша / Русский. Дыбысты түсіру кеңейтімде қосылады.')}</p>
      </div>
      <ChevronRight size={17} className="ai-sense-arrow" aria-hidden="true"/>
      <div className="ai-sense">
        <BrainCircuit size={20} aria-hidden="true"/>
        <span className="ai-sense-index">03</span>
        <h3>{L('Объяснить подозрение', 'Күдікті түсіндіру')}</h3>
        <span className="ai-sense-state">{L('Наблюдение + контекст', 'Бақылау + мәнмәтін')}</span>
        <p>{L('Объясняет признаки риска и контекст: например, реклама, обсуждение или предупреждение о мошенничестве.', 'Қауіп белгілерін және мәнмәтінді түсіндіреді: мысалы, жарнама, талқылау немесе алаяқтық туралы ескерту.')}</p>
      </div>
    </div>

    <div className="ai-fallback-note"><ScanText size={17} aria-hidden="true"/><p>
      {L('OCR / QR — отдельный слой проверки. ', 'OCR / QR — тексерудің бөлек қабаты. ')}
      {fresh && frame?.available === true ? L('Распознавание текста доступно. ', 'Мәтінді тану қолжетімді. ') : ''}
      {L('Он читает надписи и коды; сам по себе не понимает сцену. Если AI недоступен, результат OCR не выдаётся за заключение модели.', 'Ол жазулар мен кодтарды оқиды, көріністің мәнін өздігінен түсінбейді. AI қолжетімсіз болса, OCR нәтижесі модельдің қорытындысы ретінде көрсетілмейді.')}
    </p></div>

    <div className="ai-start-flow">
      <h3>{L('Как запустить в Instagram', 'Instagram-да қалай қосылады')}</h3>
      <ol>
        <li><span>1</span>{L('Откройте главную ленту Instagram или Reels в Chrome с расширением SafeNet.', 'SafeNet кеңейтімі бар Chrome-да Instagram-ның басты лентасын немесе Reels бөлімін ашыңыз.')}</li>
        <li><span>2</span>{L('В расширении нажмите «Включить ИИ и автопрокрутку» — Chrome требует этот клик для захвата вкладки.', 'Кеңейтімде «ИИ мен автоайналдыруды қосу» батырмасын басыңыз — қойындыны түсіру үшін Chrome осы басуды талап етеді.')}</li>
        <li><span>3</span>{L('Оставьте вкладку активной. Проверяются доступные посты этой ленты; автопрокрутка останавливается при подозрительной находке.', 'Қойындыны белсенді қалдырыңыз. Осы лентаның қолжетімді жазбалары тексеріледі; күдікті белгі табылғанда айналдыру тоқтайды.')}</li>
      </ol>
    </div>
    <div className="ai-panel-limit"><Info size={15} aria-hidden="true"/><p>{L('AI может ошибаться. Проверяйте исходный кадр, текст и объяснение; модель не подтверждает факт мошенничества. Анализируется доступная активная лента, а не весь Instagram.', 'AI қателесуі мүмкін. Бастапқы кадрды, мәтінді және түсіндірмені тексеріңіз: модель алаяқтық фактісін растамайды. Бүкіл Instagram емес, қолжетімді белсенді лента талданады.')}</p></div>
  </section>;
}

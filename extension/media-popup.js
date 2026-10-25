(() => {
  'use strict';
  const copy = {
    kk: {
      heading:'ИИ · видео + дыбыс', description:'Қосқанда осы Instagram бетінің кадрлары мен дыбысы жергілікті талданады. ИИ моделі дайын болса, кадрдағы көріністі де тексереді; әйтпесе мәтін/QR/сөйлеуді тану қалады. Автоайналдыру 3 кадр мен 12 секундқа дейінгі дауыс үзіндісінің нәтижесін күтеді, ең көбі 4 минут. Бүкіл видео қамтылмайды. Микрофон қолданылмайды. Тек белсенді бет, ең көбі 15 минут. Жазба сақталмайды; мониторинг қосулы болса, танылған мәтін мен ИИ пайымы сақталуы мүмкін.',
      start:'▶ ИИ мен автоайналдыруды қосу', stop:'ИИ мен айналдыруды тоқтату', off:'Өшірулі', starting:'Бетке қосылуда…', active:'Видео мен дыбыс талдануда', remaining:'мин қалды',
      inactive:'Басқа бетке ауыстыңыз — талдау кідіртілді.', hidden:'Бет жасырын — талдау кідіртілді.', paused:'Автотексеру тоқтатылды.', 'no-video':'Көрінетін видео күтілуде.', offline:'SafeNet жергілікті серверін іске қосыңыз.',
      unsupported:'Instagram-дағы ашық видео бетінде қосыңыз.', private:'Жеке бөлімге ауысқанда жазу тоқтатылды.', ended:'Жазу тоқтатылды.', timeout:'15 минут аяқталды. Қажет болса қайта қосыңыз.', 'capture-ended':'Браузер жазуды аяқтады.',
      unavailable:'Браузер видеоға қол жеткізе алмады. Chrome 116+ қажет.', 'capture-failed':'Видео мен дыбысты алу мүмкін болмады. Бетті жаңартып, қайта қосыңыз.', 'processing-error':'Медиа талдауы уақытша қолжетімсіз.', busy:'Талдағыш бос емес. Келесі үлгі күтілуде.',
    },
    ru: {
      heading:'ИИ · видео + звук', description:'Кадры и звук этой вкладки Instagram анализируются локально. Готовая ИИ-модель проверяет и содержание кадра; без неё остаётся распознавание текста/QR/речи. Автопрокрутка ждёт 3 кадра и речевой фрагмент до 12 секунд, максимум 4 минуты. Это выборка, не всё видео. Микрофон не используется. Только активная вкладка, не более 15 минут. Записи не сохраняются; распознанный текст и предположения ИИ могут сохраняться в мониторинге.',
      start:'▶ Включить ИИ и автопрокрутку', stop:'Остановить ИИ и прокрутку', off:'Выключено', starting:'Подключаем вкладку…', active:'Анализируем видео и звук', remaining:'мин осталось',
      inactive:'Вы перешли на другую вкладку — анализ приостановлен.', hidden:'Вкладка скрыта — анализ приостановлен.', paused:'Автопроверка выключена.', 'no-video':'Ожидаем видимое видео.', offline:'Запустите локальный сервер SafeNet.',
      unsupported:'Включите на странице открытого видео Instagram.', private:'Запись остановлена при переходе в личный раздел.', ended:'Запись остановлена.', timeout:'15 минут истекли. При необходимости включите снова.', 'capture-ended':'Браузер завершил запись.',
      unavailable:'Браузер не предоставил доступ к видео. Нужен Chrome 116+.', 'capture-failed':'Не удалось захватить видео и звук. Обновите страницу и включите снова.', 'processing-error':'Анализ медиа временно недоступен.', busy:'Анализатор занят. Ожидаем следующий фрагмент.',
    },
  };
  const start = document.getElementById('media-start');
  const stop = document.getElementById('media-stop');
  const status = document.getElementById('media-status');
  document.getElementById('extension-version').textContent=`v${chrome.runtime.getManifest().version}`;
  let locale = document.getElementById('locale').value === 'kk' ? 'kk' : 'ru';
  let state = { active:false };
  let pending = false;
  let error = '';
  function render() {
    const t = copy[locale];
    document.getElementById('media-heading').textContent = t.heading;
    document.getElementById('media-description').textContent = (locale==='kk'?'Бір батырма: осы Instagram лентасында/Reels-та талдау мен автоайналдыру қосылады; жеке постта тек талдау. Осылай қосылған айналдыру «Тоқтату» басылғанда немесе 15 минуттан кейін аяқталады. ':'Одна кнопка включает анализ и прокрутку в этой ленте Instagram/Reels; на отдельном посте — только анализ. Эта прокрутка прекращается по кнопке «Остановить» или через 15 минут. ')+t.description;
    start.textContent = t.start; stop.textContent = t.stop;
    start.disabled = pending || state.active;
    stop.disabled = !state.active;
    const reason = error || state.reason;
    status.dataset.error = String(Boolean(error));
    status.textContent = pending ? t.starting : state.active
      ? state.paused ? (t[reason] || t['no-video']) : `${t.active} · ${Math.max(1,Math.ceil((state.expiresAt-Date.now())/60000))} ${t.remaining}`
      : reason ? t[reason] || t.ended : t.off;
    if(state.active && !state.paused && state.pending?.length)status.textContent+=locale==='kk'?' · Нәтижені күтуде':' · Ожидаем результат';
    if(state.active && state.ai){const labels=locale==='kk'?{completed:'талданды',ready:'дайын',busy:'өңдеуде',model_missing:'модель орнатылмаған',no_transcript:'сөйлеу танылмады'}:{completed:'проверено',ready:'готов',busy:'обработка',model_missing:'модель не установлена',no_transcript:'речь не распознана'};status.textContent+=` · ${state.ai.model||'ИИ'}: ${labels[state.ai.status]||(locale==='kk'?'ИИ қолжетімсіз':'ИИ недоступен')}`;}
  }
  async function refresh() {
    try { const response = await chrome.runtime.sendMessage({type:'SAFENET_MEDIA_STATUS'}); if(response?.ok) {state=response.state;render();} } catch {}
  }
  start.addEventListener('click', async () => {
    pending=true;error='';render();
    try {
      const [tab] = await chrome.tabs.query({active:true,currentWindow:true});
      const response = await chrome.runtime.sendMessage({type:'SAFENET_MEDIA_START',tabId:tab?.id,autoBrowse:true});
      if(!response?.ok)throw new Error(response?.error || 'capture-failed');
      state=response.state;
      window.close();
    } catch(e) {error=copy[locale][e.message]?e.message:'capture-failed';}
    finally {pending=false;render();}
  });
  stop.addEventListener('click', async () => {
    try {const response=await chrome.runtime.sendMessage({type:'SAFENET_MEDIA_STOP'});if(response?.ok){state=response.state;error='';render();}}catch{}
  });
  document.getElementById('locale').addEventListener('change', event => {locale=event.target.value==='kk'?'kk':'ru';render();});
  chrome.storage.local.get('locale').then(saved=>{locale=saved.locale==='kk'?'kk':'ru';render();});
  chrome.storage.onChanged.addListener((changes,area)=>{if(area==='local'&&changes.locale){locale=changes.locale.newValue==='kk'?'kk':'ru';render();}});
  chrome.runtime.onMessage.addListener(message=>{if(message?.type==='SAFENET_MEDIA_POPUP_STATE'){state=message.state;render();}});
  render();refresh();setInterval(refresh,2000);
})();

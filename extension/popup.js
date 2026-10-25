"use strict";

const MAX_TEXT = 12000;
const DASHBOARD_URL = "http://127.0.0.1:4310/";
const textInput = document.getElementById("text");
const captureButton = document.getElementById("capture");
const analyzeButton = document.getElementById("analyze");
const statusElement = document.getElementById("status");
let source = { url: "", platform: "other" };

function platformFor(hostname) {
  const host = hostname.toLowerCase();
  if (host === "instagram.com" || host.endsWith(".instagram.com")) return "instagram";
  if (host === "tiktok.com" || host.endsWith(".tiktok.com")) return "tiktok";
  if (host === "web.telegram.org") return "telegram";
  if (host === "web.whatsapp.com") return "whatsapp";
  return "other";
}

function setStatus(message, isError = false) {
  const ru = {
    'Мәтін алынуда…':'Получаем текст…',
    'Алдымен беттегі мәтінді белгілеңіз. Немесе мәтінді осында қолмен енгізіңіз.':'Сначала выделите текст на странице. Или вставьте его вручную.',
    'Көрінетін мәтін табылмады. Мәтінді қолмен енгізіңіз.':'Видимый текст не найден. Вставьте его вручную.',
    'Ұзын мәтін 12 000 таңбаға қысқартылды. Үзіндіні тексеріп, қажетсіз деректерді өшіріңіз.':'Текст сокращён до 12 000 символов. Проверьте фрагмент и удалите лишние данные.',
    'Мәтін дайын. Қажетсіз деректерді өшіріп, тексеруді бастаңыз.':'Текст готов. Удалите ненужные данные и начните проверку.',
    'Бұл бетке браузер рұқсат бермеді. Қалыпты веб-бетті ашыңыз немесе мәтінді қолмен енгізіңіз.':'Браузер не разрешил доступ. Откройте обычную страницу или вставьте текст вручную.',
    'Мәтін SafeNet-те ашылды. Талдауды сайтта бастаңыз.':'Текст открыт в SafeNet. Запустите анализ на сайте.',
    'SafeNet ашылмады. Жергілікті сайттың іске қосылғанын тексеріңіз.':'Не удалось открыть SafeNet. Проверьте, запущен ли локальный сайт.',
    'Мәтін тазаланды.':'Текст очищен.',
  };
  statusElement.textContent = autoLocale === 'ru' ? ru[message] || message : message;
  statusElement.dataset.error = String(isError);
}

function updatePreview() {
  document.getElementById("count").textContent = `${textInput.value.length} / ${MAX_TEXT}`;
  analyzeButton.disabled = !textInput.value.trim();
}

// Executed only after the user presses Capture, in the active tab's isolated world.
// No network requests, cookies, form values, hidden DOM, or background listeners.
function captureVisibleText(mode, maxLength) {
  const forbidden = "script,style,noscript,template,input,textarea,select,[contenteditable]:not([contenteditable='false']),[aria-hidden='true'],[hidden]";
  function allowed(element) {
    if (!element || element.closest(forbidden)) return false;
    for (let current = element; current; current = current.parentElement) {
      const style = getComputedStyle(current);
      if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse" || Number(style.opacity) === 0) return false;
    }
    return true;
  }
  if (mode === "selection") {
    const selection = window.getSelection();
    if (!selection || !selection.rangeCount || selection.isCollapsed) return { text: "", truncated: false };
    const parts = [];
    let length = 0;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode()) && length <= maxLength) {
      if (!allowed(node.parentElement) || !selection.containsNode(node, true)) continue;
      for (let i = 0; i < selection.rangeCount; i++) {
        const range = selection.getRangeAt(i);
        if (!range.intersectsNode(node)) continue;
        const start = range.startContainer === node ? range.startOffset : 0;
        const end = range.endContainer === node ? range.endOffset : node.textContent.length;
        const value = node.textContent.slice(start, end).trim();
        if (value) { parts.push(value); length += value.length + 1; }
      }
    }
    const text = parts.join("\n");
    return { text: text.slice(0, maxLength), truncated: text.length > maxLength };
  }
  const parts = [];
  let length = 0;
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let node;
  while ((node = walker.nextNode()) && length <= maxLength) {
    const value = node.textContent.trim();
    if (!value || !allowed(node.parentElement)) continue;
    const range = document.createRange();
    range.selectNodeContents(node);
    const visible = Array.from(range.getClientRects()).some(rect => rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.right > 0 && rect.top < innerHeight && rect.left < innerWidth);
    if (!visible) continue;
    parts.push(value);
    length += value.length + 1;
  }
  const text = parts.join("\n");
  return { text: text.slice(0, maxLength), truncated: text.length > maxLength };
}

captureButton.addEventListener("click", async () => {
  captureButton.disabled = true;
  setStatus("Мәтін алынуда…");
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !Number.isInteger(tab.id) || !tab.url) throw new Error("restricted");
    const page = new URL(tab.url);
    if (!["http:", "https:"].includes(page.protocol)) throw new Error("restricted");
    const mode = document.querySelector('input[name="mode"]:checked').value;
    const results = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: captureVisibleText, args: [mode, MAX_TEXT] });
    const result = results[0]?.result;
    if (!result?.text) {
      setStatus(mode === "selection" ? "Алдымен беттегі мәтінді белгілеңіз. Немесе мәтінді осында қолмен енгізіңіз." : "Көрінетін мәтін табылмады. Мәтінді қолмен енгізіңіз.", true);
      return;
    }
    source = { url: `${page.origin}${page.pathname}`, platform: platformFor(page.hostname) };
    textInput.value = result.text;
    document.getElementById("platform").textContent = `${source.platform.toUpperCase()} · ${page.hostname}`;
    updatePreview();
    setStatus(result.truncated ? "Ұзын мәтін 12 000 таңбаға қысқартылды. Үзіндіні тексеріп, қажетсіз деректерді өшіріңіз." : "Мәтін дайын. Қажетсіз деректерді өшіріп, тексеруді бастаңыз.");
  } catch {
    setStatus("Бұл бетке браузер рұқсат бермеді. Қалыпты веб-бетті ашыңыз немесе мәтінді қолмен енгізіңіз.", true);
  } finally {
    captureButton.disabled = false;
  }
});

analyzeButton.addEventListener("click", async () => {
  const text = textInput.value.trim();
  if (!text) return;
  const params = new URLSearchParams({ text: text.slice(0, MAX_TEXT), url: source.url, platform: source.platform });
  try {
    await chrome.tabs.create({ url: `${DASHBOARD_URL}#/analyze?${params.toString()}` });
    setStatus("Мәтін SafeNet-те ашылды. Талдауды сайтта бастаңыз.");
  } catch {
    setStatus("SafeNet ашылмады. Жергілікті сайттың іске қосылғанын тексеріңіз.", true);
  }
});

document.getElementById("clear").addEventListener("click", () => {
  textInput.value = "";
  source = { url: "", platform: "other" };
  document.getElementById("platform").textContent = autoLocale === 'ru' ? 'Ручной ввод' : 'Қолмен енгізу';
  updatePreview();
  setStatus("Мәтін тазаланды.");
  textInput.focus();
});
textInput.addEventListener("input", updatePreview);
for (const radio of document.querySelectorAll('input[name="mode"]')) {
  radio.addEventListener("change", () => {
    chrome.storage.local.set({ captureMode: radio.value }).catch(() => {});
  });
}
chrome.storage.local.get("captureMode").then(({ captureMode }) => {
  if (["selection", "visible"].includes(captureMode)) document.querySelector(`input[value="${captureMode}"]`).checked = true;
}).catch(() => {});
updatePreview();

const AUTO_COPY = {
  ru: {eyebrow:'АВТОМАТИЧЕСКАЯ ЗАЩИТА',heading:'Листайте ленту. Замечайте риск.',intro:'SafeNet отмечает признаки риска прямо под видимыми публикациями Instagram и TikTok.',enabled:'Автопроверка',language:'Язык объяснений',open:'Открыть SafeNet ↗',privacy:'Загруженные подписи → локальный анализатор. Если включён мониторинг в SafeNet, подходящие публикации сохраняются локально. Личные сообщения исключены. Нужен запущенный SafeNet.',manual:'Проверить текст вручную',footer:'Локально · без облачных ключей',ready:'Анализатор готов. Обновите открытые вкладки Instagram / TikTok после установки.',offline:'Анализатор недоступен. Запустите SafeNet на 127.0.0.1:4310.',paused:'Автопроверка выключена. Включите переключатель, чтобы отмечать публикации.'},
  kk: {eyebrow:'АВТОМАТТЫ ҚОРҒАНЫС',heading:'Лентаны қараңыз. Қауіпті байқаңыз.',intro:'SafeNet Instagram және TikTok жазбаларының астында қауіп белгілерін көрсетеді.',enabled:'Автотексеру',language:'Түсіндірме тілі',open:'SafeNet-ті ашу ↗',privacy:'Жүктелген жазба мәтіні → жергілікті талдау. SafeNet мониторингі қосулы болса, сәйкес жазбалар жергілікті сақталады. Жеке хаттар оқылмайды. SafeNet іске қосулы болуы керек.',manual:'Мәтінді қолмен тексеру',footer:'Жергілікті · бұлттық кілттерсіз',ready:'Талдағыш дайын. Орнатудан кейін Instagram / TikTok бетін жаңартыңыз.',offline:'Талдағыш қолжетімсіз. SafeNet-ті 127.0.0.1:4310 мекенжайында іске қосыңыз.',paused:'Автотексеру өшірілген. Жазбаларды белгілеу үшін қосыңыз.'},
};
let autoLocale='ru';
let localReady=false;
function updateAutoUI() {
  const copy=AUTO_COPY[autoLocale];
  document.getElementById('open-monitor').textContent=autoLocale==='ru'?'Мониторинг и сохранение кейсов ↗':'Мониторинг және кейстерді сақтау ↗';
  for(const [id,key] of Object.entries({'auto-eyebrow':'eyebrow','auto-heading':'heading','auto-intro':'intro','auto-label':'enabled','language-label':'language','open-dashboard':'open','auto-privacy':'privacy','manual-label':'manual','footer-label':'footer'}))document.getElementById(id).textContent=copy[key];
  const connection=document.getElementById('connection');
  connection.textContent=!document.getElementById('auto-enabled').checked?copy.paused:localReady?copy.ready:copy.offline;
  connection.dataset.error=String(!localReady);
  const manual = autoLocale==='ru' ? {
    'brand-tagline':'Доверие начинается с проверки.', 'capture-legend':'Какой текст захватить?', 'selection-label':'Выделенный текст', 'selection-hint':'Рекомендуется · только выбранный фрагмент', 'visible-label':'Текст на экране', 'visible-hint':'Только текущая видимая часть страницы', capture:'Получить текст страницы ↓', 'text-label':'Текст для проверки', clear:'Очистить', analyze:'Проверить в SafeNet ↗', 'manual-notice':'Ручной захват выполняется по кнопке. Удалите личные данные перед отправкой. Видео, изображения и скрытые сообщения не читаются.'
  } : {
    'brand-tagline':'Сенім тексеруден басталады.', 'capture-legend':'Қандай мәтін алынады?', 'selection-label':'Белгіленген мәтін', 'selection-hint':'Ұсынылады · тек таңдалған үзінді', 'visible-label':'Экрандағы мәтін', 'visible-hint':'Тек қазір көрініп тұрған бет бөлігі', capture:'Беттен мәтінді алу ↓', 'text-label':'Тексерілетін мәтін', clear:'Тазалау', analyze:'SafeNet-те тексеру ↗', 'manual-notice':'Қолмен алу батырма басылғанда орындалады. Жібермес бұрын жеке деректерді өшіріңіз. Видео, сурет және жасырын хаттар оқылмайды.'
  };
  for(const [id,value] of Object.entries(manual))document.getElementById(id).textContent=value;
  textInput.placeholder=autoLocale==='ru'?'Получите текст со страницы или вставьте вручную…':'Мәтінді беттен алыңыз немесе қолмен енгізіңіз…';
  if(!source.url)document.getElementById('platform').textContent=autoLocale==='ru'?'Ручной ввод':'Қолмен енгізу';
  statusElement.textContent=autoLocale==='ru'?'Нужен запущенный сайт: 127.0.0.1:4310':'Сайт іске қосулы болуы керек: 127.0.0.1:4310';
}
document.getElementById('auto-enabled').addEventListener('change',async event=>{await chrome.storage.local.set({autoEnabled:event.target.checked});updateAutoUI();});
document.getElementById('locale').addEventListener('change',async event=>{autoLocale=event.target.value==='kk'?'kk':'ru';await chrome.storage.local.set({locale:autoLocale});updateAutoUI();});
document.getElementById('open-dashboard').addEventListener('click',()=>chrome.tabs.create({url:DASHBOARD_URL}));
document.getElementById('open-monitor').addEventListener('click',()=>chrome.tabs.create({url:`${DASHBOARD_URL}#/monitor`}));
chrome.storage.local.get(['autoEnabled','locale']).then(saved=>{document.getElementById('auto-enabled').checked=saved.autoEnabled!==false;autoLocale=saved.locale==='kk'?'kk':'ru';document.getElementById('locale').value=autoLocale;updateAutoUI();}).catch(()=>{});
chrome.runtime.sendMessage({type:'SAFENET_HEALTH'}).then(result=>{localReady=Boolean(result?.ok);updateAutoUI();}).catch(()=>{localReady=false;updateAutoUI();});

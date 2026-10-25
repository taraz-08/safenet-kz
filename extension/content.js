(() => {
  'use strict';
  const COPY = {
    ru: { active:'Автопроверка включена', paused:'Автопроверка на паузе', offline:'Запустите SafeNet: 127.0.0.1:4310', waiting:'Ожидаем видимые публикации', scanned:'Проверено', flagged:'Сигналы', risk:'Признаки риска', high:'Высокий риск', medium:'Требует проверки', why:'Почему отмечено?', close:'Закрыть', retry:'Повторить', pause:'Пауза', resume:'Включить', local:'Локальный анализ · текст публикаций', disclaimer:'Это признаки риска, а не обвинение. Проверьте контекст и источник.', short:'Анализ первых 10 000 символов.', noCaption:'Подпись публикации не найдена. Можно проверить текст вручную.', manual:'Открыть SafeNet', privacy:'Личные сообщения не анализируются', inspect:'Причины и цитаты', loading:'Проверяем публикации…', unsupported:'Нет доступных подписей. Попробуйте открыть отдельную публикацию.' },
    kk: { active:'Автотексеру қосулы', paused:'Автотексеру тоқтатылды', offline:'SafeNet-ті іске қосыңыз: 127.0.0.1:4310', waiting:'Көрінетін жазбалар күтілуде', scanned:'Тексерілді', flagged:'Белгілер', risk:'Қауіп белгілері', high:'Жоғары қауіп', medium:'Тексеру қажет', why:'Неліктен белгіленді?', close:'Жабу', retry:'Қайталау', pause:'Тоқтату', resume:'Қосу', local:'Жергілікті талдау · жазба мәтіні', disclaimer:'Бұл айыптау емес, қауіп белгілері. Мәтінмән мен дереккөзді тексеріңіз.', short:'Алғашқы 10 000 таңба талданды.', noCaption:'Жазба сипаттамасы табылмады. Мәтінді қолмен тексеруге болады.', manual:'SafeNet-ті ашу', privacy:'Жеке хаттар талданбайды', inspect:'Себептер мен дәйексөздер', loading:'Жазбалар тексерілуде…', unsupported:'Сипаттама табылмады. Жазбаны бөлек ашып көріңіз.' },
  };
  const style = `:host{all:initial;font-family:Arial,sans-serif!important;color:#173f32!important;font-size:13px!important;line-height:1.5!important;display:block!important}*{box-sizing:border-box}button,a{font:inherit}button{cursor:pointer}button:focus-visible,a:focus-visible{outline:3px solid #b4d785;outline-offset:2px}.badge{display:inline-flex;align-items:center;gap:8px;padding:9px 13px;margin:8px 0;background:#fff0d4;color:#744c0b;border:1px solid #e9c987;border-radius:9px;font-weight:700;font-size:12px;text-align:left;box-shadow:0 2px 8px #0001}.badge.high{background:#fff0e8;color:#91391e;border-color:#e9bca9}.brand{font-weight:800;color:#254f3b}.panel{max-width:480px;max-height:360px;overflow:auto;background:#f9fbf4;border:1px solid #c8d9ba;border-radius:10px;padding:15px;margin-bottom:10px;box-shadow:0 9px 28px #0002}.row{display:flex;gap:10px;justify-content:space-between;align-items:center}.close{border:0;background:transparent;font-size:18px;color:#48624a}.signal{border-top:1px solid #dfe7d6;padding:10px 0}.signal strong{font-size:13px}.signal p{margin:5px 0;font-size:12px;color:#5e735d}blockquote{margin:7px 0;padding:7px 10px;border-left:3px solid #90ae60;background:#edf3e2;font-size:12px;white-space:pre-wrap;overflow-wrap:anywhere}.note{font-size:11px;color:#74806c;margin:9px 0}.status{background:#f9fbf4;border:1px solid #bfceae;border-radius:12px;padding:12px 14px;box-shadow:0 4px 22px #0002;width:285px}.status.offline{background:#fff6e7;border-color:#e5c68e}.title{font-weight:700;font-size:12px;margin:4px 0}.mini{font-size:10px;color:#71816c}.actions{display:flex;gap:7px;margin-top:8px;flex-wrap:wrap}.actions button,.actions a{border:1px solid #cbd9bd;background:#e8efdE;color:#345737;border-radius:5px;padding:4px 8px;font-size:10px;text-decoration:none}.count{font-size:11px;color:#5a7151}.hide{display:none!important}`;
  Object.assign(COPY.ru,{browseStart:'▶ Автопрокрутка',browseStop:'■ Остановить прокрутку',browseInfo:'Прокрутка после проверки · только активная вкладка',browseWaiting:'Автопрокрутка ждёт локальный анализатор'});
  Object.assign(COPY.kk,{browseStart:'▶ Автоайналдыру',browseStop:'■ Айналдыруды тоқтату',browseInfo:'Тексергеннен кейін айналдыру · тек белсенді бет',browseWaiting:'Автоайналдыру жергілікті талдағышты күтуде'});
  Object.assign(COPY.ru,{saved:'Сохранено в мониторинге',watch:'Совпадение правила наблюдения',watchKeywords:'Ключевые слова',savedNote:'Текст и источник сохранены локально в SafeNet.',notSaved:'Для сохранения включите мониторинг в SafeNet.'});
  Object.assign(COPY.kk,{saved:'Мониторингте сақталды',watch:'Бақылау ережесіне сәйкес',watchKeywords:'Кілт сөздер',savedNote:'Мәтін мен дереккөз SafeNet-те жергілікті сақталды.',notSaved:'Сақтау үшін SafeNet мониторингін қосыңыз.'});
  let settings = { autoEnabled:true, autoBrowseEnabled:false, locale:'ru' };
  let browseReady = false;
  let browseProbe = null;
  let monitorRevision;
  let healthPending = false;
  let generation = 0;
  let checked = 0;
  let found = 0;
  const savedCases = new Set();
  let offline = false;
  let timer;
  let scheduleStarted = 0;
  let statusHost;
  let mediaState = {active:false};
  let mediaHost;
  let mediaHits = [];
  let mediaLast = '';
  let mediaSkipped = 0;
  let lastSkippedMedia = '';
  let routeSince = Date.now();
  const mediaElementIds=new WeakMap();
  let mediaElementSerial=0;
  let lastRoute = location.pathname;
  const states = new Map();
  const isDemo = location.origin === 'http://127.0.0.1:4310' && location.pathname === '/demo-feed' && document.documentElement.dataset.safenetDemo === 'true';
  const platform = /(^|\.)instagram\.com$/.test(location.hostname) ? 'instagram' : 'tiktok';
  const t = () => COPY[settings.locale];
  const effectiveAutoBrowse = () => settings.autoBrowseEnabled || (mediaState.active && mediaState.autoBrowse===true);
  const privateRoute = () => {try{return /^\/(direct|messages|accounts|settings|privacy|archive|saved|login|oauth)(\/|$)/i.test(decodeURIComponent(location.pathname));}catch{return true;}};
  function browseRoute(path, site=platform) {
    if(site==='instagram')return path === '/' || /^\/reels(?:\/[A-Za-z0-9_-]+)?\/?$/.test(path);
    if(site==='tiktok')return path === '/' || /^\/(?:foryou|following)\/?$/.test(path);
    return false;
  }
  function mayAutoBrowse({enabled,scanEnabled,platform:site,path,hidden,focused,offline:disconnected,ready}) {
    return Boolean(enabled && scanEnabled && browseRoute(path,site) && !hidden && focused && !disconnected && ready);
  }
  async function probeBrowse() {
    if (browseProbe || !effectiveAutoBrowse()) return browseProbe;
    browseProbe = chrome.runtime.sendMessage({type:'SAFENET_HEALTH'}).then(result=>{browseReady=Boolean(result?.ok);offline=!browseReady;setStatus();}).catch(()=>{browseReady=false;offline=true;setStatus();}).finally(()=>{browseProbe=null;});
    return browseProbe;
  }
  function autoBrowseTick() {
    if (!effectiveAutoBrowse() || !settings.autoEnabled || !browseRoute(location.pathname) || document.hidden || !document.hasFocus()) return;
    if (!browseReady || offline) { probeBrowse(); return; }
    // Wait for the actual current source's inference, not a fixed wall-clock delay.
    const gate=mediaAdvanceGate(mediaState,mediaState.active?mediaContext():null,Date.now(),routeSince);
    if(!gate.ready)return;
    if (!mayAutoBrowse({enabled:effectiveAutoBrowse(),scanEnabled:settings.autoEnabled,platform,path:location.pathname,hidden:document.hidden,focused:document.hasFocus(),offline,ready:browseReady})) return;
    // Scroll only the active feed container. Never activate page controls or links.
    const player = Array.from(document.querySelectorAll(platform==='instagram'?'[aria-label="Video player"]':'video')).find(visible);
    let target = player?.parentElement;
    while (target && target !== document.body) {
      const css = getComputedStyle(target);
      if (/^(auto|scroll)$/.test(css.overflowY) && target.scrollHeight > target.clientHeight + 20) break;
      target = target.parentElement;
    }
    const amount = Math.max(180,Math.min(560,Math.round((target?.clientHeight || innerHeight)*0.65)));
    if(target && target !== document.body)target.scrollBy({top:amount,behavior:'smooth'});
    else window.scrollBy({top:amount,behavior:'smooth'});
    if(gate.incomplete && lastSkippedMedia!==`${mediaState.sessionId}:${mediaState.revision}`){lastSkippedMedia=`${mediaState.sessionId}:${mediaState.revision}`;mediaSkipped++;setStatus();}
    schedule();
  }
  function mediaAdvanceGate(state,current,now,fallbackSince) {
    if(!state.active)return {ready:true,incomplete:false};
    const coverage=state.coverage||{};
    const age=now-(Number.isFinite(coverage.since)?coverage.since:fallbackSince);
    if(state.paused && state.reason==='no-video' && current?.reason==='no-video' && age>=240000)return {ready:true,incomplete:true};
    if(state.paused || !current?.ok || state.url!==current.url || state.mediaId!==current.mediaId)return {ready:false,incomplete:false};
    // Bound CPU/model failures. The next lease invalidates every old pending job.
    if(age>=240000)return {ready:true,incomplete:true};
    if(state.pending?.length)return {ready:false,incomplete:false};
    const frames=coverage.frame?.status==='complete' && (coverage.frame.completedCount||0)>=3;
    const audio=coverage.audio?.status==='complete' || coverage.audio?.status==='unavailable';
    return {ready:Boolean(frames&&audio),incomplete:false};
  }
  const visible = element => {
    if (!element?.isConnected) return false;
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0 || rect.bottom <= 0 || rect.right <= 0 || rect.top >= innerHeight || rect.left >= innerWidth) return false;
    for (let e = element; e; e = e.parentElement) { const s = getComputedStyle(e); if (s.display === 'none' || s.visibility === 'hidden' || Number(s.opacity) === 0 || e.hidden || e.getAttribute('aria-hidden') === 'true') return false; }
    return true;
  };
  function publicMediaUrl() { return `${location.origin}${location.pathname}`; }
  function mediaContext() {
    if (privateRoute()) return {ok:false,reason:'private'};
    if (!settings.autoEnabled) return {ok:false,reason:'paused'};
    if (document.hidden || !document.hasFocus()) return {ok:false,reason:'hidden'};
    const videos=Array.from(document.querySelectorAll('video'));
    const audible=videos.filter(video=>!video.paused && !video.muted && video.volume>0 && !video.ended);
    if(audible.length>1)return {ok:false,reason:'ambiguous-audio'};
    const candidates = videos.filter(visible).map(video=>{
      const r=video.getBoundingClientRect();
      const x=Math.max(0,r.left),y=Math.max(0,r.top),right=Math.min(innerWidth,r.right),bottom=Math.min(innerHeight,r.bottom);
      return {video,rect:{x,y,width:right-x,height:bottom-y}};
    }).filter(item=>item.rect.width>=80 && item.rect.height>=80).sort((a,b)=>b.rect.width*b.rect.height-a.rect.width*a.rect.height);
    const candidate=candidates[0];
    if (!candidate) return {ok:false,reason:'no-video'};
    if(audible.length && audible[0]!==candidate.video)return {ok:false,reason:'ambiguous-audio'};
    if(!mediaElementIds.has(candidate.video))mediaElementIds.set(candidate.video,++mediaElementSerial);
    const mediaId=`${mediaElementIds.get(candidate.video)}:${hashText(candidate.video.currentSrc||candidate.video.src||'')}`;
    const excludeRects=Array.from(document.querySelectorAll('[data-safenet]')).filter(visible).slice(0,12).map(host=>{const r=host.getBoundingClientRect();return {x:r.left,y:r.top,width:r.width,height:r.height};});
    return {ok:true,url:publicMediaUrl(),platform,locale:settings.locale,mediaId,excludeRects,duration:Number.isFinite(candidate.video.duration)?candidate.video.duration:0,playbackRate:Number.isFinite(candidate.video.playbackRate)?candidate.video.playbackRate:1,rect:candidate.rect,viewport:{width:innerWidth,height:innerHeight},mediaTime:Number.isFinite(candidate.video.currentTime)?candidate.video.currentTime:0,paused:candidate.video.paused,muted:candidate.video.muted || candidate.video.volume===0,autoBrowseEnabled:effectiveAutoBrowse()===true,hidden:false};
  }
  function stopOnSignal() {
    if(settings.autoBrowseEnabled){settings.autoBrowseEnabled=false;chrome.storage.local.set({autoBrowseEnabled:false});}
    if(mediaState.active && mediaState.autoBrowse){mediaState.autoBrowse=false;chrome.runtime.sendMessage({type:'SAFENET_MEDIA_BROWSE_STOP',sessionId:mediaState.sessionId}).catch(()=>{});}
  }
  function mediaStamp(ms) { const seconds=Math.max(0,Math.floor(Number(ms||0)/1000));return `${Math.floor(seconds/60).toString().padStart(2,'0')}:${(seconds%60).toString().padStart(2,'0')}`; }
  function aiStatusText(status,locale) {
    const labels=locale==='kk'?{completed:'талданды',ready:'дайын',ok:'талданды',busy:'өңдеуде',model_missing:'модель орнатылмаған',no_transcript:'сөйлеу танылмады',timeout:'уақыт бітті'}:{completed:'проверено',ready:'готов',ok:'проверено',busy:'обработка',model_missing:'модель не установлена',no_transcript:'речь не распознана',timeout:'тайм-аут'};
    return labels[status]||(locale==='kk'?'қолжетімсіз · OCR/Whisper ғана':'недоступен · только OCR/Whisper');
  }
  function renderMedia() {
    mediaHost?.remove();mediaHost=null;
    if(privateRoute() || !mediaHits.length)return;
    const {host,shadow}=shadowHost();mediaHost=host;
    host.style.cssText='position:fixed!important;right:16px!important;top:16px!important;z-index:2147483646!important;width:min(360px,calc(100vw - 32px))!important;';
    const panel=element('div',null,'panel');panel.style.maxHeight='65vh';
    const row=element('div',null,'row');row.append(element('strong',settings.locale==='kk'?'SafeNet · Видео талдауы':'SafeNet · Наблюдения в видео'));
    const close=element('button','×','close');close.type='button';close.setAttribute('aria-label',t().close);close.onclick=()=>{mediaHits=[];renderMedia();};row.append(close);panel.append(row);
    for(const hit of mediaHits.slice(-6)){
      const item=element('div',null,'signal');
      item.append(element('strong',`${hit.kind==='vision'?(settings.locale==='kk'?'ИИ · кадрды талдау':'ИИ · анализ кадра'):hit.kind==='qr'?'QR-код':hit.kind==='audio'?(settings.locale==='kk'?'Дауыс':'Речь'):(settings.locale==='kk'?'Кадрдағы мәтін':'Текст в кадре')} · ${hit.analysis.score}/100`));
      for(const observation of hit.evidence.filter(e=>e.kind==='vision'&&typeof e.text==='string').slice(0,6)){
        item.append(element('p',`${mediaStamp(observation.startMs)} · ${settings.locale==='kk'?'ИИ пайымы':'Предположение ИИ'}${observation.model?` · ${String(observation.model).slice(0,80)}`:''}`),element('p',observation.text));
      }
      for(const signal of hit.analysis.signals){
        if(typeof signal.quote!=='string' || !hit.text.includes(signal.quote))continue;
        const evidence=hit.evidence.find(e=>e.kind!=='vision' && typeof e.text==='string' && e.text.includes(signal.quote));
        // Model descriptions are hypotheses, never verbatim video/audio quotations.
        if(!evidence)continue;
        const stamp=evidence?`${mediaStamp(evidence.startMs)}${evidence.endMs>evidence.startMs?`–${mediaStamp(evidence.endMs)}`:''}`:(settings.locale==='kk'?'Үзінді бойынша':'В пределах фрагмента');
        item.append(element('p',`${stamp} · ${signal.label}`),element('blockquote',signal.quote));
      }
      item.append(element('p',settings.locale==='kk'?'Танылған мәтін мен ИИ пайымы қателесуі мүмкін. Түпнұсқамен салыстырыңыз.':'Распознанный текст и предположения ИИ могут содержать ошибки. Сверьте с оригиналом.','note'));panel.append(item);
    }
    panel.append(element('p',t().disclaimer,'note'));shadow.append(panel);document.documentElement.append(host);
  }
  function receiveMedia(message) {
    if(message.type==='SAFENET_MEDIA_STATE'){
      if(message.active && (message.sessionId!==mediaState.sessionId || message.mediaId!==mediaState.mediaId)){mediaHits=[];mediaLast='';routeSince=Date.now();}
      mediaState={...message};setStatus();renderMedia();return;
    }
    const result=message.result;
    if(message.type!=='SAFENET_MEDIA_RESULT' || !mediaState.active || message.sessionId!==mediaState.sessionId || message.url!==publicMediaUrl() || privateRoute() || !settings.autoEnabled || document.hidden)return;
    const currentMedia=mediaContext();
    if(!currentMedia.ok || message.mediaId!==currentMedia.mediaId || message.revision!==mediaState.revision)return;
    if(!result?.ok){mediaLast=settings.locale==='kk'?'Медиа талдауы аяқталмады. Кеңейтімдегі күйді тексеріңіз.':'Медиа не обработано. Проверьте статус в расширении.';setStatus();return;}
    if(typeof result.text!=='string' || !Number.isFinite(result.analysis?.score) || !Array.isArray(result.analysis.signals))return;
    const evidence=Array.isArray(result.evidence)?result.evidence:[];
    const first=evidence.find(e=>e.kind==='vision')||evidence.find(e=>['audio','frame','qr'].includes(e.kind));
    if(result.stored && result.monitoring?.caseId)savedCases.add(result.monitoring.caseId);
    mediaLast=result.coverage?.visualObjects===true?(settings.locale==='kk'?'Кадр ИИ арқылы талданды · барлық видео емес':'Кадр проверен ИИ · это часть видео'):result.text.trim()?(settings.locale==='kk'?'Видео/дыбыстағы мәтін тексерілді':'Текст видео/звука проверен'):(settings.locale==='kk'?'Бұл үзіндіде мәтін не сөз танылмады':'В этом фрагменте текст или речь не распознаны');
    if((result.analysis.score>=30 || result.monitoring?.flagged) && first){
      const key=hashText(`${first.kind}|${result.text}|${evidence.filter(e=>e.kind==='vision').map(e=>e.text).join('|')}`);
      if(!mediaHits.some(hit=>hit.key===key)){mediaHits.push({key,kind:first.kind,evidence,text:result.text,analysis:result.analysis});mediaHits=mediaHits.slice(-6);found++;stopOnSignal();renderMedia();}
    }
    setStatus();
  }
  function cleanText(element) {
    const parts = [];
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const parent = node.parentElement;
      if (!parent || parent.closest('script,style,input,textarea,select,button,[contenteditable]:not([contenteditable="false"]),[data-safenet],[hidden],[aria-hidden="true"]')) continue;
      let hidden = false;
      for (let e = parent; e; e = e.parentElement) { const s = getComputedStyle(e); if (s.display === 'none' || s.visibility === 'hidden' || Number(s.opacity) === 0) { hidden = true; break; } if (e === element) break; }
      if (!hidden && node.textContent.trim()) parts.push(node.textContent.trim());
      if (parts.join(' ').length > 11000) break;
    }
    return parts.join(' ').replace(/\s+/g,' ').trim();
  }
  function hashText(value) { let hash = 2166136261; for (let i=0;i<value.length;i++) { hash ^= value.charCodeAt(i); hash = Math.imul(hash,16777619); } return (hash >>> 0).toString(36); }
  function instagramPostRoute(path) {
    const match = /^\/(?:([a-z0-9._]+)\/)?(p|reel)\/([A-Za-z0-9_-]+)\/?$/i.exec(path);
    return match ? {owner:match[1]?.toLowerCase(),kind:match[2],shortcode:match[3]} : null;
  }
  function publicInstagramCaption() {
    const route = instagramPostRoute(location.pathname);
    if (!route) return null;
    // Metadata is a routing hint only. Never analyze its hidden description text.
    const canonical = document.querySelector('meta[property="og:url"]')?.getAttribute('content');
    let owner;
    try {
      const url = new URL(canonical);
      const post = instagramPostRoute(url.pathname);
      if (url.origin !== location.origin || !post?.owner || post.kind !== route.kind || post.shortcode !== route.shortcode || (route.owner && route.owner !== post.owner)) return null;
      owner = post.owner;
    } catch { return null; }
    for (const link of Array.from(document.querySelectorAll('a[href]')).slice(0,200)) {
      try { const url = new URL(link.getAttribute('href'),location.origin); if(url.origin !== location.origin || url.pathname.toLowerCase() !== `/${owner}/`)continue; } catch { continue; }
      let header = link.parentElement;
      for (let depth=0; header && depth<4; depth++,header=header.parentElement) {
        if (header.tagName !== 'DIV') continue;
        const caption = header.nextElementSibling;
        if (!caption || !['SPAN','H1','P'].includes(caption.tagName)) continue;
        const root = header.parentElement;
        const children = Array.from(root?.children || []).filter(child=>!child.hasAttribute('data-safenet'));
        if (children.length !== 2 || children[0] !== header || children[1] !== caption) continue;
        const times = Array.from(header.querySelectorAll('time[datetime]'));
        // Comment timestamps link to /c/<id>/; the publication timestamp is not a link.
        if (times.length !== 1 || times[0].closest('a[href]')) continue;
        if (caption.querySelector('time,button,input,textarea,select,form,video,img,[role="button"],[role="textbox"],[contenteditable="true"]')) continue;
        if (!visible(caption)) continue;
        return {root,caption};
      }
    }
    return null;
  }
  function sourceUrl(root) {
    const pattern = platform === 'instagram' ? /^\/(p|reel)\/[^/]+/ : /^\/@[^/]+\/video\/\d+/;
    for (const link of root.querySelectorAll('a[href]')) {
      try { const url = new URL(link.getAttribute('href'),location.origin); if (url.origin === location.origin && pattern.test(url.pathname)) return `${url.origin}${url.pathname}`; } catch {}
    }
    return `${location.origin}${location.pathname}`;
  }
  function instagramReelCaptions() {
    if (!(location.pathname === '/' || /^\/reels?(?:\/|$)/.test(location.pathname))) return [];
    const result = [];
    for (const root of Array.from(document.querySelectorAll('[aria-label="Video player"]')).slice(0,80)) {
      // Instagram places its player controls and the video in sibling branches.
      // Walk only two ancestors and never borrow media from a multi-player feed.
      let mediaRoot=root;
      for(let depth=0;mediaRoot && depth<2 && !mediaRoot.querySelector('video');depth++)mediaRoot=mediaRoot.parentElement;
      if(!mediaRoot?.querySelector('video'))continue;
      if(mediaRoot!==root){const players=mediaRoot.querySelectorAll('[aria-label="Video player"]');if(players.length!==1 || players[0]!==root)continue;}
      const captions = Array.from(root.querySelectorAll('[role="button"][aria-disabled="false"] > div > div[dir="auto"]')).filter(caption=>{
        if(caption.closest('[aria-label="Video player"]') !== root || !visible(caption))return false;
        if(caption.closest('form,[role="textbox"],[contenteditable="true"]'))return false;
        if(caption.querySelector('time,button,input,textarea,select,form,video,img,svg,[role="button"],[role="textbox"]'))return false;
        return Boolean(caption.querySelector('span'));
      });
      // Ambiguous controls never become a whole-player or whole-feed text sample.
      if(captions.length===1)result.push({root,caption:captions[0],anchor:captions[0].closest('[role="button"]')});
    }
    return result;
  }
  function discoverCandidates() {
    const candidates = [];
    if (isDemo) return Array.from(document.querySelectorAll('[data-safenet-demo-post]')).map(root=>({root,caption:root.querySelector('[data-safenet-caption]'),platform:root.dataset.platform})).filter(item=>item.caption && ['instagram','tiktok'].includes(item.platform));
    if (platform === 'instagram') {
      for (const root of document.querySelectorAll('article')) {
        const caption = root.querySelector('[data-testid="post-caption"],h1,div._a9zs,[class*="Caption"]');
        if (caption) candidates.push({root,caption});
      }
      for(const reel of instagramReelCaptions())if(!candidates.some(item=>item.caption===reel.caption))candidates.push(reel);
      if (instagramPostRoute(location.pathname)) {
        const publicCaption = publicInstagramCaption();
        const caption = publicCaption?.caption || document.querySelector('main h1,[role="dialog"] h1,[data-testid="post-caption"]');
        if (caption && !candidates.some(item=>item.caption===caption || item.caption.contains?.(caption) || caption.contains?.(item.caption))) candidates.push(publicCaption || {root:caption,caption});
      }
    } else {
      for (const caption of document.querySelectorAll('[data-e2e="video-desc"],[data-e2e="browse-video-desc"],[data-e2e="search-card-video-caption"]')) {
        const root = caption.closest('article,[data-e2e="recommend-list-item-container"],[data-e2e="recommend-list-item"],[data-e2e="feed-video"],[data-e2e="video-detail"]') || caption;
        if (!candidates.some(item=>item.root===root)) candidates.push({root,caption});
      }
    }
    return candidates.filter(({root,caption}) => !root.closest('[data-safenet],form,[contenteditable="true"],[role="textbox"]') && !caption.closest('form,[contenteditable="true"],[role="textbox"]'));
  }
  function element(tag,text,className) { const node = document.createElement(tag); if (text) node.textContent=text; if(className)node.className=className; return node; }
  function shadowHost() { const host=element('div');host.setAttribute('data-safenet','');const shadow=host.attachShadow({mode:'open'});shadow.append(element('style',style));return {host,shadow}; }
  function setStatus() {
    if (privateRoute()) { statusHost?.remove();statusHost=null;return; }
    if (!statusHost) { const box=shadowHost();statusHost=box.host;statusHost.style.cssText='position:fixed!important;left:16px!important;bottom:16px!important;z-index:2147483646!important;width:285px!important;';document.documentElement.append(statusHost); }
    const shadow=statusHost.shadowRoot;shadow.querySelector('.status')?.remove();const box=element('div',null,`status${offline?' offline':''}`);
    box.append(element('div','SafeNet KZ','brand'),element('div',!settings.autoEnabled?t().paused:offline?t().offline:t().active,'title'));
    box.append(element('div',`${t().scanned}: ${checked} · ${t().flagged}: ${found}`,'count'));
    box.append(element('div',`v4.0.0 · ${!states.size?t().unsupported:t().local}`,'mini'));
    if(savedCases.size)box.append(element('div',`${t().saved}: ${savedCases.size}`,'count'));
    if(mediaState.active){
      box.append(element('div',settings.locale==='kk'?'● Видео мен дыбысты талдау қосулы':'● Анализ видео и звука включён','title'));
      if(mediaState.paused)box.append(element('div',settings.locale==='kk'?'Көрінетін, белсенді видео күтілуде':'Ожидаем видимое активное видео','mini'));
      if(mediaState.pending?.length)box.append(element('div',settings.locale==='kk'?'Талдау жүріп жатыр… Автоайналдыру нәтижені күтеді.':'Идёт обработка… Автопрокрутка ждёт результат.','mini'));
      const coverage=mediaState.coverage;
      if(coverage)box.append(element('div',settings.locale==='kk'?`Кадрлар: ${Math.min(3,coverage.frame?.completedCount||0)}/3 · Дыбыс: ${coverage.audio?.status==='complete'?'тексерілді':coverage.audio?.status==='unavailable'?'қолжетімсіз':'күтілуде'}`:`Кадры: ${Math.min(3,coverage.frame?.completedCount||0)}/3 · Речь: ${coverage.audio?.status==='complete'?'проверена':coverage.audio?.status==='unavailable'?'недоступна':'ожидание'}`,'mini'));
      if(coverage?.frame?.status==='error' || coverage?.audio?.status==='error')box.append(element('div',settings.locale==='kk'?'Үзінді толық талданбады. 4 минуттан кейін келесі жазбаға өтеді.':'Фрагмент обработан не полностью. Через 4 минуты переходим дальше.','mini'));
      if(mediaState.ai){const ai=mediaState.ai;box.append(element('div',`${settings.locale==='kk'?'Жергілікті ИИ':'Локальный ИИ'}: ${aiStatusText(ai.status,settings.locale)}${ai.model?` · ${ai.model}`:''}${Number.isFinite(ai.elapsedMs)?` · ${Math.round(ai.elapsedMs/1000)} ${settings.locale==='kk'?'с':'с'}`:''}`,'mini'));}
      else box.append(element('div',settings.locale==='kk'?'ИИ нәтижесі әлі жоқ · OCR/Whisper бөлек тексеріледі':'Результата ИИ пока нет · OCR/Whisper проверяются отдельно','mini'));
      const current=mediaContext();
      if(current.ok && current.muted)box.append(element('div',settings.locale==='kk'?'Дыбыс өшірулі: тек кадрлар. Сөйлеуді тексеру үшін видеода дыбысты қосыңыз.':'Звук выключен: только кадры. Включите звук видео для проверки речи.','mini'));
      else if(current.ok && current.playbackRate!==1)box.append(element('div',settings.locale==='kk'?'Дыбысты талдау үшін жылдамдықты 1× қойыңыз.':'Для анализа речи установите скорость 1×.','mini'));
      if(mediaLast)box.append(element('div',mediaLast,'mini'));
    }
    if(mediaSkipped)box.append(element('div',settings.locale==='kk'?`Уақыт бітіп, толық тексерілмегені: ${mediaSkipped}`:`Пропущено по тайм-ауту без полной проверки: ${mediaSkipped}`,'mini'));
    if(effectiveAutoBrowse())box.append(element('div',browseReady?t().browseInfo:t().browseWaiting,'mini'));
    const actions=element('div',null,'actions');
    const toggle=element('button',settings.autoEnabled?t().pause:t().resume);toggle.type='button';toggle.onclick=()=>chrome.storage.local.set({autoEnabled:!settings.autoEnabled});actions.append(toggle);
    const lang=element('button',settings.locale==='ru'?'ҚАЗ':'РУС');lang.type='button';lang.onclick=()=>chrome.storage.local.set({locale:settings.locale==='ru'?'kk':'ru'});actions.append(lang);
    if(browseRoute(location.pathname) || effectiveAutoBrowse()){const browse=element('button',effectiveAutoBrowse()?t().browseStop:t().browseStart);browse.type='button';browse.setAttribute('aria-pressed',String(effectiveAutoBrowse()));browse.onclick=()=>{if(effectiveAutoBrowse()){stopOnSignal();setStatus();}else chrome.storage.local.set({autoBrowseEnabled:true});};actions.append(browse);}
    if(offline){const retry=element('button',t().retry);retry.type='button';retry.onclick=()=>{offline=false;for(const state of states.values())state.key='';schedule();};actions.append(retry);}
    const open=element('a',t().manual);open.href='http://127.0.0.1:4310/';open.target='_blank';open.rel='noopener noreferrer';actions.append(open);box.append(actions);shadow.append(box);
    if(mediaState.active){const stop=element('button',settings.locale==='kk'?'■ Видео/дыбысты тоқтату':'■ Остановить видео/звук');stop.type='button';stop.onclick=()=>chrome.runtime.sendMessage({type:'SAFENET_MEDIA_STOP'});actions.append(stop);}
  }
  function renderBadge(state,analysis,text,monitoring) {
    state.host?.remove();state.host=null;
    if (analysis.score < 30 && !monitoring?.flagged) return;
    const {host,shadow}=shadowHost();state.host=host;
    const badge=element('button',`⚑ SafeNet · ${analysis.score<30?t().watch:analysis.level==='high'?t().high:t().medium} · ${analysis.score}/100`,`badge${analysis.level==='high'?' high':''}`);badge.type='button';badge.setAttribute('aria-expanded','false');badge.setAttribute('aria-label',`${t().risk}. ${t().inspect}`);
    const panel=element('div',null,'panel hide');const heading=element('div',null,'row');heading.append(element('strong',t().why));const close=element('button','×','close');close.type='button';close.setAttribute('aria-label',t().close);heading.append(close);panel.append(heading);
    for (const signal of analysis.signals) {
      const card=element('div',null,'signal');card.append(element('strong',signal.label||signal.id||t().risk));
      if(signal.description)card.append(element('p',signal.description));
      // Never manufacture evidence: show only exact substrings of the captured text.
      if(typeof signal.quote==='string' && text.includes(signal.quote))card.append(element('blockquote',signal.quote));
      panel.append(card);
    }
    if(analysis.summary)panel.append(element('p',analysis.summary,'note'));
    if(monitoring?.matchedKeywords?.length)panel.append(element('p',`${t().watchKeywords}: ${monitoring.matchedKeywords.join(', ')}`,'note'));
    panel.append(element('p',monitoring?.stored?t().savedNote:!monitoring?.enabled?t().notSaved:'','note'));
    panel.append(element('p',t().disclaimer,'note'));if(text.length>=10000)panel.append(element('p',t().short,'note'));
    badge.onclick=()=>{const open=panel.classList.toggle('hide')===false;badge.setAttribute('aria-expanded',String(open));};close.onclick=()=>{panel.classList.add('hide');badge.setAttribute('aria-expanded','false');badge.focus();};
    host.addEventListener('click',event=>event.stopPropagation());
    shadow.append(badge,panel);(state.anchor||state.caption).insertAdjacentElement('afterend',host);
  }
  async function inspect(state) {
    if (!settings.autoEnabled || privateRoute() || !visible(state.caption)) return;
    const raw=cleanText(state.caption);if(raw.length<12)return;
    const text=raw.slice(0,10000),url=isDemo?'':sourceUrl(state.root),postPlatform=isDemo?state.platform:platform,key=hashText(`${settings.locale}|${postPlatform}|${url}|${text}`);
    if(state.host && !state.host.isConnected){state.host=null;state.key='';}
    if(state.key===key || state.pending===key)return;
    state.host?.remove();state.host=null;state.pending=key;const epoch=generation;
    try {
      const result=await chrome.runtime.sendMessage({type:'SAFENET_SCAN',text,url,platform:postPlatform,locale:settings.locale});
      if(epoch!==generation || !settings.autoEnabled || privateRoute() || !state.caption.isConnected || cleanText(state.caption).slice(0,10000)!==text)return;
      if(!result?.ok){offline=result?.error!=='paused';browseReady=false;setStatus();return;}
      offline=false;browseReady=true;state.key=key;checked++;if(result.analysis.score>=30 || result.monitoring?.flagged){found++;stopOnSignal();}if(result.stored && result.monitoring?.caseId)savedCases.add(result.monitoring.caseId);renderBadge(state,result.analysis,text,result.monitoring);setStatus();
    } catch { offline=true;browseReady=false;setStatus(); } finally { if(state.pending===key)state.pending=''; }
  }
  const intersection=new IntersectionObserver(entries=>{for(const entry of entries)if(entry.isIntersecting){const state=states.get(entry.target);if(state)inspect(state);}},{threshold:0.05});
  function cleanup() { for(const state of states.values()){intersection.unobserve(state.root);state.host?.remove();}states.clear();generation++;checked=0;found=0;savedCases.clear();mediaHits=[];mediaLast='';mediaHost?.remove();mediaHost=null; }
  function discover() {
    if(lastRoute!==location.pathname){lastRoute=location.pathname;routeSince=Date.now();cleanup();}
    if(privateRoute()){cleanup();setStatus();return;}
    if(!settings.autoEnabled){setStatus();return;}
    for(const [root,state] of states)if(!root.isConnected || !state.caption.isConnected){intersection.unobserve(root);state.host?.remove();states.delete(root);}
    for(const item of discoverCandidates()){
      let state=states.get(item.root);
      if(!state){if(states.size>=200){const removable=[...states].find(([root])=>!visible(root));if(removable){intersection.unobserve(removable[0]);removable[1].host?.remove();states.delete(removable[0]);}else break;}state={...item,key:'',pending:'',host:null};states.set(item.root,state);intersection.observe(item.root);}
      else {if(state.caption!==item.caption && state.host){state.host.remove();state.host=null;state.key='';}state.caption=item.caption;state.anchor=item.anchor;}
      inspect(state);
    }
    setStatus();
  }
  function schedule() {
    const now=Date.now();if(!scheduleStarted)scheduleStarted=now;
    clearTimeout(timer);
    timer=setTimeout(()=>{scheduleStarted=0;discover();},Math.max(0,Math.min(450,1500-(now-scheduleStarted))));
  }
  async function refreshHealth() {
    if(healthPending || document.hidden || privateRoute() || !settings.autoEnabled)return;
    healthPending=true;
    try {
      const result=await chrome.runtime.sendMessage({type:'SAFENET_HEALTH'});
      if(!result?.ok){offline=true;browseReady=false;setStatus();return;}
      const revision=result.monitoring?.revision??null;
      if(monitorRevision!==undefined && revision!==monitorRevision){
        // Config changes must rescan the visible post, even if its caption is unchanged.
        generation++;
        for(const state of states.values()){state.key='';state.pending='';}
        schedule();
      }
      monitorRevision=revision;offline=false;browseReady=true;setStatus();
    } catch {offline=true;browseReady=false;setStatus();}
    finally {healthPending=false;}
  }
  async function boot() {
    try {const saved=await chrome.storage.local.get(['autoEnabled','autoBrowseEnabled','locale']);settings={autoEnabled:saved.autoEnabled!==false,autoBrowseEnabled:saved.autoBrowseEnabled===true,locale:saved.locale==='kk'?'kk':'ru'};}catch{}
    new MutationObserver(records=>{if(records.some(record=>record.type==='characterData' || (!record.target.closest?.('[data-safenet]') && [...record.addedNodes,...record.removedNodes].some(node=>node.nodeType!==1 || !node.hasAttribute?.('data-safenet')))))schedule();}).observe(document.body,{childList:true,subtree:true,characterData:true});
    chrome.storage.onChanged.addListener((changes,area)=>{if(area!=='local')return;if(changes.autoBrowseEnabled){settings.autoBrowseEnabled=changes.autoBrowseEnabled.newValue===true;if(settings.autoBrowseEnabled)probeBrowse();setStatus();}if(changes.autoEnabled || changes.locale){settings.autoEnabled=changes.autoEnabled?changes.autoEnabled.newValue!==false:settings.autoEnabled;settings.locale=changes.locale?(changes.locale.newValue==='kk'?'kk':'ru'):settings.locale;cleanup();schedule();}});
    addEventListener('popstate',schedule);addEventListener('scroll',schedule,{passive:true,capture:true});
    chrome.runtime.onMessage.addListener((message,sender,reply)=>{
      if(sender.id!==chrome.runtime.id)return;
      if(message.type==='SAFENET_MEDIA_CONTEXT'){reply(mediaContext());return;}
      if(['SAFENET_MEDIA_STATE','SAFENET_MEDIA_RESULT'].includes(message.type))receiveMedia(message);
    });
    chrome.runtime.sendMessage({type:'SAFENET_MEDIA_STATUS'}).then(response=>{if(response?.ok && response.state?.active)receiveMedia({...response.state,type:'SAFENET_MEDIA_STATE'});}).catch(()=>{});
    refreshHealth();
    // SPA route changes can occur without DOM mutations; backoff also retries an offline server.
    setInterval(()=>{if(!document.hidden && (lastRoute!==location.pathname || offline))schedule();refreshHealth();},15000);
    setInterval(autoBrowseTick,8000);
    discover();
  }
  boot();
})();

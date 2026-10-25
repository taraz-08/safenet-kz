'use strict';

const LOCAL_API = 'http://127.0.0.1:4310';
const cache = new Map();
const pending = new Map();
const queue = [];
let active = 0;
let token = null;
let tokenPromise = null;
let monitorState = {enabled:false,revision:null};
const MAX_CACHE = 200;
const TIMEOUT = 12000;
const CLIENT_VERSION = '4.0.0';

function privatePagePath(path) {
  try { return /^\/(direct|messages|accounts|settings|privacy|archive|saved|login|oauth)(\/|$)/i.test(decodeURIComponent(path)); }
  catch { return true; }
}

async function requestToken() {
  if (token) return token;
  if (!tokenPromise) tokenPromise = (async () => {
    const response = await fetch(`${LOCAL_API}/api/extension-token`, { signal: AbortSignal.timeout(TIMEOUT), credentials: 'omit', cache: 'no-store' });
    if (!response.ok) throw new Error('offline');
    const data = await response.json();
    if (typeof data.token !== 'string' || !data.token) throw new Error('offline');
    const nextMonitor={enabled:data.monitoring?.enabled===true,revision:typeof data.monitoring?.revision==='string'?data.monitoring.revision:null};
    if(nextMonitor.revision!==monitorState.revision || nextMonitor.enabled!==monitorState.enabled)cache.clear();
    monitorState=nextMonitor;
    token = data.token;
    return token;
  })().finally(() => { tokenPromise = null; });
  return tokenPromise;
}

function normalizeRequest(message) {
  if (typeof message.text !== 'string' || !message.text.trim()) throw new Error('empty');
  const text = message.text.trim().slice(0, 10000);
  const platform = ['instagram', 'tiktok'].includes(message.platform) ? message.platform : null;
  if (!platform) throw new Error('platform');
  const locale = message.locale === 'kk' ? 'kk' : 'ru';
  let url = '';
  if (typeof message.url === 'string' && message.url) {
    const parsed = new URL(message.url);
    const allowedHosts = platform === 'instagram' ? ['instagram.com','www.instagram.com'] : ['tiktok.com','www.tiktok.com'];
    if (parsed.protocol !== 'https:' || !allowedHosts.includes(parsed.hostname) || parsed.username || parsed.password || parsed.port) throw new Error('source');
    if (privatePagePath(parsed.pathname)) throw new Error('private');
    url = `${parsed.origin}${parsed.pathname}`.slice(0, 2048);
  }
  return { text, url, platform, locale };
}

function trustedSender(sender) {
  if (sender.id !== chrome.runtime.id) return false;
  if (!sender.tab) return true;
  try { const url = new URL(sender.url || sender.tab.url); return url.protocol === 'https:' && !url.port && ['instagram.com','www.instagram.com','tiktok.com','www.tiktok.com'].includes(url.hostname) && !privatePagePath(url.pathname); } catch { return false; }
}

async function runScan(input) {
  const settings = await chrome.storage.local.get('autoEnabled');
  if (settings.autoEnabled === false) throw new Error('paused');
  for (let attempt = 0; attempt < 2; attempt++) {
    const secret = await requestToken();
    const response = await fetch(`${LOCAL_API}/api/scan`, {
      method: 'POST', credentials: 'omit', cache: 'no-store', signal: AbortSignal.timeout(TIMEOUT),
      headers: { 'Content-Type': 'application/json', 'X-SafeNet-Token': secret }, body: JSON.stringify({...input,source:'extension',capturedAt:new Date().toISOString(),clientVersion:CLIENT_VERSION}),
    });
    if ([401,403].includes(response.status) && attempt === 0) { token = null; continue; }
    if (!response.ok) throw new Error(response.status === 429 ? 'busy' : 'offline');
    const result = await response.json();
    if (!result.analysis || !Number.isFinite(result.analysis.score) || !Array.isArray(result.analysis.signals)) throw new Error('invalid');
    return { ok: true, analysis: result.analysis, stored:result.stored===true, monitoring:result.monitoring };
  }
  throw new Error('offline');
}

function drain() {
  while (active < 2 && queue.length) {
    const job = queue.shift();
    active++;
    runScan(job.input).then(result => {
      cache.set(job.key, { result, expires: Date.now() + 5 * 60 * 1000 });
      while (cache.size > MAX_CACHE) cache.delete(cache.keys().next().value);
      job.resolve(result);
    }).catch(error => job.resolve({ ok: false, error: ['paused','busy'].includes(error.message) ? error.message : 'offline' }))
      .finally(() => { active--; pending.delete(job.key); drain(); });
  }
}

function scan(input) {
  const key = JSON.stringify({input,monitorRevision:monitorState.revision,monitorEnabled:monitorState.enabled});
  const saved = cache.get(key);
  if (saved && saved.expires > Date.now()) return Promise.resolve(saved.result);
  cache.delete(key);
  if (pending.has(key)) return pending.get(key);
  if (queue.length >= 100) return Promise.resolve({ ok: false, error: 'busy' });
  const promise = new Promise(resolve => queue.push({ key, input, resolve }));
  pending.set(key, promise);
  drain();
  return promise;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!trustedSender(sender)) return false;
  if (message?.type === 'SAFENET_HEALTH') {
    // A cached token is not evidence that the local process is still running.
    token = null;
    requestToken().then(() => sendResponse({ ok: true, monitoring:monitorState })).catch(() => { token = null; sendResponse({ ok: false, error: 'offline' }); });
    return true;
  }
  if (message?.type !== 'SAFENET_SCAN') return false;
  let input;
  try { input = normalizeRequest(message); } catch { sendResponse({ ok: false, error: 'invalid' }); return false; }
  chrome.storage.local.get('autoEnabled').then(settings => settings.autoEnabled === false ? { ok: false, error: 'paused' } : scan(input)).then(sendResponse).catch(() => sendResponse({ ok: false, error: 'offline' }));
  return true;
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.autoEnabled?.newValue === false) {
    cache.clear();
    for (const job of queue.splice(0)) { pending.delete(job.key); job.resolve({ ok: false, error: 'paused' }); }
  }
});

// Media capture is opt-in from the extension popup, never from page content.
// Stream IDs, captures, transcripts and session state stay in memory only.
const MEDIA_LIMIT_MS = 15 * 60 * 1000;
const MEDIA_API_TIMEOUT = 210000;
const MEDIA_STATUS_TIMEOUT = 30000;
let mediaSession = null;
let mediaStartPromise = null;
let mediaStopPromise = null;
let offscreenCreation = null;
let lastMediaState = {active:false,paused:false,reason:''};

function mediaPageUrl(value) {
  const parsed = new URL(value);
  if (parsed.protocol !== 'https:' || !['instagram.com','www.instagram.com'].includes(parsed.hostname) || parsed.username || parsed.password || parsed.port) throw new Error('unsupported');
  const path=decodeURIComponent(parsed.pathname);
  if (/^\/(direct|messages|accounts|settings|privacy|archive|saved|login|oauth)(\/|$)/i.test(path)) throw new Error('private');
  if(!/^\/(?:$|(?:reels|explore)\/?$|(?:[\w.]+\/)?(?:p|reel|reels)\/[\w-]+\/?$)/i.test(path))throw new Error('unsupported');
  return `${parsed.origin}${parsed.pathname}`;
}

function mediaBrowseUrl(value) {
  const path=new URL(mediaPageUrl(value)).pathname;
  return path==='/' || /^\/reels(?:\/[A-Za-z0-9_-]+)?\/?$/.test(path);
}

function normalizeMediaContext(value) {
  if (!value?.ok) throw new Error(['private','hidden','paused','no-video'].includes(value?.reason) ? value.reason : 'no-video');
  const url = mediaPageUrl(value.url);
  if (value.platform !== 'instagram' || value.hidden) throw new Error(value.hidden ? 'hidden' : 'unsupported');
  const viewport = {width:Number(value.viewport?.width),height:Number(value.viewport?.height)};
  const rect = Object.fromEntries(['x','y','width','height'].map(key=>[key,Number(value.rect?.[key])]));
  if (!Object.values(viewport).every(v=>Number.isFinite(v)&&v>0&&v<=16000) || !Object.values(rect).every(Number.isFinite) || rect.width<=0 || rect.height<=0) throw new Error('no-video');
  const left=Math.max(0,rect.x),top=Math.max(0,rect.y),right=Math.min(viewport.width,rect.x+rect.width),bottom=Math.min(viewport.height,rect.y+rect.height);
  if (right-left<32 || bottom-top<32) throw new Error('no-video');
  const mediaTime=Number(value.mediaTime);
  if(!Number.isFinite(mediaTime)||mediaTime<0)throw new Error('no-video');
  if(typeof value.mediaId!=='string'||!value.mediaId||value.mediaId.length>200)throw new Error('no-video');
  const duration=Number(value.duration);
  const playbackRate=value.playbackRate===undefined?1:Number(value.playbackRate);
  if(!Number.isFinite(playbackRate)||playbackRate<=0)throw new Error('no-video');
  const excludeRects=(Array.isArray(value.excludeRects)?value.excludeRects:[]).slice(0,12).flatMap(box=>{
    if(!box||!['x','y','width','height'].every(key=>Number.isFinite(box[key]))||box.width<=0||box.height<=0)return [];
    const x=Math.max(0,box.x),y=Math.max(0,box.y),right=Math.min(viewport.width,box.x+box.width),bottom=Math.min(viewport.height,box.y+box.height);
    return right>x&&bottom>y?[{x,y,width:right-x,height:bottom-y}]:[];
  });
  return {ok:true,url,platform:'instagram',locale:value.locale==='kk'?'kk':'ru',rect:{x:left,y:top,width:right-left,height:bottom-top},viewport,excludeRects,mediaTime,mediaId:value.mediaId,duration:Number.isFinite(duration)&&duration>0?duration:0,playbackRate,paused:Boolean(value.paused),muted:Boolean(value.muted),autoBrowseEnabled:value.autoBrowseEnabled===true,hidden:false};
}

function newMediaCoverage() {return {since:Date.now(),frame:{status:'waiting',completedCount:0,targetCount:3},audio:{status:'waiting',completedCount:0,targetCount:1}};}

function mediaState(session=mediaSession) {
  return session ? {active:true,paused:session.paused,reason:session.reason,sessionId:session.id,url:session.url,mediaId:session.mediaId,revision:session.revision,expiresAt:session.expiresAt,tabId:session.tabId,autoBrowse:session.autoBrowse===true,pending:[...session.inFlight.keys()],coverage:session.coverage,ai:session.ai} : lastMediaState;
}

async function publishMediaState(session=mediaSession) {
  if (!session || session!==mediaSession) return;
  const state=mediaState(session);
  await chrome.tabs.sendMessage(session.tabId,{type:'SAFENET_MEDIA_STATE',...state}).catch(()=>{});
  chrome.runtime.sendMessage({type:'SAFENET_MEDIA_POPUP_STATE',state}).catch(()=>{});
}

function invalidateMedia(session) {
  session.revision++;
  for(const controller of session.pending)controller.abort();
  session.pending.clear();
  session.inFlight.clear();
  session.coverage=newMediaCoverage();session.ai=null;
}

async function pauseMedia(session,reason) {
  if(session!==mediaSession)return;
  if(!session.paused || session.reason!==reason) {
    invalidateMedia(session);session.paused=true;session.reason=reason;
    chrome.runtime.sendMessage({target:'safenet-offscreen',type:'SAFENET_OFFSCREEN_INVALIDATE',sessionId:session.id}).catch(()=>{});
    await publishMediaState(session);
  }
}

async function ensureOffscreen() {
  if(offscreenCreation)return offscreenCreation;
  offscreenCreation=(async()=>{
    const contexts=await chrome.runtime.getContexts({contextTypes:['OFFSCREEN_DOCUMENT'],documentUrls:[chrome.runtime.getURL('offscreen.html')]});
    if(!contexts.length)await chrome.offscreen.createDocument({url:'offscreen.html',reasons:['USER_MEDIA'],justification:'Analyze the user-enabled Instagram video frames and tab audio locally, with audio playback preserved.'});
  })().finally(()=>{offscreenCreation=null;});
  return offscreenCreation;
}

async function stopMedia(reason='ended') {
  if(mediaStopPromise)return mediaStopPromise;
  const session=mediaSession;mediaSession=null;
  lastMediaState={active:false,paused:false,reason,sessionId:session?.id||'',url:session?.url||'',mediaId:session?.mediaId||'',revision:session?.revision||0};
  if(session){invalidateMedia(session);clearTimeout(session.expiryTimer);}
  mediaStopPromise=(async()=>{
    if(offscreenCreation)await offscreenCreation.catch(()=>{});
    await chrome.runtime.sendMessage({target:'safenet-offscreen',type:'SAFENET_OFFSCREEN_STOP',sessionId:session?.id,reason}).catch(()=>{});
    if(!mediaSession)await chrome.offscreen.closeDocument().catch(()=>{});
    if(session)await chrome.tabs.sendMessage(session.tabId,{type:'SAFENET_MEDIA_STATE',...lastMediaState}).catch(()=>{});
    chrome.runtime.sendMessage({type:'SAFENET_MEDIA_POPUP_STATE',state:lastMediaState}).catch(()=>{});
  })().finally(()=>{mediaStopPromise=null;});
  await mediaStopPromise;
  return {ok:true,state:mediaState()};
}

async function mediaApi(path,{body,signal}={}) {
  for(let attempt=0;attempt<2;attempt++) {
    const secret=await requestToken();
    // AbortSignal.any is newer than our minimum Chrome 116 requirement.
    const controller=new AbortController();
    const abort=()=>controller.abort();
    const timeout=setTimeout(abort,body?MEDIA_API_TIMEOUT:MEDIA_STATUS_TIMEOUT);
    signal?.addEventListener('abort',abort,{once:true});
    if(signal?.aborted)controller.abort();
    try {
      const response=await fetch(`${LOCAL_API}${path}`,{
        method:body?'POST':'GET',credentials:'omit',cache:'no-store',
        headers:{'Content-Type':'application/json','X-SafeNet-Token':secret},
        ...(body?{body:JSON.stringify(body)}:{}),signal:controller.signal,
      });
      if([401,403].includes(response.status)&&attempt===0){token=null;continue;}
      if(!response.ok)throw new Error(response.status===429?'busy':'processing-error');
      return await response.json();
    } finally {clearTimeout(timeout);signal?.removeEventListener('abort',abort);}
  }
  throw new Error('offline');
}

async function readMediaContext(session) {
  if(!session || session!==mediaSession)return {ok:false,reason:'ended'};
  if(Date.now()>=session.expiresAt){await stopMedia('timeout');return {ok:false,reason:'timeout'};}
  try {
    const tab=await chrome.tabs.get(session.tabId);
    mediaPageUrl(tab.url);
    const win=await chrome.windows.get(tab.windowId);
    if(!tab.active || !win.focused) {await pauseMedia(session,'inactive');return {ok:false,reason:'inactive'};}
    const settings=await chrome.storage.local.get('autoEnabled');
    if(settings.autoEnabled===false){await pauseMedia(session,'paused');return {ok:false,reason:'paused'};}
    const raw=await chrome.tabs.sendMessage(session.tabId,{type:'SAFENET_MEDIA_CONTEXT'});
    const context=normalizeMediaContext(raw);
    if(session!==mediaSession)return {ok:false,reason:'ended'};
    if(session.url!==context.url||session.mediaId!==context.mediaId){invalidateMedia(session);session.url=context.url;session.mediaId=context.mediaId;}
    const audioReason=session.audioAvailable===false?'no-track':context.muted?'muted':context.paused?'paused':context.playbackRate!==1?'playback-rate':'';
    const audioCoverage=session.coverage.audio;
    const audioChanged=audioCoverage.status==='waiting'&&Boolean(audioReason) || audioCoverage.status==='unavailable'&&audioCoverage.reason!==audioReason;
    if(audioChanged)session.coverage.audio=audioReason?{status:'unavailable',reason:audioReason}:{status:'waiting'};
    const changed=session.paused || session.reason;
    session.paused=false;session.reason='';
    // Also send after a SPA route reset, before results can reach the content script.
    if(changed || audioChanged || session.lastPublishedRevision!==session.revision){session.lastPublishedRevision=session.revision;await publishMediaState(session);}
    return {ok:true,sessionId:session.id,revision:session.revision,context,coverage:session.coverage};
  } catch(error) {
    const reason=error.message;
    if(['private','unsupported'].includes(reason)){await stopMedia(reason);return {ok:false,reason};}
    if(session!==mediaSession)return {ok:false,reason:'ended'};
    await pauseMedia(session,['hidden','paused','no-video'].includes(reason)?reason:'no-video');
    return {ok:false,reason:session.reason};
  }
}

async function startMedia(tabId,{autoBrowse=false}={}) {
  if(mediaStartPromise)return {ok:false,error:'busy'};
  mediaStartPromise=(async()=>{
    if(mediaStopPromise)await mediaStopPromise;
    if(mediaSession)await stopMedia('ended');
    if(!Number.isInteger(tabId))throw new Error('unsupported');
    const tab=await chrome.tabs.get(tabId);
    const url=mediaPageUrl(tab.url);
    const win=await chrome.windows.get(tab.windowId);
    if(!tab.active || !win.focused)throw new Error('inactive');
    if(!chrome.tabCapture?.getMediaStreamId || !chrome.offscreen?.createDocument)throw new Error('unavailable');
    // Confirm the local media endpoint exists before capturing anything.
    try {await mediaApi('/api/media-status');}catch {throw new Error('offline');}
    const session={id:crypto.randomUUID(),tabId,url,mediaId:'',expiresAt:Date.now()+MEDIA_LIMIT_MS,revision:0,paused:true,reason:'starting',pending:new Set(),inFlight:new Map(),coverage:newMediaCoverage(),ai:null,autoBrowse:false};
    mediaSession=session;
    session.expiryTimer=setTimeout(()=>{if(mediaSession===session)stopMedia('timeout');},MEDIA_LIMIT_MS);
    try {
      await ensureOffscreen();
      if(mediaSession!==session)throw new Error('ended');
      const streamId=await chrome.tabCapture.getMediaStreamId({targetTabId:tabId});
      if(mediaSession!==session)throw new Error('ended');
      await publishMediaState(session);
      const response=await chrome.runtime.sendMessage({target:'safenet-offscreen',type:'SAFENET_OFFSCREEN_START',sessionId:session.id,streamId,expiresAt:session.expiresAt});
      if(mediaSession!==session)throw new Error('ended');
      if(!response?.ok)throw new Error('capture-failed');
      session.audioAvailable=response.audioAvailable!==false;
      if(autoBrowse){
        const currentTab=await chrome.tabs.get(tabId);
        const browse=mediaBrowseUrl(currentTab.url);
        await chrome.storage.local.set({autoEnabled:true});
        if(mediaSession!==session)throw new Error('ended');
        // This flag is scoped to the capture tab and never persists after Stop.
        session.autoBrowse=browse;
        await publishMediaState(session);
      }
      const initialContext=await readMediaContext(session);
      if(mediaSession!==session)throw new Error((lastMediaState.sessionId===session.id&&lastMediaState.reason)||initialContext.reason||'ended');
      return {ok:true,state:mediaState(session)};
    } catch(error) {if(mediaSession===session)await stopMedia(error.message==='ended'?'ended':'capture-failed');throw error;}
  })().catch(error=>({ok:false,error:['unsupported','private','inactive','unavailable','offline','ended','timeout','capture-ended'].includes(error.message)?error.message:'capture-failed'})).finally(()=>{mediaStartPromise=null;});
  return mediaStartPromise;
}

async function stopMediaBrowse(sessionId) {
  const session=mediaSession;
  if(!session || session.id!==sessionId)return {ok:false,error:'stale'};
  session.autoBrowse=false;
  await publishMediaState(session);
  return {ok:true,state:mediaState(session)};
}

function normalizeMediaSample(message) {
  const input=message.sample;
  if(!input || !['frame','audio'].includes(input.kind))throw new Error('invalid');
  const allowedMime=input.kind==='frame'?/^image\/(jpeg|png)$/:/^audio\/(webm|ogg)(;codecs=opus)?$/;
  if(typeof input.mimeType!=='string'||!allowedMime.test(input.mimeType))throw new Error('invalid');
  if(typeof input.data!=='string'||input.data.length<4||input.data.length>6*1024*1024||!/^([A-Za-z0-9+/]+={0,2})$/.test(input.data))throw new Error('invalid');
  if(!Number.isFinite(input.startMs)||!Number.isFinite(input.endMs)||input.startMs<0||input.endMs<input.startMs||input.endMs-input.startMs>20000)throw new Error('invalid');
  return {kind:input.kind,data:input.data,mimeType:input.mimeType,startMs:Math.round(input.startMs),endMs:Math.round(input.endMs)};
}

async function acceptMediaSample(message) {
  const session=mediaSession;
  if(!session || message.sessionId!==session.id || message.revision!==session.revision || message.mediaId!==session.mediaId)return {ok:false,error:'stale'};
  let sample;try{sample=normalizeMediaSample(message);}catch{return {ok:false,error:'invalid'};}
  if(session.inFlight.has(sample.kind))return {ok:false,error:'busy'};
  const lease=await readMediaContext(session);
  if(!lease.ok || session!==mediaSession || lease.revision!==message.revision || lease.context.url!==message.url || lease.context.mediaId!==message.mediaId)return {ok:false,error:'stale'};
  if(sample.kind==='audio'&&(lease.context.paused||lease.context.muted||lease.context.playbackRate!==1))return {ok:false,error:'paused'};
  if(session.inFlight.has(sample.kind))return {ok:false,error:'busy'};
  const controller=new AbortController();session.pending.add(controller);
  session.inFlight.set(sample.kind,controller);
  const startedAt=Date.now(),completedCount=session.coverage[sample.kind]?.completedCount||0,targetCount=sample.kind==='frame'?3:1;
  session.coverage[sample.kind]={status:'running',completedCount,targetCount,startMs:sample.startMs,endMs:sample.endMs,startedAt};
  await publishMediaState(session);
  try {
    const result=await mediaApi('/api/media-scan',{signal:controller.signal,body:{...sample,url:lease.context.url,platform:'instagram',locale:lease.context.locale,source:'extension',capturedAt:new Date().toISOString(),clientVersion:CLIENT_VERSION}});
    const current=await readMediaContext(session);
    if(!current.ok || session!==mediaSession || current.revision!==message.revision || current.context.url!==message.url || current.context.mediaId!==message.mediaId || controller.signal.aborted)return {ok:false,error:'stale'};
    if(!result?.analysis || !Number.isFinite(result.analysis.score) || !Array.isArray(result.analysis.signals) || typeof result.text!=='string' || !Array.isArray(result.evidence))throw new Error('processing-error');
    session.coverage[sample.kind]={status:'complete',completedCount:completedCount+1,targetCount,startMs:sample.startMs,endMs:sample.endMs,completedAt:Date.now(),visualObjects:result.coverage?.visualObjects===true};
    if(result.ai && typeof result.ai==='object')session.ai={status:String(result.ai.status||'unavailable').slice(0,40),model:String(result.ai.model||'').slice(0,100),mode:result.ai.mode==='local'?'local':'unknown',elapsedMs:Number.isFinite(result.ai.elapsedMs)?Math.max(0,result.ai.elapsedMs):null,kind:sample.kind};
    // Publish STATE first even if content.js was reloaded during a scan.
    await publishMediaState(session);
    if(session!==mediaSession || session.revision!==message.revision || session.mediaId!==message.mediaId || controller.signal.aborted)return {ok:false,error:'stale'};
    await chrome.tabs.sendMessage(session.tabId,{type:'SAFENET_MEDIA_RESULT',sessionId:session.id,url:message.url,mediaId:message.mediaId,revision:message.revision,sampleKind:sample.kind,result:{...result,ok:true,stored:result.stored===true}}).catch(()=>{});
    return {ok:true,elapsedMs:Date.now()-startedAt};
  } catch(error) {
    if(controller.signal.aborted || session!==mediaSession || session.revision!==message.revision)return {ok:false,error:'stale'};
    session.coverage[sample.kind]={status:'error',completedCount,targetCount,reason:error.message==='busy'?'busy':'processing-error',startMs:sample.startMs,endMs:sample.endMs};
    await publishMediaState(session);
    return {ok:false,error:error.message==='busy'?'busy':'processing-error'};
  } finally {
    session.pending.delete(controller);
    // An old job finishing after a route switch cannot clear the next post's job.
    if(session.inFlight.get(sample.kind)===controller){session.inFlight.delete(sample.kind);await publishMediaState(session);}
  }
}

function isMediaPopup(sender) {return sender.id===chrome.runtime.id&&!sender.tab&&sender.url===chrome.runtime.getURL('popup.html');}
function isMediaOffscreen(sender) {return sender.id===chrome.runtime.id&&!sender.tab&&sender.url===chrome.runtime.getURL('offscreen.html');}

chrome.runtime.onMessage.addListener((message,sender,sendResponse)=>{
  if(!message || message.target==='safenet-offscreen' || sender.id!==chrome.runtime.id)return false;
  const popup=isMediaPopup(sender),offscreen=isMediaOffscreen(sender);
  const sessionSender=Boolean(mediaSession&&sender.tab?.id===mediaSession.tabId);
  let operation;
  if(message.type==='SAFENET_MEDIA_START'&&popup)operation=startMedia(message.tabId,{autoBrowse:message.autoBrowse===true});
  else if(message.type==='SAFENET_MEDIA_STOP'&&(popup||sessionSender))operation=stopMedia('ended');
  else if(message.type==='SAFENET_MEDIA_BROWSE_STOP'&&(popup||(sessionSender&&trustedSender(sender))))operation=stopMediaBrowse(message.sessionId);
  else if(message.type==='SAFENET_MEDIA_STATUS'&&popup)operation=Promise.resolve({ok:true,state:mediaState()});
  else if(message.type==='SAFENET_MEDIA_STATUS'&&trustedSender(sender))operation=Promise.resolve({ok:true,state:sessionSender?mediaState():{active:false,paused:false,reason:''}});
  else if(message.type==='SAFENET_OFFSCREEN_CONTEXT'&&offscreen)operation=message.sessionId===mediaSession?.id?readMediaContext(mediaSession):Promise.resolve({ok:false,reason:'ended'});
  else if(message.type==='SAFENET_OFFSCREEN_SAMPLE'&&offscreen)operation=acceptMediaSample(message);
  else if(message.type==='SAFENET_OFFSCREEN_ENDED'&&offscreen&&message.sessionId===mediaSession?.id)operation=stopMedia(message.reason==='timeout'?'timeout':'capture-ended');
  else return false;
  operation.then(sendResponse).catch(()=>sendResponse({ok:false,error:'offline'}));
  return true;
});

chrome.tabs?.onRemoved?.addListener(tabId=>{if(mediaSession?.tabId===tabId)stopMedia('ended');});
chrome.tabs?.onUpdated?.addListener((tabId,changeInfo)=>{
  const session=mediaSession;if(!session||session.tabId!==tabId)return;
  if(changeInfo.url) {
    try {mediaPageUrl(changeInfo.url);invalidateMedia(session);pauseMedia(session,'no-video');}
    catch(error) {stopMedia(error.message==='private'?'private':'unsupported');}
  }
  if(changeInfo.status==='loading')pauseMedia(session,'no-video');
});
chrome.tabs?.onActivated?.addListener(({tabId})=>{if(mediaSession&&mediaSession.tabId!==tabId)pauseMedia(mediaSession,'inactive');});
chrome.windows?.onFocusChanged?.addListener(()=>{if(mediaSession)pauseMedia(mediaSession,'inactive');});
chrome.storage.onChanged.addListener((changes,area)=>{if(area==='local'&&changes.autoEnabled?.newValue===false&&mediaSession)pauseMedia(mediaSession,'paused');});

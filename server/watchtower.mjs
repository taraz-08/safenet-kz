import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import https from 'node:https';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { parse } from 'parse5';
import { analyzeContent } from './engine.mjs';
import { ANALYSIS_VERSION, sha256 } from './monitoring.mjs';
import { createPinnedLookup, isPublicAddress } from './link-inspector.mjs';

export const WATCHTOWER_LIMITS = Object.freeze({ sources:20, postsPerSource:20, maxBytes:1024*1024, timeoutMs:10000, minIntervalMinutes:5, maxIntervalMinutes:1440, cases:5000, fingerprintsPerSource:1000, keywords:20 });
const cleanText=value=>String(value??'').normalize('NFKC').replace(/\s+/gu,' ').trim();
const keyText=value=>cleanText(value).toLocaleLowerCase('ru');
const error=(code,message,status=400)=>Object.assign(new Error(message),{code,status});
const atMs=at=>typeof at==='number'?at:Date.parse(at);
const iso=value=>new Date(value).toISOString();
const emptyStats=()=>({runs:0,checkedPosts:0,newPosts:0,flaggedPosts:0,savedCases:0,reportCases:0,reviewCases:0,duplicatePosts:0,failedSources:0,lastRunAt:null});

export function telegramHandle(value) {
  if(typeof value!=='string')throw error('INVALID_SOURCE','Укажите публичное имя Telegram-канала.');
  const handle=value.trim().replace(/^@/,'');
  if(!/^[a-z][a-z0-9_]{4,31}$/i.test(handle))throw error('INVALID_SOURCE','Имя канала: 5–32 латинских символа, цифры или подчёркивание, начинается с буквы. Ссылки и закрытые приглашения не поддерживаются.');
  return handle.toLowerCase();
}

function abortable(promise,signal) {
  if(signal.aborted)return Promise.reject(signal.reason);
  return new Promise((resolve,reject)=>{
    const abort=()=>{cleanup();reject(signal.reason);};
    const cleanup=()=>signal.removeEventListener('abort',abort);
    signal.addEventListener('abort',abort,{once:true});
    Promise.resolve(promise).then(value=>{cleanup();resolve(value);},reason=>{cleanup();reject(reason);});
  });
}

function previewTransport({url,lookup,signal,maxBytes}) {
  return new Promise((resolve,reject)=>{
    let settled=false;
    const finish=(reason,value)=>{if(settled)return;settled=true;reason?reject(reason):resolve(value);};
    const request=https.request(url,{method:'GET',lookup,servername:'t.me',signal,agent:false,rejectUnauthorized:true,maxHeaderSize:16384,
      headers:{'User-Agent':'SafeNetKZ-PublicPreview/3.1 (public channel safety monitoring)','Accept':'text/html','Accept-Encoding':'identity'}},response=>{
      const chunks=[];let bytes=0;
      if(response.statusCode>=300&&response.statusCode<400){finish(null,{status:response.statusCode,headers:response.headers,body:''});response.destroy();return;}
      response.on('data',chunk=>{
        bytes+=chunk.length;
        if(bytes>maxBytes){finish(error('RESPONSE_TOO_LARGE','Публичная страница превышает лимит 1 МиБ.'));response.destroy();return;}
        chunks.push(chunk);
      });
      response.once('end',()=>finish(null,{status:response.statusCode,headers:response.headers,body:Buffer.concat(chunks).toString('utf8')}));
      response.once('error',()=>finish(error('NETWORK_ERROR','Telegram прервал соединение.')));
      response.once('aborted',()=>finish(error('NETWORK_ERROR','Telegram прервал соединение.')));
    });
    request.once('error',reason=>finish(signal.aborted?signal.reason:error('NETWORK_ERROR','Не удалось загрузить публичный предпросмотр Telegram.')));
    request.end();
  });
}

/** Fixed public Telegram host, DNS-pinned TLS and no cookies, JS, login or arbitrary redirect. */
export async function fetchTelegramPreview(value,dependencies={}) {
  const handle=telegramHandle(value),controller=new AbortController();
  const signal=dependencies.signal?AbortSignal.any([dependencies.signal,controller.signal]):controller.signal;
  const timer=setTimeout(()=>controller.abort(error('TIMEOUT','Telegram не ответил за 10 секунд.')),Math.min(WATCHTOWER_LIMITS.timeoutMs,dependencies.timeoutMs??WATCHTOWER_LIMITS.timeoutMs));
  const resolve=dependencies.resolve||dnsLookup,transport=dependencies.transport||previewTransport;
  let url=new URL(`https://t.me/s/${handle}`);
  try {
    for(let hop=0;hop<2;hop++) {
      const addresses=await abortable(resolve('t.me',{all:true,verbatim:true}),signal);
      if(!Array.isArray(addresses)||!addresses.length||addresses.some(answer=>!isPublicAddress(answer.address)||Number(answer.family)!==isIP(answer.address)))throw error('BLOCKED_ADDRESS','Публичный адрес Telegram не прошёл проверку безопасности.');
      const {address,family}=addresses[0];
      const response=await abortable(transport({url,lookup:createPinnedLookup(address,Number(family)),signal,maxBytes:WATCHTOWER_LIMITS.maxBytes}),signal);
      const status=Number(response.status??response.statusCode),headers=response.headers||{};
      const body=Buffer.isBuffer(response.body)?response.body.toString('utf8'):String(response.body??'');
      if(Buffer.byteLength(body)>WATCHTOWER_LIMITS.maxBytes)throw error('RESPONSE_TOO_LARGE','Публичная страница превышает лимит 1 МиБ.');
      if(status>=300&&status<400) {
        let next;try{next=new URL(headers.location,url);}catch{throw error('PREVIEW_UNAVAILABLE','Telegram не предоставил публичный предпросмотр этого канала.');}
        if(hop||next.origin!=='https://t.me'||next.username||next.password||next.search||next.hash||!new RegExp(`^/s/${handle}/?$`,'i').test(next.pathname))throw error('PREVIEW_UNAVAILABLE','Telegram перенаправил запрос вне публичного предпросмотра канала.');
        url=next;continue;
      }
      if(status===429)throw error('RATE_LIMITED','Telegram ограничил запросы. Следующая проверка будет отложена.');
      if(status!==200)throw error('PREVIEW_UNAVAILABLE',`Публичный предпросмотр недоступен (HTTP ${Number.isInteger(status)?status:'?'}).`);
      if(!/^text\/html\b/i.test(String(headers['content-type']||'')))throw error('INVALID_RESPONSE','Telegram вернул страницу в неподдерживаемом формате.');
      if(headers['content-encoding']&&!/^identity$/i.test(headers['content-encoding']))throw error('INVALID_RESPONSE','Неожиданное сжатие публичной страницы.');
      return {html:body,url:url.href};
    }
    throw error('PREVIEW_UNAVAILABLE','Публичный предпросмотр недоступен.');
  } catch(reason) {
    if(signal.aborted)throw signal.reason;
    if(reason.code&&['BLOCKED_ADDRESS','RESPONSE_TOO_LARGE','PREVIEW_UNAVAILABLE','RATE_LIMITED','INVALID_RESPONSE','NETWORK_ERROR'].includes(reason.code))throw reason;
    throw error('NETWORK_ERROR','Не удалось получить публичный предпросмотр Telegram.');
  } finally {clearTimeout(timer);}
}

const attr=(node,name)=>node.attrs?.find(item=>item.name===name)?.value||'';
const hasClass=(node,value)=>attr(node,'class').split(/\s+/).includes(value);
function walk(node,visit){visit(node);for(const child of node.childNodes||[])walk(child,visit);}
function first(node,predicate){let result=null;walk(node,item=>{if(!result&&predicate(item))result=item;});return result;}
function textContent(node) {
  if(node.nodeName==='#text')return node.value;
  if(['script','style','iframe','noscript'].includes(node.tagName))return '';
  if(node.tagName==='br')return '\n';
  const text=(node.childNodes||[]).map(textContent).join('');
  return ['div','p','li'].includes(node.tagName)?`${text}\n`:text;
}

/** Parse only Telegram's public message widgets; never treat login/channel descriptions as posts. */
export function parseTelegramPreview(html,value) {
  const handle=telegramHandle(value);
  if(typeof html!=='string'||Buffer.byteLength(html)>WATCHTOWER_LIMITS.maxBytes)throw error('RESPONSE_TOO_LARGE','Публичная страница превышает лимит 1 МиБ.');
  const document=parse(html),posts=new Map();let widgetCount=0;
  const titleNode=first(document,node=>hasClass(node,'tgme_channel_info_header_title'));
  const title=cleanText(titleNode?textContent(titleNode):'').slice(0,120)||`@${handle}`;
  walk(document,node=>{
    if(!hasClass(node,'tgme_widget_message'))return;
    const match=new RegExp(`^${handle}/([1-9]\\d{0,19})$`,'i').exec(attr(node,'data-post'));
    if(!match)return;
    widgetCount++;
    const textNode=first(node,item=>hasClass(item,'tgme_widget_message_text'));
    const text=(textNode?textContent(textNode):'').replace(/\u00a0/g,' ').replace(/[ \t]+\n/g,'\n').replace(/\n{3,}/g,'\n\n').trim().slice(0,30000);
    const links=[];
    if(textNode)walk(textNode,item=>{
      if(item.tagName!=='a')return;
      try{const link=new URL(attr(item,'href'));if(['http:','https:'].includes(link.protocol)&&!link.username&&!link.password&&link.href.length<=2048)links.push(link.href);}catch{/* Ignore Telegram internal commands and malformed links. */}
    });
    const time=first(node,item=>item.tagName==='time'&&attr(item,'datetime'));
    const date=time?Date.parse(attr(time,'datetime')):NaN;
    const url=`https://t.me/${handle}/${match[1]}`;
    posts.set(url,{id:match[1],url,handle,text,links:[...new Set(links)].slice(0,50),publishedAt:Number.isFinite(date)?iso(date):null,mediaOnly:!text});
  });
  const available=Boolean(widgetCount||first(document,node=>hasClass(node,'tgme_channel_history')));
  const sorted=[...posts.values()].sort((a,b)=>BigInt(a.id)<BigInt(b.id)?1:-1).slice(0,WATCHTOWER_LIMITS.postsPerSource);
  return {title,posts:sorted,available,status:sorted.length?'ok':available?'empty_preview':'unavailable',limitations:{mediaNotAnalyzed:true,completeHistory:false}};
}

function validConfig(input,current) {
  if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(key=>!['enabled','intervalMinutes','minScore','keywords'].includes(key)))throw error('INVALID_CONFIG','Неизвестные настройки мониторинга.');
  const next={enabled:current.enabled,intervalMinutes:current.intervalMinutes,minScore:current.minScore,keywords:[...current.keywords]};
  if('enabled'in input){if(typeof input.enabled!=='boolean')throw error('INVALID_CONFIG','enabled должен быть true или false.');next.enabled=input.enabled;}
  if('intervalMinutes'in input){if(!Number.isInteger(input.intervalMinutes)||input.intervalMinutes<5||input.intervalMinutes>1440)throw error('INVALID_CONFIG','Интервал: от 5 до 1440 минут.');next.intervalMinutes=input.intervalMinutes;}
  if('minScore'in input){if(!Number.isInteger(input.minScore)||input.minScore<0||input.minScore>100)throw error('INVALID_CONFIG','Порог риска: от 0 до 100.');next.minScore=input.minScore;}
  if('keywords'in input){
    if(!Array.isArray(input.keywords)||input.keywords.length>20||input.keywords.some(item=>typeof item!=='string'||cleanText(item).length<2||cleanText(item).length>80))throw error('INVALID_CONFIG','Не более 20 ключевых фраз длиной 2–80 символов.');
    next.keywords=[...new Map(input.keywords.map(item=>[keyText(item),cleanText(item)])).values()];
  }
  return next;
}

function sourceRecord(input,now) {
  if(!input||input.platform!=='telegram'||Object.keys(input).some(key=>!['platform','handle','title','kind','regionHint'].includes(key)))throw error('INVALID_SOURCE','Автосбор поддерживает публичные Telegram-каналы.');
  const handle=telegramHandle(input.handle);
  return {id:randomUUID(),platform:'telegram',handle,title:typeof input.title==='string'?cleanText(input.title).slice(0,120):`@${handle}`,kind:['official_reports','education','news','other'].includes(input.kind)?input.kind:'other',regionHint:'KZ',locationVerified:false,
    enabled:true,status:'never_checked',addedAt:now,lastCheckedAt:null,lastSuccessAt:null,nextRunAt:now,lastError:null,checkedPosts:0,newPosts:0,flaggedPosts:0,savedCases:0,reportCases:0,reviewCases:0,duplicatePosts:0,consecutiveErrors:0,fingerprints:[]};
}

/** Local scheduler. Run only while the SafeNet server is running. */
export function createWatchtower({storePath,getCases,persistCases,fetchPreview=fetchTelegramPreview,now=()=>new Date().toISOString(),analyze=analyzeContent,defaultSources=[]}) {
  if(typeof getCases!=='function'||typeof persistCases!=='function')throw new Error('Watchtower requires case storage callbacks.');
  const nowIso=()=>iso(atMs(now()));
  let state={schemaVersion:1,enabled:false,intervalMinutes:15,minScore:60,keywords:[],sources:[],stats:emptyStats(),updatedAt:null};
  let running=false,controller=null,timer=null,closed=false;
  if(existsSync(storePath)) {
    const saved=JSON.parse(readFileSync(storePath,'utf8'));
    const config=validConfig({enabled:saved.enabled,intervalMinutes:saved.intervalMinutes,minScore:saved.minScore,keywords:saved.keywords},state);
    if(!Array.isArray(saved.sources)||saved.sources.length>20)throw new Error('Invalid watchtower source store.');
    const seen=new Set();
    const sources=saved.sources.map(item=>{
      const handle=telegramHandle(item.handle);if(seen.has(handle))throw new Error('Duplicate watchtower source.');seen.add(handle);
      const baseline=sourceRecord({platform:item.platform,handle,title:item.title,kind:item.kind},nowIso());
      if(typeof item.enabled!=='boolean'||typeof item.id!=='string')throw new Error('Invalid watchtower source.');
      for(const field of ['reportCases','reviewCases'])if(item[field]===undefined)item[field]=0;
      for(const field of ['checkedPosts','newPosts','flaggedPosts','savedCases','reportCases','reviewCases','duplicatePosts','consecutiveErrors'])if(!Number.isSafeInteger(item[field])||item[field]<0)throw new Error('Invalid watchtower statistics.');
      return {...baseline,...item,handle,fingerprints:Array.isArray(item.fingerprints)?item.fingerprints.filter(value=>/^[a-f0-9]{64}$/.test(value)).slice(-1000):[]};
    });
    const stats={...emptyStats(),...saved.stats};
    for(const field of ['runs','checkedPosts','newPosts','flaggedPosts','savedCases','reportCases','reviewCases','duplicatePosts','failedSources'])if(!Number.isSafeInteger(stats[field])||stats[field]<0)throw new Error('Invalid watchtower statistics.');
    state={...state,...config,sources,stats,updatedAt:saved.updatedAt||null};
  }
  const persist=next=>{
    mkdirSync(dirname(storePath),{recursive:true});writeFileSync(`${storePath}.tmp`,JSON.stringify(next,null,2),'utf8');renameSync(`${storePath}.tmp`,storePath);state=next;
  };
  const coverage=()=>({region:'KZ',locationVerified:false,scope:'configured_public_telegram_previews',wholePlatform:false,
    platforms:[{platform:'telegram',mode:'public_preview',connected:state.sources.some(item=>item.lastSuccessAt),configuredSources:state.sources.length},{platform:'instagram',mode:'browser_extension',connected:false},{platform:'tiktok',mode:'browser_extension',connected:false}],
    limitations:{ru:['Только последние публичные сообщения выбранных Telegram-каналов. Это не весь Казахстан и не полная история Telegram.','Instagram и TikTok поступают из расширения при просмотре; сервер не обходит эти платформы.','Медиа без подписи не распознаются этим сборщиком. География автора не установлена; KZ — тематический профиль.','Новости и предупреждения могут содержать те же слова. Совпадение требует проверки, а не обвинения автора.','Проверки идут только пока запущен сервер SafeNet.'],kk:['Тек таңдалған Telegram арналарының соңғы жария хабарламалары. Бұл бүкіл Қазақстан да, Telegram толық тарихы да емес.','Instagram мен TikTok деректері қарау кезінде кеңейтімнен келеді; сервер бұл платформаларды араламайды.','Бұл жинағыш жазбасыз медианы танымайды. Автор географиясы анықталмаған; KZ — тақырыптық профиль.','Жаңалық пен ескертуде де осы сөздер кездеседі. Сәйкестікті адам тексеруі керек, бұл авторды айыптау емес.','Тексеру тек SafeNet сервері қосулы кезде жүреді.']}});
  const snapshot=()=>{
    const next=state.enabled?state.sources.filter(item=>item.enabled).map(item=>item.nextRunAt).filter(Boolean).sort()[0]||null:null;
    return structuredClone({...state,sources:state.sources.map(({fingerprints,...source})=>({...source,status:!state.enabled||!source.enabled?'paused':source.status})),running,nextRunAt:next,lastRunAt:state.stats.lastRunAt,limits:WATCHTOWER_LIMITS,coverage:coverage()});
  };
  const findSource=id=>{const source=state.sources.find(item=>item.id===id);if(!source)throw error('SOURCE_NOT_FOUND','Источник не найден.',404);return source;};
  const filtersChanged=config=>config.minScore!==state.minScore||JSON.stringify(config.keywords.map(keyText))!==JSON.stringify(state.keywords.map(keyText));
  const rescheduled=(source,interval)=>{
    const previous=source.lastSuccessAt&&source.lastCheckedAt?[source.lastSuccessAt,source.lastCheckedAt].sort().at(-1):source.lastCheckedAt||source.lastSuccessAt;
    if(!previous)return source.nextRunAt||nowIso();
    const delay=source.consecutiveErrors?Math.min(1440,Math.max(interval,5)*2**Math.min(source.consecutiveErrors,8)):Math.max(interval,5);
    return iso(atMs(previous)+delay*60000);
  };
  const update=input=>{
    const config=validConfig(input,state);
    const changed=filtersChanged(config);
    if(!config.enabled||changed)controller?.abort(error('CANCELLED',changed?'Фильтры мониторинга изменены.':'Мониторинг выключен.'));
    const intervalChanged=config.intervalMinutes!==state.intervalMinutes;
    const sources=changed||intervalChanged?state.sources.map(source=>({...source,...(changed?{fingerprints:[]}:{}),...(intervalChanged?{nextRunAt:rescheduled(source,config.intervalMinutes)}:{})})):state.sources;
    persist({...state,...config,sources,updatedAt:nowIso()});return snapshot();
  };
  const addSource=input=>{
    const source=sourceRecord(input,nowIso());
    if(state.sources.some(item=>item.handle===source.handle))throw error('DUPLICATE_SOURCE','Этот канал уже добавлен.',409);
    if(state.sources.length>=20)throw error('SOURCE_LIMIT','Можно добавить не более 20 каналов.',409);
    persist({...state,sources:[...state.sources,source],updatedAt:nowIso()});return snapshot();
  };
  const isActive=id=>!closed&&state.enabled&&state.sources.some(source=>source.id===id&&source.enabled)&&!controller?.signal.aborted;
  async function collect(sourceId,signal) {
    let source=findSource(sourceId);const checkedAt=nowIso();
    try {
      const response=await abortable(fetchPreview(source.handle,{signal}),signal);
      if(!isActive(sourceId))return;
      const result=parseTelegramPreview(typeof response==='string'?response:response.html,source.handle);
      if(!result.available)throw error('PREVIEW_UNAVAILABLE','У канала нет доступных публичных сообщений. Он может быть закрыт или не поддерживать веб-предпросмотр.');
      source=findSource(sourceId);
      const fingerprints=new Set(source.fingerprints),counts={checkedPosts:0,newPosts:0,flaggedPosts:0,savedCases:0,reportCases:0,reviewCases:0,duplicatePosts:0};
      for(const post of result.posts) {
        if(!isActive(sourceId))return;
        counts.checkedPosts++;
        const fingerprint=sha256(`${post.url}\n${cleanText(post.text)}\n${post.links.join('\n')}`);
        if(fingerprints.has(fingerprint)){counts.duplicatePosts++;continue;}
        counts.newPosts++;
        const extraLinks=post.links.filter(link=>!post.text.includes(link));
        const text=[post.text,...(extraLinks.length?['[Ссылки публикации / Жарияланым сілтемелері]',...extraLinks]:[])].join('\n').slice(0,30000);
        if(!text){fingerprints.add(fingerprint);continue;}
        const analysis=await analyze({text,url:post.url,platform:'telegram'});
        if(!isActive(sourceId))return;
        const matchedKeywords=state.keywords.filter(keyword=>keyText(text).includes(keyText(keyword)));
        const flagged=analysis.score>=state.minScore||matchedKeywords.length>0;
        if(flagged) {
          counts.flaggedPosts++;
          const records=getCases(),existing=records.find(record=>record.source==='public_telegram'&&record.provenance?.fingerprint===fingerprint);
          if(existing){counts.duplicatePosts++;fingerprints.add(fingerprint);continue;}
          if(records.length>=WATCHTOWER_LIMITS.cases)continue; // Retry after space becomes available; never silently lose a finding.
          const warning=source.kind==='official_reports'||analysis.riskContext==='warning_or_news'||(!analysis.riskContext&&analysis.signals?.some(item=>item.id==='prevention_context'));
          const riskContext=warning?'warning_or_news':analysis.riskContext==='mixed_requires_review'?'mixed_requires_review':'requires_review';
          const observedAt=nowIso();
          const record={id:randomUUID(),text,originalText:post.text,url:post.url,platform:'telegram',author:`@${source.handle}`,createdAt:observedAt,publishedAt:post.publishedAt,capturedAt:observedAt,lastSeen:observedAt,seenCount:1,status:'new',demo:false,source:'public_telegram',analysis,analysisVersion:ANALYSIS_VERSION,analyzedAt:observedAt,
            riskContext,links:post.links,
            provenance:{source:'public_telegram',method:'public_preview',scope:'publicly_available_preview',sourceId,sourceHandle:source.handle,sourceTitle:source.title,sourceRole:source.kind,canonicalUrl:post.url,fingerprint,observedAt,publishedAt:post.publishedAt,publicVisibilityVerified:true,locationVerified:false,regionHint:'KZ',regionBasis:'configured_topic_profile',matchedKeywords,minScore:state.minScore,mediaAnalyzed:false,coverage:'caption_and_anchor_links',context:riskContext,disclaimer:'Индикаторы риска требуют проверки контекста; публикация может предупреждать о мошенничестве.'}};
          persistCases([record,...records]);counts.savedCases++;counts[warning?'reportCases':'reviewCases']++;
        }
        fingerprints.add(fingerprint);
      }
      if(!isActive(sourceId))return;
      const successAt=nowIso(),stats={...state.stats};for(const [name,value]of Object.entries(counts))stats[name]+=value;
      persist({...state,stats,sources:state.sources.map(item=>item.id!==sourceId?item:{...item,...Object.fromEntries(Object.entries(counts).map(([key,value])=>[key,item[key]+value])),title:result.title.startsWith('@')?item.title:result.title,status:result.status,lastCheckedAt:checkedAt,lastSuccessAt:successAt,nextRunAt:iso(atMs(successAt)+state.intervalMinutes*60000),lastError:null,consecutiveErrors:0,fingerprints:[...fingerprints].slice(-1000)}),updatedAt:successAt});
    } catch(reason) {
      if(!isActive(sourceId)||signal.aborted)return;
      const failedAt=nowIso(),item=findSource(sourceId),attempts=item.consecutiveErrors+1;
      const delay=Math.min(24*60,Math.max(state.intervalMinutes,5)*2**Math.min(attempts,8));
      const code=['PREVIEW_UNAVAILABLE','RATE_LIMITED','TIMEOUT','BLOCKED_ADDRESS','RESPONSE_TOO_LARGE','INVALID_RESPONSE','NETWORK_ERROR'].includes(reason.code)?reason.code:'COLLECTION_ERROR';
      const message=code==='COLLECTION_ERROR'?'Не удалось обработать сообщения источника. Следующая попытка отложена.':reason.message;
      persist({...state,stats:{...state.stats,failedSources:state.stats.failedSources+1},sources:state.sources.map(source=>source.id!==sourceId?source:{...source,status:code==='PREVIEW_UNAVAILABLE'?'unavailable':'error',lastCheckedAt:checkedAt,lastError:{code,message,at:failedAt},nextRunAt:iso(atMs(failedAt)+delay*60000),consecutiveErrors:attempts}),updatedAt:failedAt});
    }
  }
  async function run({sourceId}={}) {
    if(closed)throw error('CLOSED','Мониторинг остановлен.',409);
    if(!state.enabled)throw error('DISABLED','Сначала включите мониторинг.',409);
    if(running)throw error('BUSY','Проверка уже выполняется.',409);
    if(sourceId)findSource(sourceId);
    const requestedAt=nowIso(),selected=state.sources.filter(source=>source.enabled&&(!sourceId||source.id===sourceId));
    const due=selected.filter(source=>!source.nextRunAt||atMs(source.nextRunAt)<=atMs(now()));
    if(!due.length)return {...snapshot(),runOutcome:{status:selected.length?'cooldown':'no_sources',requestedAt,dueSources:0,checkedSources:0}};
    running=true;controller=new AbortController();
    const startedAt=nowIso();persist({...state,stats:{...state.stats,runs:state.stats.runs+1,lastRunAt:startedAt},updatedAt:startedAt});
    let checkedSources=0,cancelled=false;
    try{for(const source of due){if(!isActive(source.id))continue;await collect(source.id,controller.signal);const current=state.sources.find(item=>item.id===source.id);if(current?.lastCheckedAt&&atMs(current.lastCheckedAt)>=atMs(startedAt))checkedSources++;}}finally{cancelled=controller.signal.aborted;running=false;controller=null;}
    return {...snapshot(),runOutcome:{status:cancelled?'cancelled':'completed',requestedAt,dueSources:due.length,checkedSources}};
  }
  return {
    snapshot,update,addSource,run,
    updateSource(id,input){findSource(id);if(!input||typeof input.enabled!=='boolean'||Object.keys(input).some(key=>key!=='enabled'))throw error('INVALID_SOURCE','Укажите только enabled: true или false.');persist({...state,sources:state.sources.map(source=>source.id===id?{...source,enabled:input.enabled}:source),updatedAt:nowIso()});return snapshot();},
    removeSource(id){findSource(id);persist({...state,sources:state.sources.filter(source=>source.id!==id),updatedAt:nowIso()});return snapshot();},
    applyProfile(profile){
      if(profile!=='kazakhstan')throw error('INVALID_PROFILE','Неизвестный профиль мониторинга.');
      const defaults=defaultSources.map(input=>sourceRecord({platform:'telegram',...input},nowIso()));
      const additions=defaults.filter(source=>!state.sources.some(item=>item.handle===source.handle));
      const unique=[...new Map(additions.map(source=>[source.handle,source])).values()];
      if(state.sources.length+unique.length>20)throw error('SOURCE_LIMIT','Для профиля недостаточно места: максимум 20 каналов.',409);
      const config=validConfig({enabled:true,intervalMinutes:10,minScore:30,keywords:['казино','букмекер','фриспин','гарантированный доход','кепілді табыс','ақша сал','легкий заработок','алаяқ','мошеннич','қаржы пирамида','финансовая пирамида']},state);
      const changed=filtersChanged(config);
      if(changed)controller?.abort(error('CANCELLED','Профиль мониторинга изменён.'));
      const existing=state.sources.map(source=>{
        const preset=defaults.find(item=>item.handle===source.handle);
        return {...source,...(preset?{enabled:true,kind:preset.kind,title:preset.title}:{}),...(changed?{fingerprints:[]}:{}),...(config.intervalMinutes!==state.intervalMinutes?{nextRunAt:rescheduled(source,config.intervalMinutes)}:{})};
      });
      persist({...state,...config,sources:[...existing,...unique],updatedAt:nowIso()});return snapshot();
    },
    start(){if(closed||timer)return;timer=setInterval(()=>{if(!running&&state.enabled)void run().catch(()=>{});},30000);timer.unref?.();},
    close(){closed=true;if(timer)clearInterval(timer);timer=null;controller?.abort(error('CANCELLED','Сервер мониторинга остановлен.'));},
  };
}

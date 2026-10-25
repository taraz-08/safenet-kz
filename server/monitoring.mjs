import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export const MONITORING_LIMITS = Object.freeze({ keywords:20, recent:30, cases:5000 });
export const ANALYSIS_VERSION = 'rules-v5';
const emptyStats = () => ({scanned:0,flagged:0,saved:0,lastScanAt:null});
const normalizedText = text => String(text).normalize('NFKC').replace(/\s+/gu,' ').trim();
const normalizeKeyword = text => normalizedText(text).toLocaleLowerCase('ru');

// Public post-shaped permalinks only. Feed, profile, login, DM and comment URLs
// cannot become saved evidence. A permalink does not prove an account is public.
export function canonicalPublicUrl(value, platform) {
  try {
    const url = new URL(value);
    if(url.protocol!=='https:' || url.username || url.password || url.port)return null;
    if(platform==='instagram' && ['instagram.com','www.instagram.com'].includes(url.hostname)) {
      const match=/^\/(?:([a-z\d._]+)\/)?(p|reel|reels)\/([A-Za-z\d_-]+)\/?$/.exec(url.pathname);
      if(!match || /^(direct|messages|accounts|settings|privacy|archive|saved|login|oauth)$/i.test(match[1]||''))return null;
      return `https://www.instagram.com/${match[2]==='p'?'p':'reel'}/${match[3]}/`;
    }
    if(platform==='tiktok' && ['tiktok.com','www.tiktok.com'].includes(url.hostname)) {
      const match=/^\/@([a-z\d._]+)\/video\/(\d+)\/?$/i.exec(url.pathname);
      return match ? `https://www.tiktok.com/@${match[1].toLowerCase()}/video/${match[2]}` : null;
    }
  } catch { /* Invalid input is ineligible for persistence. */ }
  return null;
}

export function canonicalJson(value) {
  if(Array.isArray(value))return `[${value.map(item=>canonicalJson(item)).join(',')}]`;
  if(value && typeof value==='object')return `{${Object.keys(value).filter(key=>value[key]!==undefined).sort().map(key=>`${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

export const sha256 = value => createHash('sha256').update(value,'utf8').digest('hex');

export function evidenceBundle(record, now=new Date().toISOString()) {
  const scopes={extension:'visible_content_in_user_browser',public_telegram:'public_telegram_preview',telegram_discovery:'public_telegram_preview',social_discovery:'public_profile_page_without_login'};
  const payload={case:record,collectionScope:scopes[record.source]??'user_supplied_or_demo',publicVisibilityVerified:false};
  return {
    schemaVersion:'safenet.evidence.v1',exportedAt:now,payload,
    integrity:{algorithm:'sha256',digest:sha256(canonicalJson(payload)),canonicalization:'sorted-json-v1'},
    disclaimer:{
      ru:'SHA-256 позволяет проверить целостность этого JSON, но не подтверждает подлинность публикации, личность автора или факт нарушения. URL и текст получены из браузера либо предоставлены пользователем. Нужна проверка оригинала человеком.',
      kk:'SHA-256 осы JSON тұтастығын тексеруге көмектеседі, бірақ жарияланымның түпнұсқалығын, автордың тұлғасын немесе құқық бұзушылықты растамайды. URL мен мәтін браузерден алынған не пайдаланушы берген. Түпнұсқаны адам тексеруі қажет.',
    },
  };
}

function validatedConfig(input, current) {
  if(!input || typeof input!=='object' || Array.isArray(input))throw new Error('Передайте настройки мониторинга.');
  if(Object.keys(input).some(key=>!['enabled','minScore','keywords'].includes(key)))throw new Error('Неизвестная настройка мониторинга.');
  const next={enabled:current.enabled,minScore:current.minScore,keywords:[...current.keywords]};
  if('enabled' in input){if(typeof input.enabled!=='boolean')throw new Error('enabled должен быть true или false.');next.enabled=input.enabled;}
  if('minScore' in input){if(!Number.isInteger(input.minScore)||input.minScore<0||input.minScore>100)throw new Error('Порог риска: целое число от 0 до 100.');next.minScore=input.minScore;}
  if('keywords' in input){
    if(!Array.isArray(input.keywords)||input.keywords.length>MONITORING_LIMITS.keywords)throw new Error('Не более 20 ключевых слов.');
    if(input.keywords.some(word=>typeof word!=='string'||normalizedText(word).length<2||normalizedText(word).length>80))throw new Error('Ключевое слово должно содержать от 2 до 80 символов.');
    next.keywords=[...new Map(input.keywords.map(word=>[normalizeKeyword(word),normalizedText(word)])).values()];
  }
  return next;
}

const evidenceKey = item => sha256(canonicalJson(item));
function sanitizedEvidence(items) {
  return (Array.isArray(items)?items:[]).slice(0,50).filter(item=>['frame','audio','qr','vision'].includes(item?.kind)&&typeof item.text==='string'&&item.text.trim()).map(item=>({
    kind:item.kind,text:item.text.slice(0,10000),
    ...(item.kind==='vision'?{method:'model_inference',model:String(item.model||'').slice(0,100)}:{}),
    ...(Number.isFinite(item.startMs)&&item.startMs>=0&&item.startMs<=86400000?{startMs:item.startMs}:{}),
    ...(Number.isFinite(item.endMs)&&item.endMs>=0&&item.endMs<=86400000?{endMs:item.endMs}:{}),
  }));
}
function mergeEvidence(previous, incoming, selectedKeys) {
  const selected = new Set(selectedKeys);
  // Keep evidence supporting the selected strongest analysis, then the newest
  // observations. Matching text from different video timestamps is not a duplicate.
  const all=[...previous.filter(item=>selected.has(evidenceKey(item))),...incoming.filter(item=>selected.has(evidenceKey(item))),...incoming,...previous];
  return [...new Map(all.map(item=>[evidenceKey(item),item])).values()].slice(0,50);
}
function strongerAnalysis(previous, incoming) {
  if(incoming.score!==previous?.score)return incoming.score>(previous?.score??-1);
  const oldAi=previous?.ai?.ok?previous.ai:null,newAi=incoming.ai?.ok?incoming.ai:null;
  return !!newAi&&(!oldAi||(newAi.risk?.score??0)>(oldAi.risk?.score??0));
}

export function createMonitoring({storePath,getCases,persistCases,now=()=>new Date().toISOString()}) {
  let state={enabled:false,minScore:60,keywords:[],stats:emptyStats(),recent:[],updatedAt:null};
  if(existsSync(storePath)) {
    const saved=JSON.parse(readFileSync(storePath,'utf8'));
    const config=validatedConfig({enabled:saved.enabled,minScore:saved.minScore,keywords:saved.keywords},state);
    const stats={...emptyStats(),...saved.stats};
    if(!['scanned','flagged','saved'].every(key=>Number.isSafeInteger(stats[key])&&stats[key]>=0))throw new Error('Invalid monitoring statistics.');
    state={...state,...config,stats,recent:Array.isArray(saved.recent)?saved.recent.slice(0,MONITORING_LIMITS.recent):[],updatedAt:typeof saved.updatedAt==='string'?saved.updatedAt:null};
  }
  const persist=next=>{
    mkdirSync(dirname(storePath),{recursive:true});
    writeFileSync(`${storePath}.tmp`,JSON.stringify(next,null,2),'utf8');
    renameSync(`${storePath}.tmp`,storePath);state=next;
  };
  const snapshot=()=>structuredClone({...state,scope:'visible_public_posts',limits:MONITORING_LIMITS,matchMode:'score_or_keyword',publicVisibilityVerified:false});
  return {
    snapshot,
    update(input){const config=validatedConfig(input,state);persist({...state,...config,updatedAt:now()});return snapshot();},
    record(input,analysis,context={}) {
      if(!state.enabled)return {enabled:false,eligible:false,stored:false,reason:'disabled',matchedKeywords:[]};
      const url=canonicalPublicUrl(input.url,input.platform);
      if(!url || context.source!=='extension' || !context.extensionOrigin)return {enabled:true,eligible:false,stored:false,reason:'public_extension_permalink_required',matchedKeywords:[]};
      const scannedAt=now(), text=normalizedText(input.text), lowered=normalizeKeyword(text);
      const kind=['caption','frame','audio','qr'].includes(context.kind)?context.kind:'caption';
      const evidence=sanitizedEvidence(context.evidence);
      const matchedKeywords=state.keywords.filter(word=>lowered.includes(normalizeKeyword(word)));
      const flagged=analysis.score>=state.minScore || matchedKeywords.length>0;
      const fingerprint=sha256(`${url}\n${text}`);
      const records=getCases();
      const existing=records.find(record=>record.source==='extension' && record.provenance?.fingerprint===fingerprint);
      let caseId, stored=false, reason=flagged?'case_limit':'below_threshold';
      const clientDate=typeof context.capturedAt==='string'?Date.parse(context.capturedAt):NaN;
      const capturedAt=Number.isFinite(clientDate)&&Math.abs(Date.parse(scannedAt)-clientDate)<=5*60*1000?new Date(clientDate).toISOString():scannedAt;
      const receipt={capturedAt,receivedAt:scannedAt,kind,clientVersion:typeof context.clientVersion==='string'?context.clientVersion.slice(0,32):'unknown'};
      if(existing || flagged && records.length<MONITORING_LIMITS.cases) {
        let record;
        if(existing) {
          const replace=strongerAnalysis(existing.analysis,analysis);
          const previousEvidence=sanitizedEvidence(existing.evidence);
          const selectedKeys=replace?evidence.slice(0,12).map(evidenceKey)
            :Array.isArray(existing.provenance.selectedEvidenceKeys)?existing.provenance.selectedEvidenceKeys.slice(0,12):previousEvidence.slice(0,12).map(evidenceKey);
          const combinedEvidence=mergeEvidence(previousEvidence,evidence,selectedKeys);
          record={...existing,lastSeen:scannedAt,seenCount:(existing.seenCount||1)+1,
            ...(replace?{analysis,analysisVersion:ANALYSIS_VERSION,analyzedAt:scannedAt}:{}),
            ...(combinedEvidence.length?{evidence:combinedEvidence}:{}),
            provenance:{...existing.provenance,lastObservation:receipt,selectedEvidenceKeys:selectedKeys,
              selectedObservation:replace?receipt:existing.provenance.selectedObservation||existing.provenance.firstObservation,
              ...(replace?{method:kind==='caption'?'visible_caption':context.ai?.ok?'multimodal_model_review':'recognized_media_text',kind,
                ...(context.ai?.ok?{model:String(context.ai.model).slice(0,100),provider:'ollama',processing:'local',sampledMedia:true}:{model:undefined,provider:undefined,processing:undefined}),
                contentKind:String(input.text).startsWith('[AI inference / AI тұжырымы]')?'model_inference':kind==='caption'?'caption':'recognized_media_text'}:{}),
            }};
          persistCases(records.map(item=>item.id===record.id?record:item));
          reason='duplicate_updated';
        } else {
          record={id:randomUUID(),text:input.text,url,platform:input.platform,author:input.author||'',createdAt:scannedAt,capturedAt,lastSeen:scannedAt,seenCount:1,status:'new',demo:false,source:'extension',analysis,analysisVersion:ANALYSIS_VERSION,analyzedAt:scannedAt,...(evidence.length?{evidence}:{}),
            provenance:{source:'extension',method:kind==='caption'?'visible_caption':context.ai?.ok?'multimodal_model_review':'recognized_media_text',kind,contentKind:String(input.text).startsWith('[AI inference / AI тұжырымы]')?'model_inference':kind==='caption'?'caption':'recognized_media_text',...(context.ai?.ok?{model:String(context.ai.model).slice(0,100),provider:'ollama',processing:'local',sampledMedia:true}:{}),fingerprint,canonicalUrl:url,firstObservation:receipt,lastObservation:receipt,selectedObservation:receipt,selectedEvidenceKeys:evidence.slice(0,12).map(evidenceKey),matchedKeywords,minScore:state.minScore,publicVisibilityVerified:false}};
          persistCases([record,...records]);reason='saved';
        }
        caseId=record.id;stored=true;
      }
      const recent={url,platform:input.platform,author:input.author||'',kind,score:analysis.score,matchedKeywords,scannedAt,stored,...(caseId?{caseId}:{})};
      persist({...state,stats:{scanned:state.stats.scanned+1,flagged:state.stats.flagged+(flagged?1:0),saved:state.stats.saved+(stored&&!existing?1:0),lastScanAt:scannedAt},recent:[recent,...state.recent].slice(0,MONITORING_LIMITS.recent)});
      return {enabled:true,eligible:true,flagged,matchedKeywords,stored,...(caseId?{caseId}:{}),reason};
    },
  };
}

export function buildGraph(cases) {
  const nodes=new Map(),edges=[];
  for(const record of cases) {
    const entities=record.analysis?.entities||{};
    const related=[
      ...(entities.domains||[]).filter(domain=>!/(^|\.)(instagram\.com|tiktok\.com|t\.me|telegram\.org|whatsapp\.com)$/.test(domain)).map(domain=>({id:`domain:${domain.toLowerCase()}`,label:domain.toLowerCase(),type:'domain'})),
      ...(entities.handles||[]).map(handle=>({id:`handle:${handle.toLowerCase()}`,label:handle.toLowerCase(),type:'handle'})),
      ...(entities.wallets||[]).map(wallet=>{const address=typeof wallet==='string'?wallet:wallet.address;return typeof address==='string'?{id:`wallet:${address}`,label:address,type:'wallet',network:typeof wallet==='object'?wallet.network:undefined}:null;}).filter(Boolean),
    ];
    if(!related.length)continue;
    nodes.set(record.id,{id:record.id,label:record.author||record.text.slice(0,30)||record.url,type:'case',score:record.analysis.score,demo:Boolean(record.demo)});
    for(const entity of new Map(related.map(item=>[item.id,item])).values()) {
      const previous=nodes.get(entity.id);
      nodes.set(entity.id,{...entity,caseCount:(previous?.caseCount||0)+1});
      edges.push({source:record.id,target:entity.id,relation:'mentioned_in',provenance:record.demo?'demo':record.source||'user_supplied'});
    }
  }
  return {nodes:[...nodes.values()],edges,sharedEntities:[...nodes.values()].filter(node=>node.caseCount>1).map(({id,caseCount})=>({id,caseCount})),disclaimer:{ru:'Совпадение строки не доказывает связь владельцев или общую личность. Адреса кошельков — индикаторы, транзакции не проверены.',kk:'Мәтіннің сәйкестігі иелердің байланысын немесе ортақ тұлғаны дәлелдемейді. Әмиян мекенжайлары — индикаторлар, транзакциялар тексерілмеген.'}};
}

export function capabilities({meta,ai}={}) {
  const feature=(id,status,ru,kk,descriptionRu,descriptionKk)=>({id,status,title:{ru,kk},description:{ru:descriptionRu,kk:descriptionKk}});
  return {version:'5.0.0',capabilities:[
    feature('telegram_monitoring','available','Публичные каналы Telegram','Telegram ашық арналары','Сервер проверяет выбранные открытые каналы по расписанию. Начальный профиль содержит официальные сообщения о схемах, а не всю сеть.','Сервер таңдалған ашық арналарды кесте бойынша тексереді. Бастапқы профиль бүкіл желіні емес, схемалар туралы ресми хабарларды қамтиды.'),
    feature('caption_analysis','available','Анализ подписей RU / KK','RU / KK жазба мәтінін талдау','Правила находят признаки риска и точные цитаты в видимом тексте. Балл не является вероятностью мошенничества.','Ережелер көрінетін мәтіннен қауіп белгілері мен нақты дәйексөздерді табады. Балл — алаяқтық ықтималдығы емес.'),
    feature('monitoring','available','Локальный мониторинг','Жергілікті мониторинг','После включения сохраняет подходящие видимые публикации из расширения: порог риска или ключевые слова.','Қосылғанда кеңейтімдегі көрінетін жазбаларды қауіп шегі не кілт сөз бойынша сақтайды.'),
    feature('video_audio','requires_permission','Кадры и речь','Кадрлар мен дауыс','Кнопка расширения включает локальный OCR и распознавание речи активной вкладки Instagram до 15 минут. Настройка не подтверждает успешный захват.','Кеңейтім батырмасы белсенді Instagram бетінің кадрдағы мәтіні мен дауысын 15 минутқа дейін жергілікті таниды. Баптау сәтті түсірілімді растамайды.'),
    feature('evidence','available','Экспорт доказательств','Дәлелдер экспорты','JSON, источник, время и SHA-256 для проверки целостности. Подлинность оригинала и нарушение проверяет человек.','JSON, дереккөз, уақыт және тұтастықты тексеруге арналған SHA-256. Түпнұсқаны және құқық бұзушылықты адам тексереді.'),
    feature('entity_graph','available','Граф общих индикаторов','Ортақ индикаторлар графы','Связи по совпавшим доменам, упоминаниям и адресам кошельков. Это не идентификация владельца.','Сәйкес домен, аталу және әмиян мекенжайлары бойынша байланыстар. Бұл иесін анықтау емес.'),
    feature('meta_ad_library',meta?.configured?'requires_permission':'not_connected','Meta Ad Library','Meta Ad Library',meta?.configured?'Параметры API заданы. Доступ и разрешения Meta ещё не подтверждены; охват зависит от одобренного доступа.':'Официальный коннектор требует серверных ключей и разрешений Meta. Доступ пока не настроен.',meta?.configured?'API параметрлері берілген. Meta қолжетімділігі мен рұқсаттары әлі расталмаған; қамту мақұлданған рұқсатқа тәуелді.':'Ресми коннектор сервер кілттері мен Meta рұқсатын қажет етеді. Қолжетімділік әлі бапталмаған.'),
    feature('qr','available','QR в кадре','Кадрдағы QR','Локальное декодирование QR в выбранном кадре. Ссылка анализируется как текст и сама не открывается.','Таңдалған кадрдағы QR жергілікті оқылады. Сілтеме мәтін ретінде талданады, өздігінен ашылмайды.'),
    feature('link_inspection','available','Проверка публичной ссылки','Жария сілтемені тексеру','Отдельная проверка HTTP-переходов по запросу пользователя. Это не многорегиональный детектор клоакинга.','Пайдаланушы сұрауы бойынша HTTP бағыттауларын бөлек тексеру. Бұл бірнеше аймақта клоакинг анықтайтын жүйе емес.'),
    feature('logo_vision',ai?.available&&ai?.vision?'available':'not_connected','Предобученная визуальная модель','Алдын ала үйретілген бейне моделі',ai?.available?'Локальная Qwen3-VL анализирует выбранные кадры. Наблюдения модели отделены от точных цитат OCR; это не доказательство мошенничества.':'Локальная визуальная модель пока недоступна. Точный статус — на панели AI.',ai?.available?'Жергілікті Qwen3-VL таңдалған кадрларды талдайды. Модель байқауы OCR дәйексөзінен бөлек; бұл алаяқтық дәлелі емес.':'Жергілікті бейне моделі әзірге қолжетімсіз. Нақты күй AI панелінде.'),
    feature('cloaking','not_connected','Проверка клоакинга','Клоакингті тексеру','Система не открывает подозрительные ссылки через прокси и не проверяет подмену страниц.','Жүйе күдікті сілтемелерді прокси арқылы ашпайды және бет ауыстыруын тексермейді.'),
    feature('takedown','not_connected','Удаление и блокировка','Жою және бұғаттау','SafeNet не имеет доступа к государственным системам, данным Meta для правоохранителей или блокировке сайтов.','SafeNet мемлекеттік жүйелерге, Meta құқық қорғау деректеріне не сайттарды бұғаттауға қол жеткізе алмайды.'),
  ],limits:[
    {ru:'Только загруженные пользователем страницы. Всю соцсеть и закрытые сообщения система не обходит.',kk:'Тек пайдаланушы ашқан беттер. Жүйе бүкіл әлеуметтік желіні және жабық хаттарды араламайды.'},
    {ru:'Адрес публичного формата не подтверждает публичность аккаунта. Сохранённые данные остаются локально.',kk:'Жария форматтағы URL аккаунттың ашықтығын растамайды. Сақталған деректер жергілікті қалады.'},
    {ru:'Автоматическая отметка требует проверки контекста; реклама ставок не равна доказанному мошенничеству.',kk:'Автоматты белгі мәтінмәнді тексеруді қажет етеді; бәс жарнамасы дәлелденген алаяқтыққа тең емес.'},
  ]};
}

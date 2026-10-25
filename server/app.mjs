import express from 'express';
import { readFileSync, existsSync, copyFileSync, constants } from 'node:fs';
import { dirname, resolve, posix } from 'node:path';
import { randomUUID, randomBytes, timingSafeEqual } from 'node:crypto';
import { screenContent, analyzeItem, localizeAnalysis } from './engine.mjs';
import { createPipeline, QUEUE_THRESHOLD } from './pipeline.mjs';
import { writeFileAtomic } from './storage.mjs';
import { createDiscovery } from './discovery.mjs';
import { createSocialDiscovery, defaultOpenProfile } from './social-discovery.mjs';
import { socialRef } from './social.mjs';
import { demoItems } from './demo.mjs';
import { createMediaService, mediaErrorText } from './media.mjs';
import { createAiService } from './ai.mjs';
import { createMonitoring, evidenceBundle, buildGraph, capabilities, sha256, ANALYSIS_VERSION } from './monitoring.mjs';
import { registerIntegrations } from './integrations.mjs';
import { getMetaLibraryStatus } from './meta-library.mjs';
import { createWatchtower } from './watchtower.mjs';
import { KAZAKHSTAN_SOURCES } from './kazakhstan-profile.mjs';

const platforms = new Set(['instagram','tiktok','telegram','whatsapp','other']);
const statuses = new Set(['new','reviewing','confirmed','dismissed','escalated']);
const REVIEW_REASONS = new Set(['signs_confirmed','to_agency','free_contest','legal_ad','news_warning','insufficient','other']);

function inputCase(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Передайте объект с текстом публикации.');
  const text = typeof input.text === 'string' ? input.text.trim() : '';
  const url = typeof input.url === 'string' ? input.url.trim() : '';
  if (!text && !url) throw new Error('Добавьте текст или ссылку для проверки.');
  if (text.length > 30000) throw new Error('Максимум 30 000 символов в одной проверке.');
  if (url.length > 2048) throw new Error('Ссылка слишком длинная.');
  if (url) {
    let parsed; try { parsed = new URL(url); } catch { throw new Error('Укажите полную ссылку, начиная с https://.'); }
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Разрешены только ссылки http:// и https://.');
  }
  if (input.platform && !platforms.has(input.platform)) throw new Error('Неизвестная платформа.');
  return {text, url, platform: input.platform || 'other', author: typeof input.author === 'string' ? input.author.slice(0,120).trim() : ''};
}

function makeCase(input, demo = false, index = 0) {
  return { id:randomUUID(), ...input, createdAt:new Date(Date.now() - (demo ? index * 37 * 60000 : 0)).toISOString(), status:'new', demo, analysis:screenContent(input), analysisVersion:ANALYSIS_VERSION, analyzedAt:new Date().toISOString() };
}

function needsAnalysisMigration(record) {
  if(!record.analysisVersion)return true;
  const version=/^rules-v(\d+)$/.exec(record.analysisVersion);
  return Boolean(version && Number(version[1])<5);
}

function refreshedAnalysis(record) {
  const analysis=screenContent({text:record.text,url:record.url,platform:record.platform});
  const media=record.provenance?.method==='recognized_media_text' || ['frame','audio','qr'].includes(record.provenance?.kind)
    || (Array.isArray(record.evidence) && record.evidence.some(item=>['frame','audio','qr'].includes(item.kind)));
  // Recognition coverage belongs to the captured evidence, not the rules version.
  if(media) {
    if(Array.isArray(record.analysis?.limitations))analysis.limitations=record.analysis.limitations;
    for(const locale of ['ru','kk'])if(Array.isArray(record.analysis?.translations?.[locale]?.limitations))analysis.translations[locale].limitations=record.analysis.translations[locale].limitations;
  }
  return analysis;
}

export function createApp({storePath=resolve('data/cases.json'),monitoringPath=resolve(dirname(storePath),'monitoring.json'),seed=true,aiService=createAiService(),mediaService=createMediaService({aiService}),watchtowerPath=resolve(dirname(storePath),'watchtower.json'),autoProfile=seed,watchtowerFetchPreview,pipelinePath=resolve(dirname(storePath),'pipeline.json'),corpusPath=resolve('data/stream/corpus.json'),autoPipeline=seed,discoveryPath=resolve(dirname(storePath),'discovery.json'),discoveryFetchPreview,telegramSeeds=[],socialPath=resolve(dirname(storePath),'social-discovery.json'),socialOpenProfile,socialSearch,socialEnabled,hosted=false,liveOnly=hosted,allowedHosts=[],accessKey=null} = {}) {
  const app = express();
  const extensionToken = randomBytes(32).toString('hex');
  let scanWindow = Date.now(), scansThisMinute = 0;
  let mediaWindow = Date.now(), mediaThisMinute = 0;
  app.locals.mediaService = mediaService;
  app.locals.aiService = aiService;
  app.locals.liveOnly = liveOnly;
  app.disable('x-powered-by');
  let cases = [];
  if (existsSync(storePath)) {
    const saved = JSON.parse(readFileSync(storePath,'utf8'));
    if (!Array.isArray(saved)) throw new Error('Invalid case database. Restore data/cases.json from backup.');
    cases = saved;
  }
  const persist = (next) => {
    writeFileAtomic(storePath, JSON.stringify(next,null,2));
    cases = next;
  };
  if(liveOnly && existsSync(storePath)) {
    // Archive the exact original once; never replace it on subsequent restarts.
    try {copyFileSync(storePath,`${storePath}.pre-live-only.bak`,constants.COPYFILE_EXCL);}
    catch(error){if(error.code!=='EEXIST')throw error;}
    if(cases.some(record=>record.demo===true))persist(cases.filter(record=>record.demo!==true));
  }
  // Live-only conversion preserves genuine records verbatim, including their original analysis and reviews.
  if(!liveOnly && cases.some(needsAnalysisMigration)) {
    const analyzedAt=new Date().toISOString();
    const upgraded=cases.map(record=>!needsAnalysisMigration(record)?record:{
      ...record,
      ...(!Object.prototype.hasOwnProperty.call(record,'legacyAnalysis')?{
        legacyAnalysis:record.analysis ?? null,legacyAnalysisVersion:record.analysisVersion||null,legacyAnalysisArchivedAt:analyzedAt,legacyAnalysisAnalyzedAt:record.analyzedAt||null,
      }:{}),
      analysis:refreshedAnalysis(record),
      analysisVersion:ANALYSIS_VERSION,analyzedAt,
    });
    // Preserve the original file before an atomic replacement; never replace an older backup.
    try {copyFileSync(storePath,`${storePath}.pre-v3.bak`,constants.COPYFILE_EXCL);}
    catch(error){if(error.code!=='EEXIST')throw error;}
    persist(upgraded);
  }
  if (!liveOnly && seed && !existsSync(storePath)) persist(demoItems.map((item,i)=>makeCase(item,true,i)));
  const monitoring=createMonitoring({storePath:monitoringPath,getCases:()=>cases,persistCases:persist});
  const firstWatchtowerRun=!existsSync(watchtowerPath);
  const watchtower=createWatchtower({storePath:watchtowerPath,getCases:()=>cases,persistCases:persist,defaultSources:KAZAKHSTAN_SOURCES,...(watchtowerFetchPreview?{fetchPreview:watchtowerFetchPreview}:{})});
  app.locals.watchtower=watchtower;
  const pipeline=createPipeline({statePath:pipelinePath,corpusPath,getCases:()=>cases,persistCases:persist,analysisVersion:ANALYSIS_VERSION,autoStart:autoPipeline,liveOnly});
  app.locals.pipeline=pipeline;
  // Deployment starting points stay separate from analyst seeds and Kazakhstan monitoring sources.
  let social=null;
  const discovery=createDiscovery({storePath:discoveryPath,getCases:()=>cases,persistCases:persist,analysisVersion:ANALYSIS_VERSION,extraSeeds:()=>[...telegramSeeds,...watchtower.snapshot().sources.filter(source=>source.enabled).map(source=>source.handle)],onSocialRef:(ref,via)=>social?.addCandidate(ref.platform,ref.handle,via),...(discoveryFetchPreview?{fetchPreview:discoveryFetchPreview}:{})});
  app.locals.discovery=discovery;
  // Public Instagram and TikTok profiles, opened by a headless browser without signing in; linked both ways with the Telegram search.
  social=createSocialDiscovery({storePath:socialPath,getCases:()=>cases,persistCases:persist,analysisVersion:ANALYSIS_VERSION,openProfile:socialOpenProfile??defaultOpenProfile(resolve(dirname(storePath),'browser-profile')),onTelegramRef:(handle,via)=>discovery.addCandidate(handle,via),...(socialSearch?{search:socialSearch}:{})});
  app.locals.social=social;
  if(socialEnabled!==undefined)social.update({enabled:socialEnabled});
  if(firstWatchtowerRun && autoProfile){watchtower.applyProfile('kazakhstan');monitoring.update({enabled:true,minScore:30,keywords:[]});}
  // Hosting (Railway): a public deployment is read-only unless an access key protects the whole site.
  const mode=!hosted?'local':accessKey?'hosted_private':'public_read_only';
  const readOnly=mode==='public_read_only';
  const publicWrites=new Set(['/api/analyze','/api/screen']);
  const demoOnlyPaths=new Set(['/demo-feed','/demo/content.js','/demo-feed.html']);
  const hostAllowed=host=>['127.0.0.1','localhost'].includes(host)||(hosted&&(host==='healthcheck.railway.app'||!allowedHosts.length||allowedHosts.includes(host)));
  const keyBuffer=accessKey?Buffer.from(String(accessKey)):null;
  const hasAccessKey=req=>{
    const match=/^Basic\s+(.+)$/i.exec(req.headers.authorization||'');
    if(!match||!keyBuffer)return false;
    const decoded=Buffer.from(match[1],'base64').toString('utf8');
    if(!decoded.includes(':'))return false;
    const supplied=Buffer.from(decoded.slice(decoded.indexOf(':')+1));
    return supplied.length===keyBuffer.length&&timingSafeEqual(supplied,keyBuffer);
  };
  const scanContext=req=>({source:req.body?.source,extensionOrigin:/^chrome-extension:\/\/[a-p]{32}$/.test(req.headers.origin||''),capturedAt:req.body?.capturedAt,clientVersion:req.body?.clientVersion});
  app.use((req,res,next)=>{
    res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('Referrer-Policy','no-referrer');
    res.setHeader('X-Frame-Options','DENY');
    // Block demo documents before authentication and downstream static serving, including dist copies.
    const apiPath=req.path.toLowerCase().replace(/\/$/,'');
    if(liveOnly){
      let demoPath;
      try {demoPath=posix.normalize(decodeURIComponent(req.path).replaceAll('\\','/')).toLowerCase().replace(/\/$/,'');}
      catch {return res.sendStatus(400);}
      if(demoOnlyPaths.has(demoPath))return res.sendStatus(404);
    }
    if(mode==='hosted_private'&&req.path!=='/api/health'&&!hasAccessKey(req)){res.setHeader('WWW-Authenticate','Basic realm="SafeNet KZ", charset="UTF-8"');return res.status(401).send('Нужен ключ доступа / Кіру кілті қажет');}
    // Express matches route names without case sensitivity and accepts a trailing slash.
    if (apiPath==='/api'||apiPath.startsWith('/api/')) {
      res.setHeader('Cache-Control','no-store');
      const host = (req.headers.host || '').split(':')[0].toLowerCase();
      if (!hostAllowed(host)) return res.status(403).json({error:hosted?'Unknown host.':'Local access only.'});
      if(readOnly&&!['GET','HEAD','OPTIONS'].includes(req.method)&&!publicWrites.has(apiPath))return res.status(403).json({error:'Публичная версия только для чтения: изменения доступны с ключом доступа. / Ашық нұсқа тек оқуға арналған: өзгерістер кіру кілтімен қолжетімді.'});
      const origin = req.headers.origin;
      const extensionRoute = ['/api/extension-token','/api/scan','/api/media-status','/api/media-scan'].includes(req.path);
      const extensionOrigin = extensionRoute && /^chrome-extension:\/\/[a-p]{32}$/.test(origin||'');
      if (origin && origin !== `http://${req.headers.host}` && origin !== `https://${req.headers.host}` && !extensionOrigin) return res.status(403).json({error:'Cross-origin requests are not allowed.'});
      if (req.headers['sec-fetch-site'] === 'cross-site' && !extensionOrigin) return res.status(403).json({error:'Cross-site requests are not allowed.'});
      if(extensionOrigin){res.setHeader('Access-Control-Allow-Origin',origin);res.setHeader('Vary','Origin');res.setHeader('Access-Control-Allow-Methods','GET, POST, OPTIONS');res.setHeader('Access-Control-Allow-Headers','Content-Type, X-SafeNet-Token');}
      if(req.method==='OPTIONS'&&extensionRoute)return res.sendStatus(204);
    }
    next();
  });
  const requireExtensionToken=(req,res,next)=>{
    const supplied=Buffer.from(String(req.headers['x-safenet-token']||''));const expected=Buffer.from(extensionToken);
    if(supplied.length!==expected.length||!timingSafeEqual(supplied,expected))return res.status(401).json({error:'Перезапустите подключение расширения / Кеңейтімді қайта қосыңыз.'});
    next();
  };
  app.get('/api/media-status',requireExtensionToken,async(_req,res)=>{
    try {res.json(await mediaService.status());}
    catch {res.status(503).json({ok:false,code:'media_unavailable',error:'Медиа қызметі қолжетімсіз / Медиаслужба недоступна.'});}
  });
  app.post('/api/media-scan',requireExtensionToken,express.json({limit:'5mb'}),async(req,res)=>{
    if(Date.now()-mediaWindow>60000){mediaWindow=Date.now();mediaThisMinute=0;}
    if(++mediaThisMinute>60){res.setHeader('Retry-After','60');return res.status(429).json({ok:false,code:'media_busy',error:mediaErrorText('media_busy',req.body?.locale)});}
    try {
      const result=await mediaService.scan(req.body);
      if(req.aborted || res.destroyed)return;
      const monitor=result.ok && result.text?.trim() && Number.isFinite(result.analysis?.score)
        ? monitoring.record({text:result.text,url:req.body.url,platform:req.body.platform,author:''},result.analysis,{...scanContext(req),kind:req.body.kind,evidence:result.evidence,ai:result.ai,coverage:result.coverage})
        : {stored:false,reason:'no_recognized_text'};
      res.json({...result,stored:monitor.stored,monitoring:monitor});
    }
    catch(error){
      const code=error.code||'invalid_media';
      if(error.status===429)res.setHeader('Retry-After','5');
      res.status(error.status||400).json({ok:false,code,error:mediaErrorText(code,req.body?.locale),stored:false});
    }
  });
  app.use(express.json({limit:'2mb'}));
  registerIntegrations(app);
  const aiStatus=async(_req,res)=>{const [ai,media]=await Promise.all([aiService.status(),mediaService.status?mediaService.status().catch(()=>({})):Promise.resolve({})]);res.json({...ai,media});};
  app.get('/api/ai/status',aiStatus);
  app.post('/api/ai/check',aiStatus);
  app.get('/api/health',(_req,res)=>res.json({ok:true,engine:ANALYSIS_VERSION,version:'5.0.0',storage:'local',platformApis:false,mode,liveOnly}));
  const watchtowerAction=action=>async(req,res)=>{try{res.json(await action(req));}catch(error){res.status(error.status||400).json({code:error.code||'WATCHTOWER_ERROR',error:error.message||'Не удалось обновить мониторинг.'});}};
  app.get('/api/watchtower',(_req,res)=>res.json(watchtower.snapshot()));
  app.put('/api/watchtower',watchtowerAction(req=>watchtower.update(req.body)));
  app.post('/api/watchtower/sources',watchtowerAction(req=>watchtower.addSource(req.body)));
  app.patch('/api/watchtower/sources/:id',watchtowerAction(req=>watchtower.updateSource(req.params.id,req.body)));
  app.delete('/api/watchtower/sources/:id',watchtowerAction(req=>watchtower.removeSource(req.params.id)));
  app.post('/api/watchtower/run',watchtowerAction(req=>watchtower.run(req.body||{})));
  app.post('/api/watchtower/profile',watchtowerAction(req=>{const result=watchtower.applyProfile(req.body?.profile);monitoring.update({enabled:true,minScore:30,keywords:[]});return result;}));
  app.get('/api/monitoring',(_req,res)=>res.json(monitoring.snapshot()));
  app.put('/api/monitoring',(req,res)=>{
    try {res.json(monitoring.update(req.body));}catch(error){res.status(400).json({error:error.message});}
  });
  app.get('/api/capabilities',async(_req,res)=>res.json(capabilities({meta:getMetaLibraryStatus(),ai:await aiService.status()})));
  app.get('/api/extension-token',(_req,res)=>{const {enabled,minScore,keywords}=monitoring.snapshot();res.json({token:extensionToken,monitoring:{enabled,revision:sha256(JSON.stringify([enabled,minScore,keywords]))}});});
  app.post('/api/scan',(req,res)=>{
    const supplied=Buffer.from(String(req.headers['x-safenet-token']||''));const expected=Buffer.from(extensionToken);
    if(supplied.length!==expected.length||!timingSafeEqual(supplied,expected))return res.status(401).json({error:'Перезапустите подключение расширения / Кеңейтімді қайта қосыңыз.'});
    if(Date.now()-scanWindow>60000){scanWindow=Date.now();scansThisMinute=0;}
    if(++scansThisMinute>180){res.setHeader('Retry-After','60');return res.status(429).json({error:'Слишком много проверок. Повторите через минуту.'});}
    try{
      const input=inputCase(req.body);
      if(!input.text||input.text.length>10000)throw new Error('Автопроверка: от 1 до 10 000 символов на публикацию.');
      const analysis=screenContent(input);
      const monitor=monitoring.record(input,analysis,{...scanContext(req),kind:'caption'});
      // The author of a risky post the analyst saw becomes a candidate for the social search.
      const author=analysis.score>=QUEUE_THRESHOLD?socialRef(input.url):null;
      if(author)social.addCandidate(author.platform,author.handle,{from:'extension',kind:'extension',postUrl:input.url});
      res.json({analysis:localizeAnalysis(analysis,req.body.locale==='ru'?'ru':'kk'),stored:monitor.stored,monitoring:monitor});
    }catch(e){res.status(400).json({error:e.message});}
  });
  app.get('/api/cases',(_req,res)=>res.json({cases:[...cases].sort((a,b)=>b.createdAt.localeCompare(a.createdAt))}));
  app.get('/api/cases/:id/evidence',(req,res)=>{
    const record=cases.find(item=>item.id===req.params.id);
    if(!record)return res.status(404).json({error:'Кейс не найден.'});
    res.attachment(`safenet-evidence-${record.id}.json`).json(evidenceBundle(record));
  });
  app.post('/api/analyze',(req,res)=>{
    try {
      // The public demo analyses without storing, so visitors cannot fill the shared queue.
      if(readOnly) return res.json({...makeCase(inputCase(req.body)),stored:false});
      if(cases.length>=5000) return res.status(409).json({error:'Лимит 5000 кейсов. Экспортируйте и удалите ненужные записи.'});
      const record = makeCase(inputCase(req.body)); persist([record,...cases]); res.status(201).json(record);
    } catch(e) {res.status(400).json({error:e.message});}
  });
  app.post('/api/import',(req,res)=>{
    try {
      if (!Array.isArray(req.body?.items) || !req.body.items.length || req.body.items.length>200) throw new Error('Импортируйте от 1 до 200 записей за раз.');
      if (cases.length+req.body.items.length>5000) return res.status(409).json({error:'Превышен лимит 5000 кейсов.'});
      const incoming=req.body.items.map(inputCase).map(item=>makeCase(item));
      persist([...incoming,...cases]); res.status(201).json({cases:incoming,count:incoming.length});
    } catch(e){res.status(400).json({error:e.message});}
  });
  app.patch('/api/cases/:id',(req,res)=>{
    const record=cases.find(c=>c.id===req.params.id);
    if(!record) return res.status(404).json({error:'Кейс не найден.'});
    if(!statuses.has(req.body?.status)) return res.status(400).json({error:'Недопустимый статус.'});
    const reason=REVIEW_REASONS.has(req.body.reason)?req.body.reason:undefined;
    const note=typeof req.body.note==='string'?req.body.note.slice(0,1000).trim():undefined;
    const reviewedAt=new Date().toISOString();
    // The analyst's decision is about the signs, not a legal verdict; it is kept with the case for audit.
    const review=['confirmed','dismissed','escalated'].includes(req.body.status)?{decision:req.body.status,reason:reason||null,note:note||null,at:reviewedAt,secondsToDecision:record.createdAt?Math.max(0,Math.round((Date.parse(reviewedAt)-Date.parse(record.createdAt))/1000)):null}:record.review;
    const updated={...record,status:req.body.status,reviewedAt,...(review?{review}:{})};
    persist(cases.map(c=>c.id===record.id?updated:c));res.json(updated);
  });
  const priorityOf=record=>record.priority??Math.round((record.analysis?.score??0)*0.8+4);
  app.get('/api/queue',(_req,res)=>{
    const open=cases.filter(c=>['new','reviewing'].includes(c.status)&&(c.analysis?.score??0)>=QUEUE_THRESHOLD).sort((a,b)=>priorityOf(b)-priorityOf(a)||b.createdAt.localeCompare(a.createdAt));
    const reviewed=cases.filter(c=>['confirmed','dismissed','escalated'].includes(c.status)).sort((a,b)=>(b.reviewedAt||'').localeCompare(a.reviewedAt||''));
    const cleared=cases.filter(c=>['new','reviewing'].includes(c.status)&&(c.analysis?.score??0)<QUEUE_THRESHOLD);
    res.json({threshold:QUEUE_THRESHOLD,open,reviewed,clearedCount:cleared.length,counts:{open:open.length,high:open.filter(c=>c.analysis.level==='high').length,reviewed:reviewed.length,cleared:cleared.length}});
  });
  app.get('/api/review-stats',(_req,res)=>{
    const reviewed=cases.filter(c=>['confirmed','dismissed','escalated'].includes(c.status));
    const decisions={confirmed:0,dismissed:0,escalated:0};
    const perSignal=Object.create(null),perTrack=Object.create(null),reasons=Object.create(null);
    for(const record of reviewed){
      decisions[record.status]++;
      const positive=record.status!=='dismissed';
      const track=record.analysis?.category||'none';
      perTrack[track]??={confirmed:0,dismissed:0};perTrack[track][positive?'confirmed':'dismissed']++;
      if(record.review?.reason){reasons[record.review.reason]=(reasons[record.review.reason]||0)+1;}
      for(const signal of record.analysis?.signals||[]){if(!signal.weight)continue;perSignal[signal.id]??={confirmed:0,dismissed:0};perSignal[signal.id][positive?'confirmed':'dismissed']++;}
    }
    const times=reviewed.map(c=>c.review?.secondsToDecision).filter(Number.isFinite).sort((a,b)=>a-b);
    // Feedback loop: signals that analysts often dismiss are candidates for a lower weight in the next rules version.
    const signals=Object.entries(perSignal).map(([id,v])=>({id,...v,total:v.confirmed+v.dismissed,confirmRate:Number((v.confirmed/(v.confirmed+v.dismissed)).toFixed(3))})).sort((a,b)=>b.total-a.total);
    res.json({total:reviewed.length,decisions,confirmRate:reviewed.length?Number(((decisions.confirmed+decisions.escalated)/reviewed.length).toFixed(3)):null,perTrack,reasons,signals,medianSecondsToDecision:times.length?times[Math.floor(times.length/2)]:null});
  });
  const pipelineAction=action=>(req,res)=>{try{res.json(action(req));}catch(error){res.status(error.status||400).json({error:error.message||'Не удалось обновить поток.'});}};
  app.get('/api/pipeline',(req,res)=>res.json(pipeline.snapshot({logLimit:Math.min(400,Math.max(0,Number.parseInt(req.query.limit,10)||80))})));
  app.put('/api/pipeline',pipelineAction(req=>pipeline.update(req.body||{})));
  app.post('/api/pipeline/reset',pipelineAction(()=>pipeline.reset()));
  app.post('/api/pipeline/step',pipelineAction(req=>pipeline.step(Math.min(200,Math.max(1,Number(req.body?.count)||1)))));
  app.get('/api/networks',(_req,res)=>res.json(pipeline.networks()));
  const discoveryAction=action=>async(req,res)=>{try{res.json(await action(req));}catch(error){res.status(error.status||400).json({error:error.message||'Не удалось обновить автопоиск.'});}};
  app.get('/api/discovery',(_req,res)=>res.json(discovery.snapshot()));
  app.put('/api/discovery',discoveryAction(req=>discovery.update(req.body||{})));
  app.post('/api/discovery/seeds',discoveryAction(req=>discovery.addSeed(req.body?.channel,req.body?.note)));
  app.delete('/api/discovery/seeds/:handle',discoveryAction(req=>discovery.removeSeed(String(req.params.handle).toLowerCase())));
  app.post('/api/discovery/run',discoveryAction(async()=>{await discovery.tick();return discovery.snapshot();}));
  const socialAction=action=>async(req,res)=>{try{res.json(await action(req));}catch(error){res.status(error.status||400).json({error:error.message||'Не удалось обновить поиск в Instagram и TikTok.'});}};
  app.get('/api/social',(_req,res)=>res.json(social.snapshot()));
  app.put('/api/social',socialAction(req=>social.update(req.body||{})));
  app.post('/api/social/seeds',socialAction(req=>social.addSeed(req.body?.account,req.body?.platform,req.body?.note)));
  app.delete('/api/social/seeds/:platform/:handle',socialAction(req=>social.removeSeed(String(req.params.platform),String(req.params.handle).toLowerCase())));
  app.post('/api/social/run',socialAction(async()=>{await social.tick();return social.snapshot();}));
  app.post('/api/screen',(req,res)=>{
    // Stateless batch screening for integrations: up to 500 items, nothing is stored.
    try{
      const items=Array.isArray(req.body?.items)?req.body.items:[];
      if(!items.length||items.length>500)throw new Error('Передайте от 1 до 500 элементов в items.');
      const started=performance.now();
      const results=items.map(item=>{const analysis=analyzeItem({text:String(item?.text??'').slice(0,30000),ocrText:String(item?.ocrText??'').slice(0,8000),transcript:String(item?.transcript??'').slice(0,8000),url:typeof item?.url==='string'?item.url:''});return {id:item?.id??null,score:analysis.score,level:analysis.level,category:analysis.category,track:analysis.track,queue:analysis.score>=QUEUE_THRESHOLD,signals:localizeAnalysis(analysis,req.body.locale==='kk'?'kk':'ru').signals.filter(s=>s.weight>0).map(({id,label,weight,quote,modality})=>({id,label,weight,quote,modality})),elements:analysis.elements};});
      res.json({count:results.length,ms:Math.round(performance.now()-started),results});
    }catch(error){res.status(400).json({error:error.message});}
  });
  app.delete('/api/cases/:id',(req,res)=>{
    if(!cases.some(c=>c.id===req.params.id)) return res.status(404).json({error:'Кейс не найден.'});
    persist(cases.filter(c=>c.id!==req.params.id));res.json({ok:true});
  });
  app.post('/api/demo',(_req,res)=>{
    if(liveOnly)return res.status(403).json({error:'Демо-данные недоступны в режиме liveOnly.',liveOnly:true});
    const incoming=demoItems.filter(item=>!cases.some(c=>c.demo&&c.text===item.text)).map((item,i)=>makeCase(item,true,i));
    if(cases.length+incoming.length>5000) return res.status(409).json({error:'Превышен лимит кейсов.'});
    persist([...cases,...incoming]);res.json({cases:incoming,count:incoming.length});
  });
  app.get('/api/metrics',(_req,res)=>{
    const path=resolve('data/metrics.json');
    res.json(existsSync(path)?JSON.parse(readFileSync(path,'utf8')):{available:false,provenance:'synthetic',message:'Запустите npm run evaluate для расчета метрик.'});
  });
  app.get('/api/graph',(_req,res)=>res.json(buildGraph(cases)));
  app.get('/api/sources',(_req,res)=>res.json({sources:[
    {id:'instagram',name:'Instagram',mode:'extension_and_public_profiles',status:'extension_required',description:'Автопроверка видимых публикаций через расширение и автопоиск публичных профилей без входа в аккаунт (страница «Поиск в Instagram и TikTok», включает оператор). Личные сообщения и закрытые аккаунты исключены. Правила Meta автоматический сбор запрещают, см. docs/adr/0003.'},
    {id:'tiktok',name:'TikTok',mode:'extension_and_public_profiles',status:'extension_required',description:'Автопроверка подписей при просмотре ленты через расширение и автопоиск публичных профилей без входа. TikTok обычно показывает капчу автоматическому браузеру: читается только описание профиля, затем платформа ставится на паузу. Захват видео и звука из расширения доступен только для Instagram.'},
    {id:'telegram',name:'Telegram',mode:'public_preview',status:'ready',description:'Автоматическая проверка выбранных открытых каналов по расписанию. Профиль Казахстана содержит официальные сообщения о схемах; закрытые чаты не подключены.'},
    {id:'whatsapp',name:'WhatsApp',mode:'import',status:'manual',description:'Вставка или TXT-экспорт чата, которым вы вправе поделиться. Закрытые чаты не подключены.'},
    {id:'ocr',name:'Скриншоты',mode:'local',status:'ready',description:'OCR в браузере: русский, казахский, английский. Изображение не отправляется на сервер.'}
  ],extensionDownload:'/api/extension'}));
  app.get('/api/export',(req,res)=>{
    if(req.query.format==='csv'){
      const escape=(value)=>{let v=String(value??'');if(/^[=+@\-\t\r]/.test(v))v="'"+v;return '"'+v.replaceAll('"','""')+'"';};
      const rows=[['id','createdAt','platform','author','score','level','category','status','demo','text','url'],...cases.map(c=>[c.id,c.createdAt,c.platform,c.author,c.analysis.score,c.analysis.level,c.analysis.category,c.status,c.demo,c.text,c.url])];
      res.attachment('safenet-cases.csv').type('text/csv').send('\uFEFF'+rows.map(row=>row.map(escape).join(',')).join('\r\n'));
    } else res.attachment('safenet-cases.json').json({exportedAt:new Date().toISOString(),version:'5.0.0',disclaimer:'Признаки риска требуют проверки человеком.',cases});
  });
  app.get('/api/extension',(_req,res)=>{
    const zip=resolve('public/safenet-extension.zip');
    if(!existsSync(zip))return res.status(404).json({error:'Архив отсутствует. Используйте папку extension в проекте.'});
    res.download(zip,'safenet-extension.zip');
  });
  app.use('/api',(_req,res)=>res.status(404).json({error:'API route not found.'}));
  app.use((err,req,res,next)=>{
    if(err.type==='entity.too.large')return res.status(413).json({error:req.path==='/api/media-scan'?'Медиа JSON превышает 5 МБ.':'Файл слишком большой. Максимум 2 МБ.'});
    if(err instanceof SyntaxError)return res.status(400).json({error:'Некорректный JSON.'});
    console.error(err);res.status(500).json({error:'Не удалось обработать запрос. Повторите попытку.'});
  });
  return app;
}

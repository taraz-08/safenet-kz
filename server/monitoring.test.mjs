import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from './app.mjs';
import { createMonitoring, canonicalPublicUrl, canonicalJson, sha256, evidenceBundle, buildGraph } from './monitoring.mjs';

const caption={text:'Казино: бонус и фриспины. Пополни депозит. casino-example.xyz',url:'https://www.instagram.com/example/reel/ABC_123/?ref=private#hash',platform:'instagram',author:'@example'};
const context={source:'extension',extensionOrigin:true,clientVersion:'3.0.0',capturedAt:'2026-10-24T07:00:00.000Z',kind:'caption'};
const analysis={score:65,signals:[{id:'gambling',quote:'Казино'}],entities:{domains:['casino-example.xyz'],handles:['@example']}};
function setup(t) {
  const folder=mkdtempSync(join(tmpdir(),'safenet-monitoring-'));
  t.after(()=>rmSync(folder,{recursive:true,force:true}));
  const storePath=join(folder,'monitoring.json');let cases=[];let tick=0;
  const options={storePath,getCases:()=>cases,persistCases:next=>{cases=next;},now:()=>new Date(Date.parse('2026-10-24T07:00:00.000Z')+tick++*1000).toISOString()};
  return {monitor:createMonitoring(options),reload:()=>createMonitoring(options),cases:()=>cases,storePath};
}

test('monitoring disabled by default leaves no files, counts, recent items or cases',t=>{
  const {monitor,cases,storePath}=setup(t);
  assert.equal(monitor.record(caption,analysis,context).reason,'disabled');
  assert.equal(existsSync(storePath),false);assert.equal(cases().length,0);
  assert.equal(monitor.snapshot().stats.scanned,0);assert.deepEqual(monitor.snapshot().recent,[]);
});

test('canonical public permalinks exclude feeds, comments, credentials, custom ports and private routes',()=>{
  assert.equal(canonicalPublicUrl(caption.url,'instagram'),'https://www.instagram.com/reel/ABC_123/');
  assert.equal(canonicalPublicUrl('https://instagram.com/reels/ABC_123/','instagram'),'https://www.instagram.com/reel/ABC_123/');
  assert.equal(canonicalPublicUrl('https://tiktok.com/@USER/video/123456?x=1','tiktok'),'https://www.tiktok.com/@user/video/123456');
  for(const url of ['https://instagram.com/','https://instagram.com/direct/inbox/','https://instagram.com/%64irect/inbox/','https://instagram.com/direct/p/123/','https://instagram.com/settings/','https://instagram.com/p/a/c/123/','https://instagram.com/p/a/?x=1/../direct/inbox','https://user:pass@instagram.com/p/a/','https://instagram.com:8443/p/a/','https://evil.test/p/a/','http://instagram.com/p/a/']) {
    // Query data is always removed; it cannot turn a public pathname private.
    if(url.includes('?x=1/../')){assert.equal(canonicalPublicUrl(url,'instagram'),'https://www.instagram.com/p/a/');continue;}
    assert.equal(canonicalPublicUrl(url,'instagram'),null,url);
  }
});

test('enabled monitoring rejects untrusted source and private/feed URLs without retaining metadata',t=>{
  const {monitor,cases,storePath}=setup(t);monitor.update({enabled:true});const original=readFileSync(storePath,'utf8');
  for(const [input,source] of [[caption,{...context,source:'manual'}],[caption,{...context,extensionOrigin:false}],[{...caption,url:'https://instagram.com/direct/inbox/'},context],[{...caption,url:'https://instagram.com/'},context]])assert.equal(monitor.record(input,analysis,source).stored,false);
  assert.equal(cases().length,0);assert.equal(readFileSync(storePath,'utf8'),original);
});

test('permalink and normalized caption deduplication persists count and first/last provenance',t=>{
  const {monitor,cases,reload}=setup(t);monitor.update({enabled:true,minScore:60});
  const first=monitor.record(caption,analysis,context);assert.equal(first.stored,true);
  const record=cases()[0];
  assert.equal(record.analysisVersion,'rules-v5');assert.equal(record.analyzedAt,record.createdAt);
  const second=monitor.record({...caption,text:caption.text.replaceAll(' ','  '),url:'https://instagram.com/reels/ABC_123/'},analysis,context);
  assert.equal(second.caseId,first.caseId);assert.equal(second.reason,'duplicate_updated');assert.equal(cases().length,1);
  assert.equal(cases()[0].seenCount,2);assert.equal(cases()[0].createdAt,record.createdAt);assert.ok(cases()[0].lastSeen>record.lastSeen);
  assert.equal(cases()[0].provenance.publicVisibilityVerified,false);
  assert.deepEqual(reload().snapshot().stats,monitor.snapshot().stats);assert.equal(monitor.snapshot().stats.saved,1);
  monitor.record({...caption,text:caption.text+' Новый текст.'},analysis,context);assert.equal(cases().length,2);
});

test('RU and KK watch words match literally case-insensitively, config validation is atomic',t=>{
  const {monitor,cases}=setup(t);monitor.update({enabled:true,minScore:90,keywords:['ЖЕҢІЛ ТАБЫС','казино','КАЗИНО','[test]']});
  assert.deepEqual(monitor.snapshot().keywords,['ЖЕҢІЛ ТАБЫС','КАЗИНО','[test]']);
  assert.equal(monitor.record({...caption,text:'Жеңіл табыс туралы сабақ.'},{...analysis,score:0},context).stored,true);
  assert.equal(cases()[0].analysis.score,0);assert.deepEqual(cases()[0].provenance.matchedKeywords,['ЖЕҢІЛ ТАБЫС']);
  const before=monitor.snapshot();
  for(const input of [{enabled:'yes'},{minScore:101},{minScore:4.5},{keywords:['x']},{keywords:Array(21).fill('test')},{stats:{saved:1000}}])assert.throws(()=>monitor.update(input));
  assert.deepEqual(monitor.snapshot(),before);
});

test('recent buffer is bounded and disabled monitoring resumes without deleting existing cases',t=>{
  const {monitor,cases,storePath}=setup(t);monitor.update({enabled:true,minScore:60});monitor.record(caption,analysis,context);
  for(let i=0;i<35;i++)monitor.record({...caption,text:`ordinary caption ${i}`},{...analysis,score:0},context);
  assert.equal(monitor.snapshot().recent.length,30);assert.equal(monitor.snapshot().stats.scanned,36);
  monitor.update({enabled:false});const original=readFileSync(storePath,'utf8');monitor.record(caption,analysis,context);
  assert.equal(readFileSync(storePath,'utf8'),original);assert.equal(cases().length,1);
});

test('media monitoring saves only recognized text and bounded timestamped evidence, never raw bytes',t=>{
  const {monitor,cases}=setup(t);monitor.update({enabled:true});
  const result=monitor.record({...caption,data:'secret-raw-media',mimeType:'audio/webm'},analysis,{...context,kind:'audio',evidence:[{kind:'audio',text:caption.text,startMs:3000,endMs:6000,data:'secret-raw-media'}]});
  assert.equal(result.stored,true);assert.equal(cases()[0].provenance.kind,'audio');
  assert.deepEqual(cases()[0].evidence,[{kind:'audio',text:caption.text,startMs:3000,endMs:6000}]);assert.ok(!JSON.stringify(cases()).includes('secret-raw-media'));
});

test('vision inference persists model provenance and timestamps without copying raw media or provider extras',t=>{
  const {monitor,cases}=setup(t);monitor.update({enabled:true,minScore:30});
  const model='qwen3-vl:2b-instruct',secret='RAW_PRIVATE_FRAME_BYTES';
  const ai={ok:true,status:'completed',model,provider:'ollama',mode:'local',risk:{score:60},observations:[{modality:'visual',description:'Видны игровые барабаны.',quote:''}]};
  const result=monitor.record({...caption,text:'[AI inference / AI тұжырымы]\nВидны игровые барабаны.',data:secret},{...analysis,score:60,ai},{...context,kind:'frame',ai:{...ai,data:secret},evidence:[{kind:'vision',text:'Видны игровые барабаны.',startMs:14000,endMs:14000,model,method:'model_inference',data:secret}]});
  assert.equal(result.stored,true);
  const record=cases()[0];
  assert.equal(record.provenance.method,'multimodal_model_review');
  assert.equal(record.provenance.contentKind,'model_inference');
  assert.equal(record.provenance.model,model);assert.equal(record.provenance.provider,'ollama');assert.equal(record.provenance.processing,'local');
  assert.deepEqual(record.evidence,[{kind:'vision',text:'Видны игровые барабаны.',startMs:14000,endMs:14000,model,method:'model_inference'}]);
  assert.equal(record.analysis.ai.observations[0].quote,'');
  assert.equal(record.provenance.selectedEvidenceKeys.length,1);
  assert.equal(JSON.stringify(evidenceBundle(record)).includes(secret),false);
});

test('repeated OCR text keeps strongest frame analysis while merging new timestamped visual observations',t=>{
  const {monitor,cases}=setup(t);monitor.update({enabled:true,minScore:30});
  const model='qwen3-vl:2b-instruct';
  const observation=(text,startMs)=>({kind:'vision',text,startMs,endMs:startMs,model});
  const assessed=(score,description)=>({...analysis,score,ai:{ok:true,model,risk:{score},observations:[{modality:'visual',description,quote:''}]}});
  const firstAnalysis=assessed(35,'Игровой интерфейс без призыва.'),highAnalysis=assessed(70,'Игровой интерфейс с призывом внести деньги.');
  const first=monitor.record(caption,firstAnalysis,{...context,kind:'frame',ai:firstAnalysis.ai,evidence:[observation('Игровой интерфейс без призыва.',1000)]});
  const initial=cases()[0];
  const second=monitor.record(caption,highAnalysis,{...context,kind:'frame',ai:highAnalysis.ai,evidence:[observation('Игровой интерфейс с призывом внести деньги.',5000)]});
  assert.equal(first.caseId,second.caseId);assert.equal(cases().length,1);assert.equal(cases()[0].analysis.score,70);
  assert.ok(cases()[0].analyzedAt>initial.analyzedAt);assert.equal(cases()[0].createdAt,initial.createdAt);
  assert.equal(cases()[0].evidence.length,2);
  const selected=cases()[0].provenance.selectedObservation;
  const low=monitor.record(caption,assessed(10,'Новостной контекст.'),{...context,kind:'frame',evidence:[observation('Новостной контекст.',9000)]});
  assert.equal(low.flagged,false);assert.equal(low.reason,'duplicate_updated');assert.equal(low.stored,true);
  assert.equal(cases()[0].analysis.score,70);assert.equal(cases()[0].analysis.ai.observations[0].description,highAnalysis.ai.observations[0].description);
  assert.deepEqual(cases()[0].provenance.selectedObservation,selected);assert.equal(cases()[0].seenCount,3);
  assert.equal(cases()[0].evidence.length,3);assert.equal(monitor.snapshot().stats.saved,1);assert.equal(monitor.snapshot().stats.flagged,2);
});

test('evidence merge is bounded, keeps selected strongest evidence, and deduplicates exact repeated timestamps',t=>{
  const {monitor,cases}=setup(t);monitor.update({enabled:true,minScore:30});
  const strongest={kind:'vision',text:'Высокий риск на выбранном кадре.',startMs:1000,endMs:1000,model:'qwen3-vl:2b-instruct'};
  monitor.record(caption,{...analysis,score:80},{...context,kind:'frame',evidence:[strongest]});
  for(let index=0;index<65;index++)monitor.record(caption,{...analysis,score:30},{...context,kind:'frame',evidence:[{...strongest,text:`Более поздний кадр ${index}`,startMs:index+2000,endMs:index+2000}]});
  assert.equal(cases()[0].evidence.length,50);assert.ok(cases()[0].evidence.some(item=>item.text===strongest.text));
  assert.ok(cases()[0].evidence.some(item=>item.text==='Более поздний кадр 64'));assert.equal(cases()[0].analysis.score,80);
  const count=cases()[0].evidence.length;
  monitor.record(caption,{...analysis,score:30},{...context,kind:'frame',evidence:[strongest,strongest]});
  assert.equal(cases()[0].evidence.length,count);assert.equal(cases()[0].evidence.filter(item=>item.text===strongest.text).length,1);
});

test('same total score can add validated AI coverage without overwriting a stronger prior AI observation',t=>{
  const {monitor,cases}=setup(t);monitor.update({enabled:true,minScore:30});
  monitor.record(caption,analysis,context);
  const ai={ok:true,model:'qwen3-vl:2b-instruct',risk:{score:60},observations:[{modality:'visual',description:'Игровой интерфейс.',quote:''}]};
  monitor.record(caption,{...analysis,ai},{...context,kind:'frame',ai,evidence:[{kind:'vision',text:'Игровой интерфейс.',model:ai.model,startMs:2000,endMs:2000}]});
  assert.equal(cases()[0].analysis.ai.model,ai.model);assert.equal(cases()[0].provenance.method,'multimodal_model_review');
  monitor.record(caption,{...analysis,ai:{...ai,risk:{score:0},observations:[]}},{...context,kind:'frame'});
  assert.equal(cases()[0].analysis.ai.risk.score,60);assert.equal(cases()[0].provenance.model,ai.model);
});

test('evidence hash is independently reproducible, order-independent, tamper-sensitive, and disclaims authenticity',()=>{
  const bundle=evidenceBundle({id:'case1',text:'Жеңіл табыс',analysis,status:'new'});
  assert.equal(bundle.integrity.digest,sha256(canonicalJson(bundle.payload)));
  const reordered={publicVisibilityVerified:bundle.payload.publicVisibilityVerified,collectionScope:bundle.payload.collectionScope,case:bundle.payload.case};
  assert.equal(sha256(canonicalJson(reordered)),bundle.integrity.digest);
  bundle.payload.case.text+=' changed';assert.notEqual(sha256(canonicalJson(bundle.payload)),bundle.integrity.digest);
  assert.match(bundle.disclaimer.ru,/не подтверждает подлинность/);
});

test('shared indicators connect cases without identifying the owner; wallet matching is exact',()=>{
  const wallet='0x1111111111111111111111111111111111111111';
  const records=['one','two'].map(id=>({id,text:'example',analysis:{...analysis,entities:{domains:['www.instagram.com','example.test','example.test'],handles:['@Same'],wallets:[wallet]}}}));
  const graph=buildGraph(records);assert.equal(graph.edges.length,6);assert.equal(graph.sharedEntities.length,3);
  assert.equal(graph.nodes.find(node=>node.id===`wallet:${wallet}`).caseCount,2);assert.ok(graph.edges.every(edge=>edge.relation==='mentioned_in'));assert.match(graph.disclaimer.ru,/не доказывает/);
});

test('monitoring API is local-only; authenticated extension scans save and export bounded evidence',async t=>{
  const folder=mkdtempSync(join(tmpdir(),'safenet-monitoring-api-'));
  const mediaService={scan:async()=>({ok:true,text:caption.text,analysis,evidence:[{kind:'qr',text:caption.text,startMs:1000,endMs:1000}],stored:false}),status:async()=>({ok:true})};
  const server=createApp({storePath:join(folder,'cases.json'),seed:false,mediaService}).listen(0,'127.0.0.1');
  await new Promise(resolve=>server.once('listening',resolve));
  t.after(async()=>{await new Promise(resolve=>server.close(resolve));rmSync(folder,{recursive:true,force:true});});
  const base=`http://127.0.0.1:${server.address().port}`,origin='chrome-extension://'+'a'.repeat(32);
  const send=(path,body,method='POST',headers={})=>fetch(base+path,{method,headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(body)});
  const initial=await(await fetch(base+'/api/extension-token',{headers:{Origin:origin}})).json();assert.equal(initial.monitoring.enabled,false);
  const config=await send('/api/monitoring',{enabled:true,minScore:30,keywords:['казино']},'PUT');assert.equal(config.status,200);
  assert.equal((await send('/api/monitoring',{enabled:false},'PUT',{Origin:origin})).status,403);
  assert.equal((await fetch(base+'/api/monitoring',{headers:{Origin:origin}})).status,403);
  const {token}=await(await fetch(base+'/api/extension-token',{headers:{Origin:origin}})).json();
  const configured=await(await fetch(base+'/api/extension-token',{headers:{Origin:origin}})).json();assert.notEqual(initial.monitoring.revision,configured.monitoring.revision);assert.equal(configured.monitoring.enabled,true);assert.ok(!JSON.stringify(configured).includes('казино'));
  const headers={Origin:origin,'X-SafeNet-Token':token};
  const response=await send('/api/scan',{...caption,source:'extension',clientVersion:'3.0.0'},'POST',headers);
  assert.equal(response.status,200);const scan=await response.json();assert.equal(scan.stored,true);
  const evidence=await fetch(base+`/api/cases/${scan.monitoring.caseId}/evidence`);assert.match(evidence.headers.get('Content-Disposition'),/attachment/);
  const bundle=await evidence.json();assert.equal(bundle.integrity.digest,sha256(canonicalJson(bundle.payload)));
  assert.equal((await fetch(base+`/api/cases/${scan.monitoring.caseId}/evidence`,{headers:{Origin:origin}})).status,403);
  const privateResult=await(await send('/api/scan',{...caption,url:'https://instagram.com/direct/inbox/',source:'extension'},'POST',headers)).json();assert.equal(privateResult.stored,false);
  const mediaResult=await(await send('/api/media-scan',{url:'https://www.instagram.com/p/NEW_QR/',platform:'instagram',kind:'frame',source:'extension',data:'not-persisted'},'POST',headers)).json();assert.equal(mediaResult.stored,true);
  const cases=await(await fetch(base+'/api/cases')).json();assert.equal(cases.cases.length,2);assert.equal(cases.cases[0].evidence[0].kind,'qr');assert.ok(!JSON.stringify(cases).includes('not-persisted'));
  const caps=await(await fetch(base+'/api/capabilities')).json();assert.equal(caps.capabilities.find(item=>item.id==='meta_ad_library').status,'not_connected');
  assert.equal((await(await fetch(base+'/api/health')).json()).version,'5.0.0');
});

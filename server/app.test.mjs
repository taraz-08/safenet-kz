import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from './app.mjs';
import { get } from 'node:http';
import { createMediaService } from './media.mjs';
import { analyzeContent, screenContent } from './engine.mjs';

let server,base,folder,storePath,mediaService;
before(async()=>{
  folder=mkdtempSync(join(tmpdir(),'safenet-test-'));storePath=join(folder,'cases.json');
  mediaService=createMediaService({recognizeFrame:async()=>({text:'MOSTBET промокод. Пополни депозит.'}),transcribeAudio:async()=>({text:'Казино. Играй сейчас.',segments:[{text:'Казино. Играй сейчас.',startMs:0,endMs:1000}]})});
  mediaService.status=async()=>({ok:true,frame:{available:true},audio:{available:false,reason:'model_missing'}});
  const aiService={status:async()=>({ok:true,available:true,ready:true,vision:true,text:true,provider:'ollama',mode:'local',model:'qwen3-vl:2b-instruct',status:'ready'}),close(){}};
  server=createApp({storePath,seed:false,mediaService,aiService}).listen(0,'127.0.0.1');
  await new Promise(resolve=>server.once('listening',resolve));
  base=`http://127.0.0.1:${server.address().port}`;
});
after(async()=>{await new Promise(resolve=>server.close(resolve));await mediaService.close();rmSync(folder,{recursive:true,force:true});});
const send=(path,body,method='POST',headers={})=>fetch(base+path,{method,headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(body)});

test('validation rejects missing data and unsafe URL schemes',async()=>{
  for(const input of [{},{text:''},{url:'javascript:alert(1)'},{text:'x',platform:'fake'},{text:'a'.repeat(50001)}])assert.equal((await send('/api/analyze',input)).status,400);
});
test('case analysis, review, persistence, export and deletion form one working flow',async()=>{
  const response=await send('/api/analyze',{text:'Вложи 5000 тг, получи 10000 тг завтра. Гарантированная прибыль без риска. Пригласи двух друзей.',platform:'telegram',author:'@example'});
  assert.equal(response.status,201); const record=await response.json();
  assert.ok(record.analysis.score>=40);assert.equal(record.demo,false);assert.equal(record.status,'new');
  assert.equal(record.analysisVersion,'rules-v5');assert.ok(Number.isFinite(Date.parse(record.analyzedAt)));
  assert.equal(JSON.parse(readFileSync(storePath,'utf8'))[0].id,record.id);
  assert.equal((await send(`/api/cases/${record.id}`,{status:'invalid'},'PATCH')).status,400);
  const reviewed=await (await send(`/api/cases/${record.id}`,{status:'reviewing'},'PATCH')).json();assert.equal(reviewed.status,'reviewing');
  const exported=await(await fetch(base+'/api/export?format=json')).json();assert.ok(exported.cases.some(c=>c.id===record.id));
  assert.equal((await fetch(base+`/api/cases/${record.id}`,{method:'DELETE'})).status,200);
  assert.equal((await fetch(base+`/api/cases/${record.id}`,{method:'DELETE'})).status,404);
});
test('batch import is atomic when any input is invalid',async()=>{
  const before=await(await fetch(base+'/api/cases')).json();
  assert.equal((await send('/api/import',{items:[{text:'Valid text'},{}]})).status,400);
  const after=await(await fetch(base+'/api/cases')).json();assert.equal(before.cases.length,after.cases.length);
  const valid=await(await send('/api/import',{items:[{text:'Первое сообщение'},{text:'Второе сообщение'}]})).json();assert.equal(valid.count,2);
});
test('cross-origin websites cannot read or mutate local case data',async()=>{
  assert.equal((await send('/api/analyze',{text:'hello'},'POST',{Origin:'https://example.com'})).status,403);
  assert.equal((await fetch(base+'/api/cases',{headers:{'Sec-Fetch-Site':'cross-site'}})).status,403);
  const reboundStatus=await new Promise((resolve,reject)=>get(base+'/api/cases',{headers:{Host:'attacker.example'}},response=>{response.resume();resolve(response.statusCode);}).on('error',reject));
  assert.equal(reboundStatus,403);
});

test('AI readiness reports actual provider and independent speech status, with local-origin protection',async()=>{
  for(const response of [await fetch(base+'/api/ai/status'),await send('/api/ai/check',{})]){
    assert.equal(response.status,200);
    const status=await response.json();
    assert.equal(status.model,'qwen3-vl:2b-instruct');assert.equal(status.vision,true);
    assert.equal(status.media.audio.available,false);assert.equal(status.media.audio.reason,'model_missing');
    assert.equal(status.captureActive,undefined);
  }
  assert.equal((await fetch(base+'/api/ai/status',{headers:{Origin:'https://attacker.example'}})).status,403);
  assert.equal((await send('/api/ai/check',{},'POST',{Origin:'https://attacker.example'})).status,403);
});
test('URL-only input remains metadata, not a claimed fetched post',async()=>{
  const record=await(await send('/api/analyze',{url:'https://www.instagram.com/p/example',platform:'instagram'})).json();
  assert.equal(record.text,'');assert.ok(record.analysis.limitations.length>0);assert.ok(record.analysis.score<40);
});
test('CSV protects spreadsheet formulas and demo seed is idempotent',async()=>{
  await send('/api/analyze',{text:'=HYPERLINK("bad")',author:'@formula'});
  const csv=await(await fetch(base+'/api/export?format=csv')).text();assert.ok(csv.includes("'=HYPERLINK"));assert.ok(csv.includes("'@formula"));
  const first=await(await send('/api/demo',{})).json();const second=await(await send('/api/demo',{})).json();assert.equal(first.count,12);assert.equal(second.count,0);
});
test('related case graph uses extracted entities and source readiness is honest',async()=>{
  const graph=await(await fetch(base+'/api/graph')).json();assert.ok(graph.nodes.length>0);assert.ok(graph.edges.every(e=>graph.nodes.some(n=>n.id===e.source)&&graph.nodes.some(n=>n.id===e.target)));
  const sources=await(await fetch(base+'/api/sources')).json();assert.equal(sources.sources.find(s=>s.id==='tiktok').status,'extension_required');
});
test('automatic extension scan requires token, explains risk and never stores a post',async()=>{
  const input={text:'Вложи 5000 тг и получи 10000 завтра. Гарантированная прибыль без риска.',platform:'instagram',locale:'ru'};
  assert.equal((await send('/api/scan',input)).status,401);
  const origin='chrome-extension://'+'a'.repeat(32);
  const token=await(await fetch(base+'/api/extension-token',{headers:{Origin:origin}})).json();assert.equal(typeof token.token,'string');
  const before=await(await fetch(base+'/api/cases')).json();
  const response=await send('/api/scan',input,'POST',{Origin:origin,'X-SafeNet-Token':token.token});assert.equal(response.status,200);
  const body=await response.json();assert.equal(body.stored,false);assert.ok(body.analysis.score>=30);assert.ok(body.analysis.signals.length>0);
  const after=await(await fetch(base+'/api/cases')).json();assert.equal(after.cases.length,before.cases.length);
  assert.equal((await fetch(base+'/api/cases',{headers:{Origin:origin}})).status,403);
});

test('media endpoints require extension token and preserve local-only origin policy',async()=>{
  const origin='chrome-extension://'+'a'.repeat(32);
  assert.equal((await fetch(base+'/api/media-status',{headers:{Origin:origin}})).status,401);
  assert.equal((await send('/api/media-scan',{},'POST',{Origin:origin})).status,401);
  const {token}=await(await fetch(base+'/api/extension-token',{headers:{Origin:origin}})).json();
  const headers={Origin:origin,'X-SafeNet-Token':token};
  assert.equal((await fetch(base+'/api/media-status',{headers:{...headers,Origin:'https://www.instagram.com'}})).status,403);
  const status=await fetch(base+'/api/media-status',{headers});assert.equal(status.status,200);
  assert.equal((await status.json()).audio.reason,'model_missing');
  assert.equal(status.headers.get('Access-Control-Allow-Origin'),origin);
  const preflight=await fetch(base+'/api/media-scan',{method:'OPTIONS',headers:{Origin:origin}});assert.equal(preflight.status,204);
});

test('media scan validates sources and returns timestamped evidence without saving cases',async()=>{
  const origin='chrome-extension://'+'b'.repeat(32);
  const {token}=await(await fetch(base+'/api/extension-token',{headers:{Origin:origin}})).json();
  const headers={Origin:origin,'X-SafeNet-Token':token};
  const input={kind:'frame',data:readFileSync(new URL('../qa/ocr-fixture.png',import.meta.url)).toString('base64'),mimeType:'image/png',url:'https://www.instagram.com/reels/test/',platform:'instagram',locale:'ru',startMs:3000,endMs:3000};
  const before=await(await fetch(base+'/api/cases')).json();
  const response=await send('/api/media-scan',input,'POST',headers);assert.equal(response.status,200);
  const result=await response.json();assert.equal(result.stored,false);assert.ok(result.analysis.score>=60);assert.equal(result.evidence[0].startMs,3000);
  const after=await(await fetch(base+'/api/cases')).json();assert.equal(after.cases.length,before.cases.length);
  const privateResponse=await send('/api/media-scan',{...input,url:'https://www.instagram.com/direct/inbox/'},'POST',headers);
  assert.equal(privateResponse.status,400);assert.equal((await privateResponse.json()).code,'invalid_source');
  assert.equal((await send('/api/media-scan',{...input,endMs:0},'POST',headers)).status,400);
});

test('only media endpoint accepts its larger JSON body limit',async()=>{
  const {token}=await(await fetch(base+'/api/extension-token')).json();
  const bytes=Buffer.alloc(1600*1024);Buffer.from([0x1a,0x45,0xdf,0xa3]).copy(bytes);
  const input={kind:'audio',data:bytes.toString('base64'),mimeType:'audio/webm;codecs=opus',url:'https://www.instagram.com/reels/test/',platform:'instagram',locale:'kk',startMs:0,endMs:10000};
  const response=await send('/api/media-scan',input,'POST',{'X-SafeNet-Token':token});assert.equal(response.status,200);
  assert.equal((await send('/api/analyze',{text:'a'.repeat(2100*1024)})).status,413);
});

test('legacy case migration refreshes analysis while preserving originals, identity, review and evidence',t=>{
  const migrationFolder=mkdtempSync(join(tmpdir(),'safenet-migration-'));t.after(()=>rmSync(migrationFolder,{recursive:true,force:true}));
  const path=join(migrationFolder,'cases.json');
  const legacy={id:'legacy-case-id',text:'Обычное сообщение о поездке.',url:'https://www.tiktok.com/@demo.bonus_live',platform:'tiktok',author:'@demo.bonus_live',createdAt:'2025-01-01T00:00:00.000Z',analyzedAt:'2025-01-01T00:00:01.000Z',status:'confirmed',reviewedAt:'2025-01-02T00:00:00.000Z',demo:true,source:'extension',provenance:{fingerprint:'original-fingerprint',firstObservation:{capturedAt:'2025-01-01T00:00:00.000Z'}},evidence:[{kind:'frame',text:'Оригинал',startMs:0,endMs:0}],analysis:{score:50,signals:[{id:'link',quote:'https://www.tiktok.com/@demo.bonus_live'}],entities:{domains:['www.tiktok.com']}}};
  const raw=JSON.stringify([legacy],null,2);writeFileSync(path,raw);
  const fakeMedia={status:async()=>({ok:true})};createApp({storePath:path,seed:false,mediaService:fakeMedia});
  const upgraded=JSON.parse(readFileSync(path,'utf8'))[0];
  assert.deepEqual(upgraded.analysis,screenContent(legacy));assert.equal(upgraded.analysisVersion,'rules-v5');
  assert.ok(upgraded.analysis.signals.every(signal=>legacy.text.includes(signal.quote)));
  assert.deepEqual(upgraded.legacyAnalysis,legacy.analysis);assert.equal(upgraded.legacyAnalysisVersion,null);
  assert.equal(upgraded.legacyAnalysisAnalyzedAt,legacy.analyzedAt);
  for(const key of ['id','text','url','platform','author','createdAt','status','reviewedAt','demo','source','provenance','evidence'])assert.deepEqual(upgraded[key],legacy[key],key);
  assert.ok(upgraded.analyzedAt>legacy.analyzedAt);assert.equal(upgraded.legacyAnalysisArchivedAt,upgraded.analyzedAt);
  assert.equal(readFileSync(`${path}.pre-v3.bak`,'utf8'),raw);
  const migratedRaw=readFileSync(path,'utf8');createApp({storePath:path,seed:false,mediaService:fakeMedia});
  assert.equal(readFileSync(path,'utf8'),migratedRaw);assert.equal(readFileSync(`${path}.pre-v3.bak`,'utf8'),raw);
});

test('migration never overwrites an existing archive or downgrades future analysis versions',t=>{
  const migrationFolder=mkdtempSync(join(tmpdir(),'safenet-migration-existing-'));t.after(()=>rmSync(migrationFolder,{recursive:true,force:true}));
  const path=join(migrationFolder,'cases.json');const oldest={score:7,signals:[],entities:{}};
  const legacy={id:'v2',text:'Обычное сообщение.',url:'',platform:'other',status:'dismissed',analysisVersion:'rules-v2',legacyAnalysis:oldest,legacyAnalysisArchivedAt:'2024-01-01T00:00:00.000Z',analysis:{score:90,signals:[],entities:{}}};
  const future={...legacy,id:'future',analysisVersion:'rules-v9'};
  const media={...legacy,id:'old-media',provenance:{kind:'audio',method:'recognized_media_text'},evidence:[{kind:'audio',text:'Обычное сообщение.',startMs:0,endMs:3000}],analysis:{...legacy.analysis,limitations:['Captured audio only; recognition may be wrong.'],translations:{ru:{limitations:['Только распознанная речь.']},kk:{limitations:['Тек танылған дауыс.']}}}};
  writeFileSync(path,JSON.stringify([legacy,future,media]));writeFileSync(`${path}.pre-v3.bak`,'Existing archive must survive.');
  createApp({storePath:path,seed:false,mediaService:{status:async()=>({ok:true})}});
  const upgraded=JSON.parse(readFileSync(path,'utf8'));assert.equal(upgraded[0].analysisVersion,'rules-v5');assert.deepEqual(upgraded[0].legacyAnalysis,oldest);assert.equal(upgraded[0].legacyAnalysisArchivedAt,legacy.legacyAnalysisArchivedAt);assert.deepEqual(upgraded[1],future);
  assert.equal(upgraded[2].analysisVersion,'rules-v5');assert.deepEqual(upgraded[2].analysis.limitations,media.analysis.limitations);assert.deepEqual(upgraded[2].analysis.translations.ru.limitations,media.analysis.translations.ru.limitations);assert.deepEqual(upgraded[2].analysis.translations.kk.limitations,media.analysis.translations.kk.limitations);assert.deepEqual(upgraded[2].provenance,media.provenance);assert.deepEqual(upgraded[2].evidence,media.evidence);
  assert.equal(readFileSync(`${path}.pre-v3.bak`,'utf8'),'Existing archive must survive.');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createWatchtower, fetchTelegramPreview, parseTelegramPreview, telegramHandle, WATCHTOWER_LIMITS } from './watchtower.mjs';

const baseTime=Date.parse('2026-10-24T10:00:00.000Z');
function htmlPost(text='Казино: бонус! Пополни депозит и играй.',id='101',handle='sample_kz',extra='') {
  return `<div class="tgme_widget_message js-widget_message" data-post="${handle}/${id}"><div class="tgme_widget_message_text js-message_text" dir="auto">${text}</div><a class="tgme_widget_message_date"><time datetime="2026-10-24T09:00:00+00:00">12:00</time></a>${extra}</div>`;
}
const page=posts=>`<!doctype html><html><body><div class="tgme_channel_info_header_title"><span>Test &amp; Kazakhstan</span></div><div class="tgme_channel_history">${posts}</div></body></html>`;
function setup(t,overrides={}) {
  const folder=mkdtempSync(join(tmpdir(),'safenet-watchtower-'));
  const storePath=join(folder,'watchtower.json');let records=[],time=baseTime;
  const options={storePath,getCases:()=>records,persistCases:next=>{records=next;},now:()=>new Date(time).toISOString(),fetchPreview:async()=>({html:page(htmlPost())}),...overrides};
  const tower=createWatchtower(options);
  t.after(()=>{tower.close();rmSync(folder,{recursive:true,force:true});});
  return {tower,cases:()=>records,setCases:next=>{records=next;},advance:minutes=>{time+=minutes*60000;},reload:()=>createWatchtower(options),storePath};
}
function enabled(tower,input={}) {tower.addSource({platform:'telegram',handle:'sample_kz',...input});tower.update({enabled:true,minScore:30});return tower.snapshot().sources[0].id;}
const publicDns=async()=>[{address:'149.154.167.99',family:4}];
const htmlResponse=html=>({status:200,headers:{'content-type':'text/html; charset=utf-8'},body:html});

test('Telegram handle validation allows only fixed public usernames, no URL/invitation/path injection',()=>{
  assert.equal(telegramHandle(' @NationalBankKZ '),'nationalbankkz');
  for(const input of ['https://t.me/channel','../admin','@c/a','+secret','abc','1abcdef','sample_kz?x=1','sample_kz#x','sample%5fkz','sample:kz',null])assert.throws(()=>telegramHandle(input),/канал|Имя/);
});

test('public widget parser decodes entities, nested text, anchor URLs and real publication time',()=>{
  const result=parseTelegramPreview(page(htmlPost('Сақ <b>болыңыз</b>!<br>Kaspi &amp; банк. <a href="https://example.com/?a=1&amp;b=2">Сілтеме</a><script>secret()</script>')),'sample_kz');
  assert.equal(result.title,'Test & Kazakhstan');assert.equal(result.status,'ok');assert.equal(result.posts.length,1);
  assert.equal(result.posts[0].text,'Сақ болыңыз!\nKaspi & банк. Сілтеме');
  assert.deepEqual(result.posts[0].links,['https://example.com/?a=1&b=2']);
  assert.equal(result.posts[0].publishedAt,'2026-10-24T09:00:00.000Z');assert.equal(result.posts[0].url,'https://t.me/sample_kz/101');
});

test('parser excludes foreign channels and non-message login/profile text; newest 20 unique IDs only',()=>{
  const articles=Array.from({length:25},(_,i)=>htmlPost(`post ${i}`,String(i+1))).join('');
  const result=parseTelegramPreview(page(articles+htmlPost('foreign','1000','other_kz')+htmlPost('same','25')),'sample_kz');
  assert.equal(result.posts.length,20);assert.equal(result.posts[0].id,'25');assert.equal(result.posts.at(-1).id,'6');
  assert.equal(parseTelegramPreview('<h1>Channel invitation casino</h1>','sample_kz').status,'unavailable');
  assert.equal(parseTelegramPreview(page(''),'sample_kz').status,'empty_preview');
});

test('media-only widgets are counted but never invented as recognized content',()=>{
  const result=parseTelegramPreview(page('<div class="tgme_widget_message" data-post="sample_kz/1"><video><source src="https://cdn.example/video.mp4"></video></div>'),'sample_kz');
  assert.equal(result.posts[0].text,'');assert.equal(result.posts[0].mediaOnly,true);assert.equal(result.limitations.mediaNotAnalyzed,true);
});

test('fetch pins every DNS answer to public t.me with bounded HTML and no arbitrary URL input',async()=>{
  let called=0;
  const result=await fetchTelegramPreview('sample_kz',{resolve:async(host,options)=>{assert.equal(host,'t.me');assert.equal(options.all,true);return publicDns();},transport:async options=>{
    called++;assert.equal(options.url.href,'https://t.me/s/sample_kz');assert.equal(options.maxBytes,1048576);
    const resolved=await new Promise((resolve,reject)=>options.lookup('t.me',{all:true},(err,value)=>err?reject(err):resolve(value)));
    assert.deepEqual(resolved,[{address:'149.154.167.99',family:4}]);return htmlResponse(page(htmlPost()));
  }});
  assert.equal(called,1);assert.match(result.html,/data-post/);
});

test('fetch rejects mixed DNS private answers before opening a socket',async()=>{
  let called=false;
  await assert.rejects(fetchTelegramPreview('sample_kz',{resolve:async()=>[{address:'149.154.167.99',family:4},{address:'127.0.0.1',family:4}],transport:async()=>{called=true;}}),reason=>reason.code==='BLOCKED_ADDRESS');
  assert.equal(called,false);
});

test('fetch never follows login, private, other host or arbitrary redirects',async()=>{
  for(const location of ['https://evil.example/s/sample_kz','http://t.me/s/sample_kz','https://t.me/sample_kz','https://t.me/s/other_kz','https://user@t.me/s/sample_kz','https://t.me/s/sample_kz?before=123']) {
    let calls=0;
    await assert.rejects(fetchTelegramPreview('sample_kz',{resolve:publicDns,transport:async()=>{calls++;return {status:302,headers:{location},body:''};}}),reason=>reason.code==='PREVIEW_UNAVAILABLE');assert.equal(calls,1);
  }
});

test('fetch accepts one exact preview slash redirect, rejects oversized body and unsupported responses',async()=>{
  let calls=0;
  await fetchTelegramPreview('sample_kz',{resolve:publicDns,transport:async()=>++calls===1?{status:302,headers:{location:'/s/sample_kz/'},body:''}:htmlResponse(page(''))});assert.equal(calls,2);
  for(const [response,code]of [[{status:429,headers:{},body:''},'RATE_LIMITED'],[htmlResponse('x'.repeat(WATCHTOWER_LIMITS.maxBytes+1)),'RESPONSE_TOO_LARGE'],[{status:200,headers:{'content-type':'application/json'},body:'{}'},'INVALID_RESPONSE']])await assert.rejects(fetchTelegramPreview('sample_kz',{resolve:publicDns,transport:async()=>response}),reason=>reason.code===code);
});

test('fetch times out hung DNS and respects cancellation before transport',async()=>{
  await assert.rejects(fetchTelegramPreview('sample_kz',{timeoutMs:10,resolve:()=>new Promise(()=>{})}),reason=>reason.code==='TIMEOUT');
  const controller=new AbortController();controller.abort(Object.assign(new Error('stopped'),{code:'CANCELLED'}));
  await assert.rejects(fetchTelegramPreview('sample_kz',{signal:controller.signal,resolve:publicDns}),reason=>reason.code==='CANCELLED');
});

test('watchtower is disabled by default; honest snapshot has no entire-country claim and no hidden fingerprints',async t=>{
  const {tower}=setup(t);assert.equal(tower.snapshot().enabled,false);assert.equal(tower.snapshot().coverage.wholePlatform,false);
  assert.equal(tower.snapshot().coverage.locationVerified,false);assert.equal(tower.snapshot().stats.checkedPosts,0);
  await assert.rejects(tower.run(),reason=>reason.code==='DISABLED');
});

test('collector preserves public source provenance, original text, actual quoted href, date and analysis',async t=>{
  const {tower,cases}=setup(t,{fetchPreview:async()=>page(htmlPost('Казино: пополни депозит, <a href="https://casino.example/promo">бонус</a>'))});enabled(tower);await tower.run();
  assert.equal(cases().length,1);const record=cases()[0];
  assert.equal(record.demo,false);assert.equal(record.source,'public_telegram');assert.equal(record.author,'@sample_kz');
  assert.equal(record.originalText,'Казино: пополни депозит, бонус');assert.match(record.text,/https:\/\/casino.example\/promo/);
  assert.equal(record.provenance.method,'public_preview');assert.equal(record.provenance.scope,'publicly_available_preview');
  assert.equal(record.provenance.locationVerified,false);assert.equal(record.provenance.mediaAnalyzed,false);
  assert.equal(record.publishedAt,'2026-10-24T09:00:00.000Z');assert.equal(record.analysisVersion,'rules-v5');
  const state=tower.snapshot();assert.equal(state.stats.savedCases,1);assert.equal(state.sources[0].status,'ok');assert.equal(state.sources[0].lastError,null);assert.equal('fingerprints'in state.sources[0],false);
});

test('per-source cooldown prevents rapid manual loops; persisted URL+text dedup survives restart',async t=>{
  const {tower,cases,advance,reload}=setup(t);enabled(tower);const completed=await tower.run();const skipped=await tower.run();assert.equal(completed.runOutcome.status,'completed');assert.equal(completed.runOutcome.checkedSources,1);assert.equal(skipped.runOutcome.status,'cooldown');
  assert.equal(tower.snapshot().stats.runs,1);advance(15);await tower.run();
  assert.equal(cases().length,1);assert.equal(tower.snapshot().stats.duplicatePosts,1);
  const again=reload();t.after(()=>again.close());advance(15);await again.run();assert.equal(cases().length,1);assert.equal(again.snapshot().stats.duplicatePosts,2);
});

test('interval changes reschedule from last check and keep five-minute floor plus failure backoff',async t=>{
  let fail=false;const {tower,advance}=setup(t,{fetchPreview:async()=>{if(fail)throw Object.assign(new Error('Too many'),{code:'RATE_LIMITED'});return page(htmlPost());}});enabled(tower);await tower.run();
  tower.update({intervalMinutes:5});assert.equal(tower.snapshot().nextRunAt,new Date(baseTime+5*60000).toISOString());assert.equal((await tower.run()).runOutcome.status,'cooldown');
  advance(5);fail=true;await tower.run();assert.equal(tower.snapshot().nextRunAt,new Date(baseTime+15*60000).toISOString());
  tower.update({intervalMinutes:10});assert.equal(tower.snapshot().nextRunAt,new Date(baseTime+25*60000).toISOString());
  tower.update({intervalMinutes:5});assert.equal(tower.snapshot().nextRunAt,new Date(baseTime+15*60000).toISOString());
});

test('manual run without enabled sources reports no_sources rather than claiming a completed check',async t=>{
  const {tower}=setup(t);tower.update({enabled:true});assert.equal((await tower.run()).runOutcome.status,'no_sources');assert.equal(tower.snapshot().stats.runs,0);
});

test('edited same post is new evidence; below-threshold media-only text remains deduplicated without cases',async t=>{
  let text='Hello world';const {tower,cases,advance}=setup(t,{fetchPreview:async()=>page(htmlPost(text))});enabled(tower);await tower.run();assert.equal(cases().length,0);
  text='Казино: бонус, пополни депозит';advance(15);await tower.run();assert.equal(cases().length,1);assert.equal(tower.snapshot().stats.newPosts,2);
});

test('reference channel keyword match is explicitly warning/news even when it quotes a scam',async t=>{
  const {tower,cases}=setup(t,{fetchPreview:async()=>page(htmlPost('Казино. Пополни депозит, играй, получи бонус!'))});enabled(tower,{kind:'official_reports'});await tower.run();
  assert.equal(cases()[0].riskContext,'warning_or_news');assert.equal(cases()[0].provenance.sourceRole,'official_reports');
  assert.equal(tower.snapshot().stats.reportCases,1);assert.equal(tower.snapshot().stats.reviewCases,0);assert.equal(tower.snapshot().sources[0].reportCases,1);
});

test('analyzer mixed context is preserved instead of erased by a caution keyword',async t=>{
  const {tower,cases}=setup(t,{analyze:()=>({score:75,riskContext:'mixed_requires_review',signals:[{id:'prevention_context'}]})});enabled(tower);await tower.run();assert.equal(cases()[0].riskContext,'mixed_requires_review');assert.equal(tower.snapshot().stats.reviewCases,1);
});

test('disable during in-flight request aborts and prevents late posts from being saved',async t=>{
  let release,started;const began=new Promise(resolve=>{started=resolve;});
  const {tower,cases}=setup(t,{fetchPreview:async()=>{started();return new Promise(resolve=>{release=resolve;});}});enabled(tower);
  const run=tower.run();await began;tower.update({enabled:false});release(page(htmlPost()));await run;
  assert.equal(cases().length,0);assert.equal(tower.snapshot().running,false);assert.equal(tower.snapshot().stats.failedSources,0);
});

test('disabled or deleted source cannot save a late response and overlapping runs are refused',async t=>{
  let release,started;const began=new Promise(resolve=>{started=resolve;});
  const {tower,cases}=setup(t,{fetchPreview:async()=>{started();return new Promise(resolve=>{release=resolve;});}});const id=enabled(tower);
  const run=tower.run();await began;await assert.rejects(tower.run(),reason=>reason.code==='BUSY');tower.removeSource(id);release(page(htmlPost()));await run;assert.equal(cases().length,0);
});

test('disabling one source during a request prevents persistence without cancelling other sources',async t=>{
  let release,started;const began=new Promise(resolve=>{started=resolve;});
  const {tower,cases}=setup(t,{fetchPreview:async handle=>{if(handle==='sample_kz'){started();return new Promise(resolve=>{release=resolve;});}return page(htmlPost('Казино: бонус, пополни депозит','1',handle));}});
  const id=enabled(tower);tower.addSource({platform:'telegram',handle:'other_kz'});const run=tower.run();await began;tower.updateSource(id,{enabled:false});release(page(htmlPost()));await run;
  assert.equal(cases().length,1);assert.equal(cases()[0].author,'@other_kz');assert.equal(tower.snapshot().sources[0].checkedPosts,0);
});

test('changed risk filters re-evaluate previous lowrisk posts after cooldown without duplicating saved cases',async t=>{
  const {tower,cases,advance}=setup(t,{analyze:()=>({score:35,signals:[]})});enabled(tower);tower.update({minScore:90});await tower.run();assert.equal(cases().length,0);
  tower.update({minScore:30});await tower.run();assert.equal(cases().length,0);advance(15);await tower.run();assert.equal(cases().length,1);
  tower.update({keywords:['казино']});advance(15);await tower.run();assert.equal(cases().length,1);
});

test('source failure preserves success history, reports reason and applies exponential backoff',async t=>{
  let failing=false;const {tower,advance}=setup(t,{fetchPreview:async()=>{if(failing)throw Object.assign(new Error('Rate limit'),{code:'RATE_LIMITED'});return page(htmlPost());}});enabled(tower);await tower.run();
  failing=true;advance(15);await tower.run();let source=tower.snapshot().sources[0];assert.equal(source.status,'error');assert.equal(source.lastError.code,'RATE_LIMITED');assert.equal(source.lastSuccessAt,new Date(baseTime).toISOString());
  assert.equal(source.nextRunAt,new Date(baseTime+45*60000).toISOString());advance(30);await tower.run();source=tower.snapshot().sources[0];assert.equal(source.consecutiveErrors,2);assert.equal(source.nextRunAt,new Date(baseTime+105*60000).toISOString());
});

test('empty public history succeeds honestly; inaccessible preview is an error, not a clean scan',async t=>{
  let html=page('');const {tower,advance}=setup(t,{fetchPreview:async()=>html});enabled(tower);await tower.run();assert.equal(tower.snapshot().sources[0].status,'empty_preview');assert.equal(tower.snapshot().stats.checkedPosts,0);
  html='<h1>Join Telegram</h1>';advance(15);await tower.run();assert.equal(tower.snapshot().sources[0].status,'unavailable');assert.equal(tower.snapshot().sources[0].lastError.code,'PREVIEW_UNAVAILABLE');
});

test('case cap retains fingerprint eligibility so finding can be saved after capacity is freed',async t=>{
  const {tower,cases,setCases,advance}=setup(t);enabled(tower);setCases(Array.from({length:5000},(_,i)=>({id:String(i)})));await tower.run();assert.equal(cases().length,5000);
  setCases([]);advance(15);await tower.run();assert.equal(cases().length,1);
});

test('source limits, interval and source-type validation are strict; source config persists',t=>{
  const {tower,reload}=setup(t);assert.throws(()=>tower.update({intervalMinutes:4}));assert.throws(()=>tower.update({unknown:true}));assert.throws(()=>tower.addSource({platform:'instagram',handle:'sample_kz'}));
  for(let i=0;i<20;i++)tower.addSource({platform:'telegram',handle:`channel_${i}`});assert.throws(()=>tower.addSource({platform:'telegram',handle:'more_channel'}),reason=>reason.code==='SOURCE_LIMIT');
  assert.throws(()=>tower.addSource({platform:'telegram',handle:'channel_0'}),reason=>reason.code==='DUPLICATE_SOURCE');const other=reload();t.after(()=>other.close());assert.equal(other.snapshot().sources.length,20);
});

test('Kazakhstan profile is idempotent, retains existing sources and never invents countrywide coverage',t=>{
  const defaults=[{handle:'afm_rk',title:'ҚМА / АФМ',kind:'official_reports'},{handle:'nationalbankkz',title:'Ұлттық Банк',kind:'official_reports'}];
  const {tower,storePath}=setup(t,{defaultSources:defaults});tower.addSource({platform:'telegram',handle:'sample_kz'});tower.applyProfile('kazakhstan');tower.applyProfile('kazakhstan');
  const state=tower.snapshot();assert.equal(state.sources.length,3);assert.equal(state.minScore,30);assert.equal(state.intervalMinutes,10);assert.equal(state.enabled,true);
  assert.equal(state.coverage.wholePlatform,false);assert.equal(state.coverage.platforms[0].connected,false);assert.equal(JSON.parse(readFileSync(storePath,'utf8')).sources.length,3);
  const reference=state.sources.find(item=>item.handle==='afm_rk');tower.updateSource(reference.id,{enabled:false});tower.applyProfile('kazakhstan');assert.equal(tower.snapshot().sources.find(item=>item.handle==='afm_rk').enabled,true);
});

test('close cancels active request and prevents subsequent manual runs',async t=>{
  let started;const began=new Promise(resolve=>{started=resolve;});const {tower,cases}=setup(t,{fetchPreview:async()=>{started();return new Promise(()=>{});}});enabled(tower);const run=tower.run();await began;tower.close();await run;
  assert.equal(cases().length,0);await assert.rejects(tower.run(),reason=>reason.code==='CLOSED');
});

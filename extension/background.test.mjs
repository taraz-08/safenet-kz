import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
const source=readFileSync(new URL('./background.js',import.meta.url),'utf8');
function setup({rejectTokenOnce=false,stored=false}={}){
 let active=0,max=0,scans=0,tokens=0,paused=false;
 let monitoring={enabled:false,revision:null};const listeners=[];
 const sandbox={URL,AbortSignal,Date,Map,Promise,chrome:{runtime:{id:'a'.repeat(32),onMessage:{addListener:listener=>listeners.push(listener)}},storage:{local:{get:async()=>({autoEnabled:!paused})},onChanged:{addListener(){}}}},fetch:async(url,options)=>{
  if(url.endsWith('/api/extension-token')){tokens++;return {ok:true,json:async()=>({token:`token-${tokens}`,monitoring})};}
  assert.equal(url,'http://127.0.0.1:4310/api/scan');assert.equal(options.credentials,'omit');assert.ok(options.headers['X-SafeNet-Token']);
  const body=JSON.parse(options.body);assert.equal(body.source,'extension');assert.equal(body.clientVersion,'4.0.0');assert.ok(Number.isFinite(Date.parse(body.capturedAt)));
  scans++;if(rejectTokenOnce&&scans===1)return {ok:false,status:401};
  active++;max=Math.max(max,active);await new Promise(resolve=>setTimeout(resolve,4));active--;return {ok:true,json:async()=>({analysis:{score:60,level:'high',signals:[]},stored,monitoring:{stored,caseId:stored?'case-one':undefined}})};
 }};
 vm.createContext(sandbox);vm.runInContext(source+'\nglobalThis.api={normalizeRequest,trustedSender,scan,runScan};',sandbox);
 return {api:sandbox.api,stats:()=>({active,max,scans,tokens}),pause:()=>{paused=true;},monitor:next=>{monitoring=next;},health:()=>new Promise(resolve=>listeners[0]({type:'SAFENET_HEALTH'},{id:'a'.repeat(32)},resolve))};
}
const input=(text='A suspicious public caption')=>({text,url:'https://www.instagram.com/p/example/?secret=x#private',platform:'instagram',locale:'kk'});
test('scan payload caps text and strips URL query/hash',()=>{
 const {api}=setup();const result=api.normalizeRequest(input('x'.repeat(12000)));assert.equal(result.text.length,10000);assert.equal(result.url,'https://www.instagram.com/p/example/');assert.equal(result.locale,'kk');
});
test('background rejects arbitrary URLs, private routes, and external senders',()=>{
 const {api}=setup();for(const url of ['https://evil.test/','javascript:alert(1)','https://instagram.com/direct/inbox/','https://instagram.com/%64irect/inbox/','https://instagram.com/settings/','https://instagram.com/saved/','https://instagram.com:8443/p/post/'])assert.throws(()=>api.normalizeRequest({...input(),url}));
 assert.equal(api.trustedSender({id:'b'.repeat(32),url:'https://instagram.com/'}),false);
 assert.equal(api.trustedSender({id:'a'.repeat(32),tab:{},url:'https://www.instagram.com/direct/inbox/'}),false);
});
test('worker limits concurrent scans to two, shares token and deduplicates cached payloads',async()=>{
 const {api,stats}=setup();const payloads=Array.from({length:6},(_,i)=>api.normalizeRequest(input(`Caption number ${i}`)));
 const results=await Promise.all(payloads.map(payload=>api.scan(payload)));assert.ok(results.every(result=>result.ok));assert.equal(stats().max,2);assert.equal(stats().scans,6);assert.equal(stats().tokens,1);
 await api.scan(payloads[0]);assert.equal(stats().scans,6);
});
test('worker renews an expired token after HTTP 401',async()=>{
 const {api,stats}=setup({rejectTokenOnce:true});assert.equal((await api.runScan(api.normalizeRequest(input()))).ok,true);assert.equal(stats().tokens,2);assert.equal(stats().scans,2);
});
test('disabled automatic mode never sends a scan',async()=>{
 const {api,pause,stats}=setup();pause();await assert.rejects(api.runScan(api.normalizeRequest(input())),/paused/);assert.equal(stats().scans,0);assert.equal(stats().tokens,0);
});

test('monitoring storage receipt reaches content without falsely claiming success',async()=>{
 for(const stored of [true,false]){const {api}=setup({stored});const result=await api.runScan(api.normalizeRequest(input()));assert.equal(result.stored,stored);assert.equal(result.monitoring.stored,stored);assert.equal(result.monitoring.caseId,stored?'case-one':undefined);}
});

test('monitoring config refresh invalidates a previously non-saving cached scan',async()=>{
 const {api,monitor,health,stats}=setup();const payload=api.normalizeRequest(input());
 await api.scan(payload);await api.scan(payload);assert.equal(stats().scans,1);
 monitor({enabled:true,revision:'enabled-keywords-revision'});const status=await health();assert.equal(status.monitoring.enabled,true);
 await api.scan(payload);assert.equal(stats().scans,2);
 monitor({enabled:true,revision:'changed-keywords-revision'});await health();await api.scan(payload);assert.equal(stats().scans,3);
});

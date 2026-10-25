import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { registerIntegrations, localizeLinkResult } from './integrations.mjs';

const sample = { url:'https://public.example/', finalUrl:'https://final.example/',
  hops:[{url:'https://public.example/',status:302,location:'https://final.example/'}],
  signals:[{id:'external_redirect',label:'Перенаправление',description:'Описание',quote:'public.example → final.example'}],
  comparison:{requested:true,available:true,different:true,note:'Original'},limitations:['Original'] };

async function withApi(dependencies, run) {
  const app = express(); app.use(express.json());
  registerIntegrations(app, { metaStatus:()=>({configured:false}), metaSearch:async()=>({items:[]}), ...dependencies });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve,reject)=>{server.on('listening',resolve);server.on('error',reject);});
  const base=`http://127.0.0.1:${server.address().port}`;
  const post=(path,body)=>fetch(base+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
  try { await run(post,base); } finally { server.closeAllConnections(); await new Promise(resolve=>server.close(resolve)); }
}

test('Kazakh link evidence localizes explanation but preserves exact quotes and addresses',()=>{
  const result=localizeLinkResult(sample,'kk');
  assert.equal(result.signals[0].quote,sample.signals[0].quote);
  assert.equal(result.finalUrl,sample.finalUrl);
  assert.match(result.signals[0].label,/доменге/);
  assert.match(result.comparison.note,/дәлелі емес/);
  assert.equal(sample.comparison.note,'Original');
});

test('link route forwards bounded inputs and never echoes unexpected upstream errors',async()=>{
  await withApi({linkInspector:async(input)=>{assert.deepEqual(input,{url:'https://public.example/',compare:false});throw Object.assign(new Error('secret upstream token=PRIVATE'),{code:'REQUEST_ERROR'});}},async post=>{
    const response=await post('/api/inspect-link',{url:'https://public.example/',compare:false,locale:'kk'});
    assert.equal(response.status,502);
    const result=await response.json();assert.doesNotMatch(result.error,/PRIVATE|secret/);assert.match(result.error,/мүмкін болмады/);
  });
});

test('integration routes return actual payloads and apply a shared rate bound',async()=>{
  await withApi({linkInspector:async()=>sample},async(post,base)=>{
    assert.equal((await(await fetch(base+'/api/connectors/meta/status')).json()).configured,false);
    for(let i=0;i<12;i++)assert.equal((await post('/api/inspect-link',{url:'https://public.example/'})).status,200);
    const limited=await post('/api/connectors/meta/search',{query:'test'});
    assert.equal(limited.status,429);assert.ok(limited.headers.get('retry-after'));
  });
});

test('only one external inspection runs at a time and the lock is released on failure',async()=>{
  let release,started;const entered=new Promise(resolve=>{started=resolve;});
  await withApi({linkInspector:async()=>{started();await new Promise(resolve=>{release=resolve;});throw new Error('failed');}},async post=>{
    const first=post('/api/inspect-link',{url:'https://public.example/'});
    await Promise.race([entered, first.then(()=>{throw new Error('Request completed before inspector started');})]);
    assert.equal((await post('/api/connectors/meta/search',{query:'test'})).status,429);
    release();assert.equal((await first).status,502);
    assert.equal((await post('/api/connectors/meta/search',{query:'test'})).status,200);
  });
});

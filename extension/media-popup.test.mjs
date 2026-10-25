import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const source=readFileSync(new URL('./media-popup.js',import.meta.url),'utf8');
function fixture({locale='ru',startOk=true}={}) {
  const elements=new Map(),messages=[],queries=[];let closed=false;
  const element=id=>{if(!elements.has(id))elements.set(id,{value:id==='locale'?locale:'',textContent:'',disabled:false,dataset:{},handlers:{},addEventListener(event,handler){this.handlers[event]=handler;}});return elements.get(id);};
  const sandbox={Date,Promise,setInterval(){},document:{getElementById:element},window:{close(){closed=true;}},chrome:{
    runtime:{getManifest:()=>({version:'4.0.0'}),onMessage:{addListener(){}},sendMessage:async message=>{
      messages.push(message);
      if(message.type==='SAFENET_MEDIA_START')return startOk?{ok:true,state:{active:true,autoBrowse:true,expiresAt:Date.now()+900000}}:{ok:false,error:'capture-failed'};
      return {ok:true,state:{active:false}};
    }},
    tabs:{query:async options=>{queries.push(options);return [{id:7,url:'https://www.instagram.com/reels/'}];}},
    storage:{local:{get:async()=>({locale})},onChanged:{addListener(){}}},
  }};
  vm.createContext(sandbox);vm.runInContext(source,sandbox);
  return {element,messages,queries,closed:()=>closed};
}

test('one-action media popup labels both actions and sends opt-in only after the actual click',async()=>{
  for(const locale of ['ru','kk']) {
    const page=fixture({locale});await Promise.resolve();
    assert.equal(page.queries.length,0);assert.equal(page.messages.some(message=>message.type==='SAFENET_MEDIA_START'),false);
    assert.match(page.element('media-start').textContent,locale==='ru'?/ИИ и автопрокрутку/:/ИИ мен автоайналдыруды/);
    assert.match(page.element('media-description').textContent,/15/);
    await page.element('media-start').handlers.click();
    const message=page.messages.find(item=>item.type==='SAFENET_MEDIA_START');
    assert.equal(message.tabId,7);assert.equal(message.autoBrowse,true);assert.equal(page.closed(),true);
  }
});

test('capture refusal stays visible in the popup without claiming a running session',async()=>{
  const page=fixture({startOk:false});await Promise.resolve();await page.element('media-start').handlers.click();
  assert.equal(page.closed(),false);assert.equal(page.element('media-start').disabled,false);assert.equal(page.element('media-stop').disabled,true);
  assert.equal(page.element('media-status').dataset.error,'true');assert.match(page.element('media-status').textContent,/Не удалось/);
});

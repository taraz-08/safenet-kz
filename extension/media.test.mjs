import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {webcrypto} from 'node:crypto';

const background=readFileSync(new URL('./background.js',import.meta.url),'utf8');
const offscreen=readFileSync(new URL('./offscreen.js',import.meta.url),'utf8');
const extensionId='a'.repeat(32);
const extensionUrl=path=>`chrome-extension://${extensionId}/${path}`;
const publicUrl='https://www.instagram.com/reels/example/';
const context=(overrides={})=>({ok:true,url:publicUrl,platform:'instagram',locale:'kk',rect:{x:100,y:10,width:400,height:600},viewport:{width:1000,height:700},excludeRects:[],mediaTime:5,mediaId:'video-element-1:source-hash',duration:0,playbackRate:1,paused:false,muted:false,hidden:false,...overrides});
const waitTick=()=>new Promise(resolve=>setImmediate(resolve));

function setupWorker({deferMedia=false,statusDelayMs=0,clock=null,mediaResult=null}={}) {
  const listeners={messages:[],updated:[],removed:[],activated:[],focus:[],storage:[]};
  const state={tab:{id:7,url:publicUrl,active:true,windowId:1},focused:true,enabled:true,context:context(),streamRequests:[],tabMessages:[],runtimeMessages:[],storageWrites:[],scans:[],offscreenOpened:0,offscreenClosed:0,deferred:[],captureDenied:false};
  const chrome={
    runtime:{id:extensionId,getURL:extensionUrl,getContexts:async()=>[],onMessage:{addListener:fn=>listeners.messages.push(fn)},sendMessage:async message=>{state.runtimeMessages.push(message);return {ok:!(state.captureDenied&&message.type==='SAFENET_OFFSCREEN_START')};}},
    tabs:{get:async()=>state.tab,sendMessage:async(id,message)=>{state.tabMessages.push({id,message});return message.type==='SAFENET_MEDIA_CONTEXT'?(state.contextPromise||state.context):{ok:true};},onUpdated:{addListener:fn=>listeners.updated.push(fn)},onRemoved:{addListener:fn=>listeners.removed.push(fn)},onActivated:{addListener:fn=>listeners.activated.push(fn)}},
    windows:{get:async()=>({focused:state.focused}),onFocusChanged:{addListener:fn=>listeners.focus.push(fn)}},
    storage:{local:{get:async()=>({autoEnabled:state.enabled}),set:async patch=>{state.storageWrites.push(patch);if('autoEnabled' in patch)state.enabled=patch.autoEnabled;}},onChanged:{addListener:fn=>listeners.storage.push(fn)}},
    tabCapture:{getMediaStreamId:async options=>{state.streamRequests.push(options);return 'opaque-never-persisted';}},
    offscreen:{createDocument:async()=>{state.offscreenOpened++;},closeDocument:async()=>{state.offscreenClosed++;}},
  };
  const schedule=clock?.setTimeout||((fn,ms)=>{const timer=setTimeout(fn,ms);timer.unref();return timer;});
  const cancel=clock?.clearTimeout||clearTimeout;
  const sandbox={URL,AbortSignal,AbortController,Date,Map,Promise,crypto:webcrypto,chrome,setTimeout:schedule,clearTimeout:cancel,fetch:async(url,options)=>{
    if(url.endsWith('/api/extension-token'))return {ok:true,json:async()=>({token:'local-secret'})};
    assert.equal(options.credentials,'omit');assert.equal(options.headers['X-SafeNet-Token'],'local-secret');
    if(url.endsWith('/api/media-status')) {
      if(statusDelayMs)await new Promise((resolve,reject)=>{
        const abort=()=>{cancel(timer);reject(new Error('aborted'));};
        const timer=schedule(()=>{options.signal.removeEventListener('abort',abort);resolve();},statusDelayMs);
        options.signal.addEventListener('abort',abort,{once:true});
        if(options.signal.aborted)abort();
      });
      return {ok:true,json:async()=>({ok:true,frame:{ready:true},audio:{ready:true}})};
    }
    assert.equal(url,'http://127.0.0.1:4310/api/media-scan');
    const body=JSON.parse(options.body);state.scans.push({body,signal:options.signal});
    if(deferMedia)await new Promise((resolve,reject)=>{
      const abort=()=>reject(new Error('aborted'));
      options.signal.addEventListener('abort',abort,{once:true});
      state.deferred.push(()=>{options.signal.removeEventListener('abort',abort);resolve();});
      if(options.signal.aborted)abort();
    });
    return {ok:true,json:async()=>mediaResult||({ok:true,text:'Инвестиции без риска',analysis:{score:44,signals:[]},evidence:[{kind:body.kind,text:'Инвестиции без риска',startMs:body.startMs,endMs:body.endMs}],stored:false})};
  }};
  vm.createContext(sandbox);
  vm.runInContext(background+'\nglobalThis.api={normalizeMediaContext,normalizeMediaSample,mediaPageUrl,startMedia,stopMedia,readMediaContext,acceptMediaSample,mediaState,getSession:()=>mediaSession};',sandbox);
  const dispatch=(message,sender)=>new Promise(resolve=>{
    let held=false,answered=false;
    const response=value=>{answered=true;resolve(value);};
    for(const listener of listeners.messages)held=listener(message,sender,response)===true||held;
    if(!held&&!answered)resolve(undefined);
  });
  const popup={id:extensionId,url:extensionUrl('popup.html')};
  const content={id:extensionId,url:publicUrl,tab:state.tab};
  const offscreenSender={id:extensionId,url:extensionUrl('offscreen.html')};
  return {api:sandbox.api,state,listeners,dispatch,popup,content,offscreenSender};
}

function fakeClock() {
  let now=0,serial=0;const tasks=new Map();
  return {
    setTimeout(fn,delay){const id=++serial;tasks.set(id,{at:now+delay,fn});return id;},
    clearTimeout(id){tasks.delete(id);},
    async advance(milliseconds){
      const end=now+milliseconds;
      while(true){
        const next=[...tasks].filter(([,task])=>task.at<=end).sort((a,b)=>a[1].at-b[1].at)[0];
        if(!next)break;
        now=next[1].at;tasks.delete(next[0]);next[1].fn();await waitTick();
      }
      now=end;await waitTick();
    },
  };
}

function sampleMessage(session,overrides={}) {
  return {type:'SAFENET_OFFSCREEN_SAMPLE',sessionId:session.id,revision:session.revision,url:session.url,mediaId:session.mediaId,sample:{kind:'frame',data:'YWJjZA==',mimeType:'image/jpeg',startMs:5000,endMs:5000},...overrides};
}

test('media context is clipped to visible video and rejects private or malformed input',()=>{
  const {api}=setupWorker();
  const normalized=api.normalizeMediaContext(context({url:publicUrl+'?private=query#fragment',rect:{x:-10,y:-20,width:200,height:300}}));
  assert.equal(normalized.url,publicUrl);
  assert.deepEqual(JSON.parse(JSON.stringify(normalized.rect)),{x:0,y:0,width:190,height:280});
  const masked=api.normalizeMediaContext(context({excludeRects:Array.from({length:20},()=>({x:-10,y:0,width:30,height:20}))}));
  assert.equal(masked.excludeRects.length,12);assert.equal(masked.excludeRects[0].width,20);
  for(const value of [context({url:'https://instagram.com/direct/inbox/'}),context({url:'https://instagram.com/%64irect/inbox/'}),context({url:'https://instagram.com:8443/'}),context({url:'https://evil.example/'}),context({rect:{x:5000,y:0,width:20,height:20}}),context({mediaTime:NaN}),context({hidden:true})])assert.throws(()=>api.normalizeMediaContext(value));
});

test('media capture can start only through this extensions popup, with explicit target tab',async()=>{
  const {api,state,dispatch,popup,content}=setupWorker();
  assert.equal(await dispatch({type:'SAFENET_MEDIA_START',tabId:7},content),undefined);
  assert.equal(await dispatch({type:'SAFENET_MEDIA_START',tabId:7},{...popup,id:'b'.repeat(32)}),undefined);
  assert.equal(state.streamRequests.length,0);
  const response=await dispatch({type:'SAFENET_MEDIA_START',tabId:7},popup);
  assert.equal(response.ok,true);assert.equal(response.state.active,true);
  assert.deepEqual(JSON.parse(JSON.stringify(state.streamRequests)),[{targetTabId:7}]);
  assert.equal(state.offscreenOpened,1);
  assert.ok(state.tabMessages.some(item=>item.message.type==='SAFENET_MEDIA_STATE'));
  await api.stopMedia();
  assert.equal(state.offscreenClosed,1);
});

test('a private page on first context reports the stop reason instead of startup success',async()=>{
  const {api,state}=setupWorker();state.context={ok:false,reason:'private'};
  const result=await api.startMedia(7);
  assert.equal(result.ok,false);assert.equal(result.error,'private');
  assert.equal(api.getSession(),null);assert.equal(state.offscreenClosed,1);
  assert.equal(api.mediaState().reason,'private');
});

test('stopping while the first context is pending cannot return successful startup',async()=>{
  for(const reason of ['ended','private','timeout','capture-ended']) {
    const {api,state}=setupWorker();let releaseContext;
    state.contextPromise=new Promise(resolve=>{releaseContext=resolve;});
    const starting=api.startMedia(7);await waitTick();
    assert.ok(api.getSession());
    await api.stopMedia(reason);releaseContext(context());
    const result=await starting;
    assert.equal(result.ok,false);assert.equal(result.error,reason);
    assert.equal(api.getSession(),null);
  }
});

test('popup focus pause still allows a live session to start and resume after popup closes',async()=>{
  const {api,state}=setupWorker();state.context={ok:false,reason:'hidden'};
  const result=await api.startMedia(7);
  assert.equal(result.ok,true);assert.equal(result.state.active,true);assert.equal(result.state.paused,true);
  state.context=context();assert.equal((await api.readMediaContext(api.getSession())).ok,true);
  assert.equal(api.mediaState().paused,false);
  await api.stopMedia();
});

test('healthy audio worker cold start beyond the old timeout can still begin capture',async()=>{
  const clock=fakeClock();const {api,state}=setupWorker({clock,statusDelayMs:18000});
  let settled=false;const starting=api.startMedia(7).then(result=>{settled=true;return result;});
  await waitTick();await clock.advance(13000);
  assert.equal(settled,false,'worker is still warming, not offline');assert.equal(state.streamRequests.length,0);
  await clock.advance(5000);const result=await starting;
  assert.equal(result.ok,true);assert.equal(state.streamRequests.length,1);
  await api.stopMedia();
});

test('unresponsive media readiness remains bounded and never starts capture later',async()=>{
  const clock=fakeClock();const {api,state}=setupWorker({clock,statusDelayMs:40000});
  const starting=api.startMedia(7);await waitTick();await clock.advance(31000);
  const result=await starting;assert.equal(result.ok,false);assert.equal(result.error,'offline');
  assert.equal(state.streamRequests.length,0);
  await clock.advance(10000);assert.equal(state.streamRequests.length,0);assert.equal(api.getSession(),null);
});

test('media session status is not disclosed to another page tab',async()=>{
  const {api,dispatch,popup,content}=setupWorker();
  await dispatch({type:'SAFENET_MEDIA_START',tabId:7},popup);
  const other=await dispatch({type:'SAFENET_MEDIA_STATUS'},{...content,tab:{id:8,url:publicUrl}});
  assert.equal(other.state.active,false);assert.equal(other.state.url,undefined);assert.equal(other.state.sessionId,undefined);
  const own=await dispatch({type:'SAFENET_MEDIA_STATUS'},content);assert.equal(own.state.active,true);
  await api.stopMedia();
});

test('media processing pauses for an inactive tab and stops on private navigation',async()=>{
  const {api,state,listeners}=setupWorker();
  await api.startMedia(7);const session=api.getSession();
  state.tab={...state.tab,active:false};
  assert.equal((await api.readMediaContext(session)).reason,'inactive');
  assert.equal((await api.acceptMediaSample(sampleMessage(session))).ok,false);
  assert.equal(state.scans.length,0);
  state.tab={...state.tab,url:'https://www.instagram.com/direct/inbox/',active:true};
  for(const listener of listeners.updated)listener(7,{url:state.tab.url});
  await waitTick();
  assert.equal(api.getSession(),null);assert.equal(state.offscreenClosed,1);
});

test('old post results are aborted and never forwarded after a route change',async()=>{
  const {api,state}=setupWorker({deferMedia:true});
  await api.startMedia(7);const session=api.getSession();
  const request=api.acceptMediaSample(sampleMessage(session));
  await waitTick();assert.equal(state.scans.length,1);
  state.context=context({url:'https://www.instagram.com/reels/next-post/'});
  await api.readMediaContext(session);
  assert.equal(state.scans[0].signal.aborted,true);
  state.deferred.shift()();
  assert.equal((await request).error,'stale');
  assert.ok(!state.tabMessages.some(item=>item.message.type==='SAFENET_MEDIA_RESULT'));
  await api.stopMedia();
});

test('switching videos on the same home-feed URL invalidates pending results',async()=>{
  const {api,state}=setupWorker({deferMedia:true});
  state.tab.url='https://www.instagram.com/';state.context=context({url:state.tab.url});
  await api.startMedia(7);const session=api.getSession();const revision=session.revision;
  const request=api.acceptMediaSample(sampleMessage(session));await waitTick();
  state.context=context({url:state.tab.url,mediaId:'video-element-2:different-source'});
  await api.readMediaContext(session);
  assert.ok(session.revision>revision);assert.equal(state.scans[0].signal.aborted,true);
  state.deferred.shift()();assert.equal((await request).error,'stale');
  assert.ok(!state.tabMessages.some(item=>item.message.type==='SAFENET_MEDIA_RESULT'));
  await api.stopMedia();
});

test('media expires after the 15 minute session cap',async()=>{
  const {api,state}=setupWorker();
  await api.startMedia(7);const session=api.getSession();
  assert.ok(session.expiresAt-Date.now()<=15*60*1000);
  session.expiresAt=Date.now()-1;
  assert.equal((await api.readMediaContext(session)).reason,'timeout');
  assert.equal(api.getSession(),null);assert.equal(state.offscreenClosed,1);
});

test('only one frame job is in flight and STATE precedes a valid RESULT',async()=>{
  const {api,state}=setupWorker({deferMedia:true});
  await api.startMedia(7);const session=api.getSession();
  const first=api.acceptMediaSample(sampleMessage(session));
  const second=api.acceptMediaSample(sampleMessage(session));
  await waitTick();assert.equal(state.scans.length,1);assert.equal((await second).error,'busy');
  state.deferred.shift()();assert.equal((await first).ok,true);
  const last=state.tabMessages.slice(-3).map(item=>item.message.type);
  assert.deepEqual(last,['SAFENET_MEDIA_STATE','SAFENET_MEDIA_RESULT','SAFENET_MEDIA_STATE']);
  assert.equal(state.scans[0].body.url,publicUrl);assert.equal(state.scans[0].body.platform,'instagram');
  assert.equal(state.tabMessages.at(-2).message.result.stored,false);
  assert.equal(api.mediaState().coverage.frame.completedCount,1);assert.equal(api.mediaState().pending.length,0);
  await api.stopMedia();
});

test('media payload validates duration, MIME and size before sending anything',()=>{
  const {api}=setupWorker();
  const valid={sample:{kind:'audio',data:'YWJjZA==',mimeType:'audio/webm;codecs=opus',startMs:5000,endMs:17000}};
  assert.equal(api.normalizeMediaSample(valid).kind,'audio');
  for(const sample of [{...valid.sample,mimeType:'text/html'},{...valid.sample,endMs:40000},{...valid.sample,startMs:-1},{...valid.sample,data:'<script>'},{...valid.sample,data:'a'.repeat(6*1024*1024+1)}])assert.throws(()=>api.normalizeMediaSample({sample}));
});

function setupOffscreen() {
  const records=[],messages=[],timers=[];
  let lease={ok:true,sessionId:'session-a',revision:1,context:context()};
  const dummyElement={pause(){},srcObject:null,width:1,height:1};
  class FakeRecorder {
    static isTypeSupported(){return true;}
    constructor(stream,options){this.stream=stream;this.mimeType=options.mimeType;this.state='inactive';records.push(this);}
    start(...args){this.startArgs=args;this.state='recording';}
    stop(){this.state='inactive';this.ondataavailable?.({data:new Blob(['complete-webm-header-and-audio'],{type:this.mimeType})});this.done=this.onstop?.();}
  }
  const sandbox={URL,Date,Promise,Blob,Uint8Array,btoa,MediaRecorder:FakeRecorder,MediaStream:class{constructor(tracks){this.tracks=tracks;}},document:{getElementById:()=>({...dummyElement})},chrome:{runtime:{id:extensionId,onMessage:{addListener(){}},sendMessage:async message=>{messages.push(message);return message.type==='SAFENET_OFFSCREEN_CONTEXT'?lease:{ok:true};}}},setTimeout:(fn,ms)=>{const timer={fn,ms};timers.push(timer);return timer;},clearTimeout() {}};
  vm.createContext(sandbox);
  vm.runInContext(offscreen+'\nglobalThis.api={cropForCapture,masksForCapture,continuousMedia,shouldSample,sameLease,audioSegmentLength,recordAudio,discardAudio,finishCapture,setSession:s=>{captureSession=s;}};',sandbox);
  return {api:sandbox.api,records,messages,timers,getLease:()=>lease,setLease:next=>{lease=next;}};
}

test('captured frames are cropped to the video region and bounded to 1280px',()=>{
  const {api}=setupOffscreen();
  const crop=api.cropForCapture({x:-10,y:20,width:410,height:600},{width:1000,height:700},2000,1400);
  assert.deepEqual(JSON.parse(JSON.stringify(crop)),{x:0,y:40,width:800,height:1200,outputWidth:800,outputHeight:1200});
  const large=api.cropForCapture({x:0,y:0,width:2000,height:2000},{width:2000,height:2000},4000,4000);
  assert.equal(large.outputWidth,1280);assert.equal(large.outputHeight,1280);
  assert.equal(api.cropForCapture({x:1001,y:0,width:20,height:20},{width:1000,height:700},2000,1400),null);
});

test('audio continuity rejects route changes, seeks, loops, pauses and muted video',()=>{
  const {api,getLease}=setupOffscreen();const before=getLease();
  const next={...before,context:context({mediaTime:6})};
  assert.equal(api.continuousMedia(before,next,1000),true);
  for(const invalid of [{...next,revision:2},{...next,context:context({url:'https://www.instagram.com/reels/other/'})},{...next,context:context({mediaId:'different-video'})},{...next,context:context({mediaTime:1})},{...next,context:context({mediaTime:50})},{...next,context:context({paused:true})},{...next,context:context({muted:true})},{...next,context:context({playbackRate:2})}])assert.equal(api.continuousMedia(before,invalid,1000),false);
});

test('SafeNet overlay masks use crop coordinates and ignore regions outside the video',()=>{
  const {api}=setupOffscreen();
  const viewport={width:1000,height:700};
  const crop=api.cropForCapture({x:100,y:50,width:400,height:600},viewport,2000,1400);
  const masks=api.masksForCapture([{x:50,y:25,width:100,height:100},{x:600,y:50,width:200,height:100},{x:450,y:600,width:100,height:100}],viewport,crop,2000,1400);
  assert.deepEqual(JSON.parse(JSON.stringify(masks)),[{x:0,y:0,width:100,height:150},{x:700,y:1100,width:100,height:100}]);
});

test('non-normal playback speed never starts audio with misleading timestamps',()=>{
  const {api,records,getLease}=setupOffscreen();
  const session={id:'session-a',stopped:false,stream:{getAudioTracks:()=>[{}]},recording:null,audioBusy:false};api.setSession(session);
  api.recordAudio(session,{...getLease(),context:context({playbackRate:2})});
  assert.equal(records.length,0);
});

test('audio sample is up to12seconds and short reels finish before the loop',()=>{
  const {api}=setupOffscreen();
  assert.equal(api.audioSegmentLength(context({duration:3,mediaTime:0})),2850);
  assert.equal(api.audioSegmentLength(context({duration:2,mediaTime:0.5})),1350);
  assert.equal(api.audioSegmentLength(context({duration:2,mediaTime:1.5})),0);
  assert.equal(api.audioSegmentLength(context({duration:30,mediaTime:0})),12000);
  assert.equal(api.audioSegmentLength(context({duration:0,mediaTime:50})),12000);
});

test('each audio upload is a complete new recorder segment, never a timeslice fragment',async()=>{
  const {api,records,messages,getLease,setLease}=setupOffscreen();
  const session={id:'session-a',stopped:false,stream:{getAudioTracks:()=>[{}]},recording:null,audioBusy:false};api.setSession(session);
  for(const start of [5,9]) {
    session.nextAudioAt=0;
    const initial={...getLease(),context:context({mediaTime:start})};setLease(initial);
    api.recordAudio(session,initial);
    const recorder=records.at(-1);assert.deepEqual(recorder.startArgs,[]);
    const end={...initial,context:context({mediaTime:start+4})};setLease(end);
    session.recording.lastLease=end;session.recording.lastAt=Date.now();
    recorder.stop();await recorder.done;
  }
  assert.equal(records.length,2);
  const uploads=messages.filter(message=>message.type==='SAFENET_OFFSCREEN_SAMPLE');assert.equal(uploads.length,2);
  for(const upload of uploads){assert.equal(upload.sample.endMs-upload.sample.startMs,4000);assert.equal(Buffer.from(upload.sample.data,'base64').toString(),'complete-webm-header-and-audio');}
});

test('route-invalidated recording discards its bytes instead of posting them',async()=>{
  const {api,records,messages,getLease}=setupOffscreen();
  const session={id:'session-a',stopped:false,stream:{getAudioTracks:()=>[{}]},recording:null,audioBusy:false};api.setSession(session);
  api.recordAudio(session,getLease());api.discardAudio(session);await records[0].done;
  assert.equal(messages.filter(message=>message.type==='SAFENET_OFFSCREEN_SAMPLE').length,0);
});

test('an aborted old generation cannot remove the next posts in-flight job or reuse coverage',async()=>{
  const {api,state}=setupWorker({deferMedia:true});await api.startMedia(7);const session=api.getSession();
  const first=api.acceptMediaSample(sampleMessage(session));await waitTick();
  state.context=context({mediaId:'video-next'});await api.readMediaContext(session);
  assert.equal(api.mediaState().coverage.frame.completedCount,0);
  const second=api.acceptMediaSample(sampleMessage(session));await waitTick();
  assert.equal(state.scans.length,2);assert.equal((await first).error,'stale');
  state.deferred.shift()();await waitTick();
  assert.equal(api.mediaState().pending[0],'frame');assert.equal((await api.acceptMediaSample(sampleMessage(session))).error,'busy');
  state.deferred.shift()();assert.equal((await second).ok,true);
  assert.equal(api.mediaState().coverage.frame.completedCount,1);assert.equal(api.mediaState().pending.length,0);
  await api.stopMedia();
});

test('slow inference survives90seconds but is bounded at210seconds without a false completed status',async()=>{
  const clock=fakeClock(),{api,state}=setupWorker({deferMedia:true,clock});await api.startMedia(7);const session=api.getSession();
  const request=api.acceptMediaSample(sampleMessage(session));await waitTick();await clock.advance(120000);
  assert.equal(state.scans[0].signal.aborted,false);assert.equal(api.mediaState().coverage.frame.status,'running');
  await clock.advance(91000);assert.equal((await request).error,'processing-error');
  assert.equal(api.mediaState().coverage.frame.status,'error');assert.equal(api.mediaState().coverage.frame.completedCount,0);
  assert.equal(state.tabMessages.filter(item=>item.message.type==='SAFENET_MEDIA_RESULT').length,0);
  await api.stopMedia();
});

test('sampled vision coverage and actual model status reach content and popup without altering evidence',async()=>{
  const mediaResult={ok:true,text:'',analysis:{score:56,signals:[]},evidence:[{kind:'vision',text:'Possibly a slot-machine interface',startMs:5000,endMs:5000,method:'model_inference',model:'local-test'}],coverage:{visualObjects:true},ai:{status:'ok',model:'local-test',mode:'local',elapsedMs:11500},stored:false};
  const {api,state}=setupWorker({mediaResult});await api.startMedia(7);const session=api.getSession();
  for(let count=1;count<=3;count++) {assert.equal((await api.acceptMediaSample(sampleMessage(session))).ok,true);assert.equal(api.mediaState().coverage.frame.completedCount,count);}
  assert.equal(api.mediaState().coverage.frame.visualObjects,true);assert.equal(api.mediaState().ai.model,'local-test');assert.equal(api.mediaState().ai.elapsedMs,11500);
  const result=state.tabMessages.find(item=>item.message.type==='SAFENET_MEDIA_RESULT').message;
  assert.equal(result.sampleKind,'frame');assert.equal(result.result.evidence[0].method,'model_inference');assert.equal(result.result.text,'');
  state.context=context({muted:true});await api.readMediaContext(session);assert.equal(api.mediaState().coverage.audio.status,'unavailable');
  state.context=context({muted:false});await api.readMediaContext(session);assert.equal(api.mediaState().coverage.audio.status,'waiting');assert.equal(api.mediaState().coverage.frame.completedCount,3);
  await api.stopMedia();
});

test('autoscroll sampling stops at3frames and1audio with no queue flood while manual mode can continue',()=>{
  const {api,getLease}=setupOffscreen();const lease={...getLease(),context:{...getLease().context,autoBrowseEnabled:true},coverage:{frame:{status:'complete',completedCount:2},audio:{status:'complete',completedCount:1}}};
  assert.equal(api.shouldSample(lease,'frame'),true);assert.equal(api.shouldSample(lease,'audio'),false);
  lease.coverage.frame.completedCount=3;assert.equal(api.shouldSample(lease,'frame'),false);
  for(const status of ['running','error','unavailable']){lease.coverage.frame={status,completedCount:0};assert.equal(api.shouldSample(lease,'frame'),false);}
  lease.context.autoBrowseEnabled=false;assert.equal(api.shouldSample(lease,'frame'),true);
  assert.equal(api.sameLease(lease,{...lease,revision:lease.revision+1}),false);
  assert.equal(api.sameLease(lease,{...lease,context:{...lease.context,mediaId:'different'}}),false);
});

test('one-click popup start enables scanning and session-scoped scrolling only after successful capture',async()=>{
  const {api,state,dispatch,popup,content}=setupWorker();state.enabled=false;
  assert.equal(await dispatch({type:'SAFENET_MEDIA_START',tabId:7,autoBrowse:true},content),undefined);
  assert.equal(state.storageWrites.length,0);
  const started=await dispatch({type:'SAFENET_MEDIA_START',tabId:7,autoBrowse:true},popup);
  assert.equal(started.ok,true);assert.equal(started.state.autoBrowse,true);assert.equal(state.enabled,true);
  assert.ok(state.storageWrites.every(patch=>!('autoBrowseEnabled' in patch)),'the new start must never enable unrelated tabs through global storage');
  const other=await dispatch({type:'SAFENET_MEDIA_STATUS'},{...content,tab:{id:8,url:publicUrl}});assert.notEqual(other.state.autoBrowse,true);
  await api.stopMedia();assert.notEqual(api.mediaState().autoBrowse,true);
});

test('one-click media start leaves single posts stationary and never starts browsing after capture refusal',async()=>{
  for(const path of ['/p/sample/','/creator/reel/sample/','/explore/']){
    const {api,state,dispatch,popup}=setupWorker();state.tab.url=`https://www.instagram.com${path}`;state.context=context({url:state.tab.url});
    const started=await dispatch({type:'SAFENET_MEDIA_START',tabId:7,autoBrowse:true},popup);
    assert.equal(started.ok,true);assert.equal(started.state.autoBrowse,false,path);await api.stopMedia();
  }
  const {api,state,dispatch,popup}=setupWorker();state.captureDenied=true;state.enabled=false;
  const rejected=await dispatch({type:'SAFENET_MEDIA_START',tabId:7,autoBrowse:true},popup);
  assert.equal(rejected.ok,false);assert.equal(state.storageWrites.length,0);assert.equal(state.enabled,false);assert.equal(api.getSession(),null);
});

test('the current tab can stop session scrolling and expiry/private navigation remove it without persistence',async()=>{
  for(const reason of ['manual','timeout','private']){
    const {api,state,dispatch,popup,content,listeners}=setupWorker();
    await dispatch({type:'SAFENET_MEDIA_START',tabId:7,autoBrowse:true},popup);const session=api.getSession();
    assert.equal(await dispatch({type:'SAFENET_MEDIA_BROWSE_STOP',sessionId:session.id},{...content,tab:{id:8,url:publicUrl}}),undefined);
    if(reason==='manual') {const result=await dispatch({type:'SAFENET_MEDIA_BROWSE_STOP',sessionId:session.id},content);assert.equal(result.ok,true);assert.equal(result.state.autoBrowse,false);assert.equal(result.state.active,true);await api.stopMedia();}
    else if(reason==='timeout'){session.expiresAt=Date.now()-1;await api.readMediaContext(session);}
    else {state.tab.url='https://www.instagram.com/direct/inbox/';for(const listener of listeners.updated)listener(7,{url:state.tab.url});await waitTick();}
    assert.equal(api.getSession(),null);assert.notEqual(api.mediaState().autoBrowse,true);
    assert.ok(state.storageWrites.every(patch=>!('autoBrowseEnabled' in patch)));
  }
});

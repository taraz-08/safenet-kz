'use strict';

let captureSession=null;
const captureVideo=document.getElementById('capture-video');
const captureCanvas=document.getElementById('capture-frame');
const FRAME_INTERVAL=6000;
const AUDIO_INTERVAL=12000;

function sameLease(previous,next) {
  return Boolean(previous?.ok&&next?.ok&&previous.sessionId===next.sessionId&&previous.revision===next.revision&&previous.context.url===next.context.url&&previous.context.mediaId===next.context.mediaId);
}

function shouldSample(lease,kind) {
  if(!lease?.context?.autoBrowseEnabled)return true;
  const coverage=lease.coverage?.[kind];
  return !['running','error','unavailable'].includes(coverage?.status) && (coverage?.completedCount||0)<(kind==='frame'?3:1);
}

function cropForCapture(rect,viewport,videoWidth,videoHeight) {
  if(!rect||!viewport||![videoWidth,videoHeight,viewport.width,viewport.height].every(value=>Number.isFinite(value)&&value>0))return null;
  if(!['x','y','width','height'].every(key=>Number.isFinite(rect[key]))||rect.width<=0||rect.height<=0)return null;
  const x=Math.max(0,rect.x),y=Math.max(0,rect.y),right=Math.min(viewport.width,rect.x+rect.width),bottom=Math.min(viewport.height,rect.y+rect.height);
  if(right<=x||bottom<=y)return null;
  const scaleX=videoWidth/viewport.width,scaleY=videoHeight/viewport.height;
  const width=(right-x)*scaleX,height=(bottom-y)*scaleY;
  const outputScale=Math.min(1,1280/Math.max(width,height));
  return {x:x*scaleX,y:y*scaleY,width,height,outputWidth:Math.max(1,Math.round(width*outputScale)),outputHeight:Math.max(1,Math.round(height*outputScale))};
}

function continuousMedia(previous,next,elapsedMs) {
  if(!previous?.ok||!next?.ok||previous.sessionId!==next.sessionId||previous.revision!==next.revision||previous.context.url!==next.context.url||previous.context.mediaId!==next.context.mediaId)return false;
  if(next.context.paused||next.context.muted||next.context.hidden||previous.context.playbackRate!==1||next.context.playbackRate!==1)return false;
  const elapsedSeconds=Math.max(0,elapsedMs)/1000;
  const jump=next.context.mediaTime-previous.context.mediaTime;
  // A seek or loop starts a different audio fragment; never join across it.
  return jump>=-0.25 && jump<=elapsedSeconds*3+1.5;
}

function masksForCapture(rects,viewport,crop,videoWidth,videoHeight) {
  if(!crop||!viewport||!viewport.width||!viewport.height)return [];
  const scaleX=videoWidth/viewport.width,scaleY=videoHeight/viewport.height;
  return (Array.isArray(rects)?rects:[]).slice(0,12).flatMap(rect=>{
    if(!rect||!['x','y','width','height'].every(key=>Number.isFinite(rect[key])))return [];
    const left=Math.max(crop.x,rect.x*scaleX),top=Math.max(crop.y,rect.y*scaleY);
    const right=Math.min(crop.x+crop.width,(rect.x+rect.width)*scaleX),bottom=Math.min(crop.y+crop.height,(rect.y+rect.height)*scaleY);
    if(right<=left||bottom<=top)return [];
    return [{x:(left-crop.x)*crop.outputWidth/crop.width,y:(top-crop.y)*crop.outputHeight/crop.height,width:(right-left)*crop.outputWidth/crop.width,height:(bottom-top)*crop.outputHeight/crop.height}];
  });
}

function audioSegmentLength(context) {
  const remaining=Number.isFinite(context.duration)&&context.duration>0?(context.duration-context.mediaTime)*1000-150:AUDIO_INTERVAL;
  const length=Math.floor(Math.min(AUDIO_INTERVAL,remaining));
  return length>=1000?length:0;
}

function isCurrentCapture(session) {return captureSession===session&&!session.stopped;}

function discardAudio(session) {
  const recording=session.recording;
  if(!recording)return;
  recording.discard=true;
  recording.chunks.length=0;
  clearTimeout(recording.timer);
  if(recording.recorder.state!=='inactive')recording.recorder.stop();
  session.recording=null;
}

function finishCapture(reason='ended',notify=true) {
  const session=captureSession;
  if(!session)return;
  captureSession=null;session.stopped=true;
  clearTimeout(session.expiryTimer);clearTimeout(session.pollTimer);
  discardAudio(session);
  for(const track of session.stream?.getTracks()||[]){track.onended=null;track.stop();}
  session.audioSource?.disconnect();
  session.audioContext?.close().catch(()=>{});
  captureVideo.pause();captureVideo.srcObject=null;
  // Remove pixel data immediately; no blob, recording or stream is persisted.
  captureCanvas.width=1;captureCanvas.height=1;
  if(notify)chrome.runtime.sendMessage({type:'SAFENET_OFFSCREEN_ENDED',sessionId:session.id,reason}).catch(()=>{});
}

async function currentLease(session) {
  const response=await chrome.runtime.sendMessage({type:'SAFENET_OFFSCREEN_CONTEXT',sessionId:session.id});
  if(!isCurrentCapture(session))return null;
  if(!response?.ok) {
    discardAudio(session);session.lease=null;
    if(['ended','timeout','private','unsupported'].includes(response?.reason))finishCapture(response.reason,true);
    return null;
  }
  return response;
}

function sendSample(session,lease,sample) {
  if(!isCurrentCapture(session))return Promise.resolve({ok:false,error:'stale'});
  return chrome.runtime.sendMessage({type:'SAFENET_OFFSCREEN_SAMPLE',sessionId:session.id,revision:lease.revision,url:lease.context.url,mediaId:lease.context.mediaId,sample});
}

async function sampleFrame(session,lease) {
  if(session.frameBusy || !isCurrentCapture(session) || !shouldSample(lease,'frame') || captureVideo.readyState<2)return;
  const crop=cropForCapture(lease.context.rect,lease.context.viewport,captureVideo.videoWidth,captureVideo.videoHeight);
  if(!crop)return;
  session.frameBusy=true;session.lastFrameAt=Date.now();
  const startedAt=session.lastFrameAt;
  try {
    captureCanvas.width=crop.outputWidth;captureCanvas.height=crop.outputHeight;
    const context=captureCanvas.getContext('2d',{alpha:false});
    context.drawImage(captureVideo,crop.x,crop.y,crop.width,crop.height,0,0,crop.outputWidth,crop.outputHeight);
    // Never recognize our own risk labels or explanation panel as video evidence.
    context.fillStyle='#000';
    for(const mask of masksForCapture(lease.context.excludeRects,lease.context.viewport,crop,captureVideo.videoWidth,captureVideo.videoHeight))context.fillRect(mask.x,mask.y,mask.width,mask.height);
    const data=captureCanvas.toDataURL('image/jpeg',0.84).split(',')[1];
    captureCanvas.width=1;captureCanvas.height=1;
    await sendSample(session,lease,{kind:'frame',data,mimeType:'image/jpeg',startMs:Math.round(lease.context.mediaTime*1000),endMs:Math.round(lease.context.mediaTime*1000)});
  } catch { /* Skip this frame; the next lease must still pass the worker guards. */ }
  finally {
    session.frameBusy=false;
    // Slow inference has one outstanding frame, with a cooldown after completion.
    session.nextFrameAt=Date.now()+Math.min(10000,Math.max(1500,(Date.now()-startedAt)*0.15));
  }
}

async function blobBase64(blob) {
  const bytes=new Uint8Array(await blob.arrayBuffer());
  let binary='';
  for(let offset=0;offset<bytes.length;offset+=32768)binary+=String.fromCharCode(...bytes.subarray(offset,offset+32768));
  return btoa(binary);
}

function recordAudio(session,lease) {
  if(session.recording || session.audioBusy || !isCurrentCapture(session) || !shouldSample(lease,'audio') || Date.now()<(session.nextAudioAt||0) || lease.context.paused || lease.context.muted || lease.context.playbackRate!==1 || !session.stream.getAudioTracks().length)return;
  const durationMs=audioSegmentLength(lease.context);
  if(!durationMs)return;
  const mimeType=['audio/webm;codecs=opus','audio/webm'].find(type=>MediaRecorder.isTypeSupported(type));
  if(!mimeType)return;
  const stream=new MediaStream(session.stream.getAudioTracks());
  const recorder=new MediaRecorder(stream,{mimeType,audioBitsPerSecond:64000});
  const recording={recorder,lease,chunks:[],discard:false,lastLease:lease,lastAt:Date.now(),durationMs,timer:null};
  session.recording=recording;
  recorder.ondataavailable=event=>{if(!recording.discard&&event.data.size)recording.chunks.push(event.data);};
  recorder.onerror=()=>{recording.discard=true;};
  recorder.onstop=async()=>{
    clearTimeout(recording.timer);
    if(session.recording===recording)session.recording=null;
    if(recording.discard||!isCurrentCapture(session)||!recording.chunks.length)return;
    session.audioBusy=true;
    try {
      const endLease=await currentLease(session);
      if(!endLease||!continuousMedia(recording.lastLease,endLease,Date.now()-recording.lastAt)||!continuousMedia(recording.lease,endLease,recording.durationMs))return;
      const startMs=Math.round(recording.lease.context.mediaTime*1000),endMs=Math.round(endLease.context.mediaTime*1000);
      if(endMs-startMs<1000||endMs-startMs>20000)return;
      // Every segment is a newly started/stopped recorder with its own container header.
      const blob=new Blob(recording.chunks,{type:mimeType});
      recording.chunks.length=0;
      if(blob.size>4*1024*1024)return;
      const data=await blobBase64(blob);
      if(!isCurrentCapture(session))return;
      await sendSample(session,endLease,{kind:'audio',data,mimeType,startMs,endMs});
    } catch { /* Unavailable/changed media is discarded without retrying old audio. */ }
    finally {recording.chunks.length=0;session.audioBusy=false;session.nextAudioAt=Date.now()+3000;}
  };
  // Do not use timeslice: subsequent WebM chunks need not be standalone files.
  recorder.start();
  recording.timer=setTimeout(()=>{if(recorder.state!=='inactive')recorder.stop();},durationMs);
}

async function pollCapture(session) {
  if(!isCurrentCapture(session))return;
  if(Date.now()>=session.expiresAt){finishCapture('timeout');return;}
  try {
    const lease=await currentLease(session);
    if(!lease)return;
    if(session.recording) {
      const recording=session.recording;
      if(!continuousMedia(recording.lastLease,lease,Date.now()-recording.lastAt))discardAudio(session);
      else {recording.lastLease=lease;recording.lastAt=Date.now();}
    }
    if(!sameLease(session.lease,lease)) {session.lastFrameAt=0;session.nextFrameAt=0;session.nextAudioAt=0;session.leaseStableSince=Date.now();}
    session.lease=lease;
    // Let tabCapture pixels catch up with a SPA/player transition before sampling.
    if(Date.now()-(session.leaseStableSince||0)<1000)return;
    if(Date.now()-session.lastFrameAt>=FRAME_INTERVAL && Date.now()>=(session.nextFrameAt||0))sampleFrame(session,lease);
    recordAudio(session,lease);
  } catch {
    discardAudio(session);session.lease=null;
    // A worker that no longer responds cannot safely authorize further capture.
    if(++session.failures>=3)finishCapture('ended');
    return;
  } finally {
    if(isCurrentCapture(session))session.pollTimer=setTimeout(()=>pollCapture(session),1000);
  }
  session.failures=0;
}

async function startCapture(message) {
  finishCapture('ended',false);
  const session={id:message.sessionId,expiresAt:message.expiresAt,stopped:false,stream:null,recording:null,frameBusy:false,audioBusy:false,lastFrameAt:0,failures:0};
  captureSession=session;
  try {
    if(typeof message.streamId!=='string'||!message.streamId||!Number.isFinite(message.expiresAt)||message.expiresAt<=Date.now())throw new Error('invalid');
    const stream=await navigator.mediaDevices.getUserMedia({
      audio:{mandatory:{chromeMediaSource:'tab',chromeMediaSourceId:message.streamId}},
      video:{mandatory:{chromeMediaSource:'tab',chromeMediaSourceId:message.streamId}},
    });
    if(!isCurrentCapture(session)){for(const track of stream.getTracks())track.stop();return {ok:false,error:'ended'};}
    session.stream=stream;
    for(const track of stream.getTracks())track.onended=()=>{if(isCurrentCapture(session))finishCapture('capture-ended');};
    if(stream.getAudioTracks().length) {
      session.audioContext=new AudioContext();
      session.audioSource=session.audioContext.createMediaStreamSource(stream);
      session.audioSource.connect(session.audioContext.destination);
      await session.audioContext.resume();
    }
    captureVideo.srcObject=stream;captureVideo.muted=true;await captureVideo.play();
    if(!isCurrentCapture(session))return {ok:false,error:'ended'};
    session.expiryTimer=setTimeout(()=>{if(isCurrentCapture(session))finishCapture('timeout');},Math.min(15*60*1000,session.expiresAt-Date.now()));
    session.pollTimer=setTimeout(()=>pollCapture(session),0);
    return {ok:true,audioAvailable:stream.getAudioTracks().length>0};
  } catch {if(isCurrentCapture(session))finishCapture('capture-failed',false);return {ok:false,error:'capture-failed'};}
}

chrome.runtime.onMessage.addListener((message,sender,sendResponse)=>{
  if(sender.id!==chrome.runtime.id||sender.tab||message?.target!=='safenet-offscreen')return false;
  if(message.type==='SAFENET_OFFSCREEN_START'){startCapture(message).then(sendResponse);return true;}
  if(message.type==='SAFENET_OFFSCREEN_STOP') {
    if(!message.sessionId||captureSession?.id===message.sessionId)finishCapture(message.reason||'ended',false);
    sendResponse({ok:true});return false;
  }
  if(message.type==='SAFENET_OFFSCREEN_INVALIDATE'&&captureSession?.id===message.sessionId){discardAudio(captureSession);captureSession.lease=null;sendResponse({ok:true});}
  return false;
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const source=readFileSync(new URL('./content.js',import.meta.url),'utf8');
function setup({origin='https://www.instagram.com',path='/',demo=false,fixture=null,hidden=false,focused=true}={}){
 let now=1000;const delays=[];
 const queried=[];const sandbox={URL,Date:{now:()=>now},setTimeout:(_fn,delay)=>{delays.push(delay);return delays.length;},clearTimeout(){},innerWidth:1000,innerHeight:800,getComputedStyle:()=>({display:'block',visibility:'visible',opacity:'1'}),location:{origin,pathname:path,hostname:new URL(origin).hostname},document:{hidden,hasFocus:()=>focused,documentElement:{dataset:{safenetDemo:String(demo)}},querySelectorAll:selector=>{queried.push(selector);return selector==='article'? fixture?.articles||[] : selector==='a[href]' ? fixture?.links||[] : selector==='[aria-label="Video player"]'? fixture?.players||[] : selector==='video'?fixture?.videos||[]:[];},querySelector:selector=>{queried.push(selector);return selector==='meta[property="og:url"]' && fixture ? {getAttribute:()=>fixture.canonical} : null;}},IntersectionObserver:class{observe(){}},Map};
 const scrolls=[],messages=[];sandbox.window={scrollBy:options=>scrolls.push(options)};sandbox.document.body=fixture?.body||{};
 sandbox.chrome={runtime:{sendMessage:async message=>{messages.push(message);return {ok:true};}},storage:{local:{set:async()=>{}}}};
 sandbox.getComputedStyle=element=>({display:'block',visibility:'visible',opacity:'1',...element?._computed});
 vm.createContext(sandbox);vm.runInContext(source.replace('  boot();','  globalThis.api={discoverCandidates,hashText,privateRoute,isDemo,mayAutoBrowse,schedule,mediaContext,mediaAdvanceGate,autoBrowseTick,effectiveAutoBrowse,stopOnSignal,setMediaState:state=>{mediaState=state;},prepareBrowse:()=>{settings.autoBrowseEnabled=true;browseReady=true;}};'),sandbox);return {api:sandbox.api,queried,delays,scrolls,messages,advance:milliseconds=>{now+=milliseconds;}};
}
test('Instagram feed never falls back to scanning the whole document',()=>{const {api,queried}=setup();assert.equal(api.discoverCandidates().length,0);assert.deepEqual(queried,['article','[aria-label="Video player"]']);});
test('single Instagram post allows a caption fallback only',()=>{const {api,queried}=setup({path:'/p/example/'});api.discoverCandidates();assert.ok(queried.some(selector=>selector.includes('main h1')));assert.ok(!queried.includes('body'));});
test('demo selector is enabled only on the exact local demo path',()=>{assert.equal(setup({origin:'https://www.instagram.com',path:'/demo-feed',demo:true}).api.isDemo,false);assert.equal(setup({origin:'http://127.0.0.1:4310',path:'/demo-feed',demo:true}).api.isDemo,true);assert.equal(setup({origin:'http://127.0.0.1:4310',path:'/',demo:true}).api.isDemo,false);});
test('private messages are excluded and text fingerprints distinguish locale/content',()=>{assert.equal(setup({path:'/direct/inbox/'}).api.privateRoute(),true);const {api}=setup();assert.equal(api.hashText('same'),api.hashText('same'));assert.notEqual(api.hashText('ru|caption'),api.hashText('kk|caption'));});

function publicPost({canonical='https://www.instagram.com/kz.giveaways/p/CO1YPXSH4TF/',owner='kz.giveaways',comment=false,hidden=false,controls=false,extraSibling=false}={}){
 const base={isConnected:true,hidden:false,closest:()=>null,hasAttribute:()=>false,getAttribute:()=>null};
 const root={...base,tagName:'DIV',parentElement:null};
 const time={closest:()=>comment?{tagName:'A'}:null};
 const caption={...base,tagName:'SPAN',parentElement:root,querySelector:()=>controls?{}:null,getBoundingClientRect:()=>({width:500,height:hidden?0:150,top:100,bottom:250,left:20,right:520})};
 const header={...base,tagName:'DIV',parentElement:root,nextElementSibling:caption,querySelectorAll:()=>[time]};
 const link={...base,parentElement:header,getAttribute:()=>`/${owner}/`};
 root.children=[header,caption,...(extraSibling?[{...base}]:[])];
 return {canonical,links:[link],caption,root};
}
test('logged-out public post finds visible caption beside owner header without article/h1',()=>{
 const fixture=publicPost();const {api}=setup({path:'/p/CO1YPXSH4TF/',fixture});const candidates=api.discoverCandidates();assert.equal(candidates.length,1);assert.equal(candidates[0].caption,fixture.caption);assert.equal(candidates[0].root,fixture.root);
});
test('public caption supports username-prefixed single-post route',()=>{
 const fixture=publicPost();assert.equal(setup({path:'/kz.giveaways/p/CO1YPXSH4TF/',fixture}).api.discoverCandidates().length,1);
});
test('an unrelated article does not suppress the current public-post caption',()=>{
 const fixture=publicPost();const otherCaption={closest:()=>null};fixture.articles=[{querySelector:()=>otherCaption,closest:()=>null}];const candidates=setup({path:'/p/CO1YPXSH4TF/',fixture}).api.discoverCandidates();assert.equal(candidates.length,2);assert.ok(candidates.some(item=>item.caption===fixture.caption));
});
test('public fallback rejects comments, hidden captions, unrelated UI and metadata mismatch',()=>{
 for(const options of [{comment:true},{hidden:true},{controls:true},{extraSibling:true},{owner:'different.user'},{canonical:'https://www.instagram.com/kz.giveaways/p/DIFFERENT/'},{canonical:'https://evil.test/kz.giveaways/p/CO1YPXSH4TF/'}]){
  const fixture=publicPost(options);assert.equal(setup({path:'/p/CO1YPXSH4TF/',fixture}).api.discoverCandidates().length,0,JSON.stringify(options));
 }
});
test('public fallback never runs on feeds, profiles or comment permalink routes',()=>{
 for(const path of ['/','/kz.giveaways/','/p/CO1YPXSH4TF/c/123/'])assert.equal(setup({path,fixture:publicPost()}).api.discoverCandidates().length,0,path);
});

function reelPlayer({hidden=false,controls=false,ambiguous=false,nested=false,siblingVideo=false,sharedVideo=false,tooFarVideo=false}={}){
 const base={isConnected:true,hidden:false,closest:()=>null,getAttribute:()=>null};
 const anchor={...base,parentElement:null};
 const root={...base,parentElement:null,querySelector:()=>siblingVideo?null:({tagName:'VIDEO'})};
 if(siblingVideo){const media={...base,parentElement:null,querySelector:()=>({tagName:'VIDEO'}),querySelectorAll:()=>sharedVideo?[root,{}]:[root]};const branch={...base,parentElement:media,querySelector:()=>null,querySelectorAll:()=>[root]};root.parentElement=tooFarVideo?{...base,parentElement:branch,querySelector:()=>null,querySelectorAll:()=>[root]}:branch;}
 const caption={...base,parentElement:root,getBoundingClientRect:()=>({width:400,height:hidden?0:80,top:300,bottom:380,left:20,right:420}),closest:selector=>selector==='[aria-label="Video player"]'?(nested?{}:root):selector==='[role="button"]'?anchor:null,querySelector:selector=>selector==='span'?{}:controls?{}:null};
 root.querySelectorAll=()=>ambiguous?[caption,{...caption}]:[caption];
 return {root,caption,anchor};
}
test('Reels feed captures one visible caption within its own video player',()=>{
 const player=reelPlayer();const {api}=setup({path:'/reels/DemrlTbMLg0/',fixture:{players:[player.root]}});const candidates=api.discoverCandidates();assert.equal(candidates.length,1);assert.equal(candidates[0].caption,player.caption);assert.equal(candidates[0].root,player.root);assert.equal(candidates[0].anchor,player.anchor);
});
test('Reels overlay supports sibling video within a bounded single-player media container',()=>{
 const player=reelPlayer({siblingVideo:true});const candidates=setup({path:'/reels/DemrlTbMLg0/',fixture:{players:[player.root]}}).api.discoverCandidates();assert.equal(candidates.length,1);assert.equal(candidates[0].root,player.root);assert.equal(candidates[0].caption,player.caption);
});
test('Reels never borrows sibling video from multiple players or distant ancestors',()=>{
 for(const options of [{siblingVideo:true,sharedVideo:true},{siblingVideo:true,tooFarVideo:true}]){const player=reelPlayer(options);assert.equal(setup({path:'/reels/example/',fixture:{players:[player.root]}}).api.discoverCandidates().length,0,JSON.stringify(options));}
});
test('Reels skips hidden, ambiguous, nested-player and UI-containing candidates',()=>{
 for(const options of [{hidden:true},{controls:true},{ambiguous:true},{nested:true}]){const player=reelPlayer(options);assert.equal(setup({path:'/reels/example/',fixture:{players:[player.root]}}).api.discoverCandidates().length,0,JSON.stringify(options));}
});
test('automatic browsing requires opt-in, active visible Instagram feed and working analyzer',()=>{
 const {api}=setup();const allowed={enabled:true,scanEnabled:true,platform:'instagram',path:'/reels/example/',hidden:false,focused:true,offline:false,ready:true};assert.equal(api.mayAutoBrowse(allowed),true);assert.equal(api.mayAutoBrowse({...allowed,path:'/'}),true);
 for(const change of [{enabled:false},{scanEnabled:false},{platform:'tiktok'},{platform:'unknown'},{path:'/direct/inbox/'},{path:'/p/example/'},{path:'/reels/example/comments/'},{hidden:true},{focused:false},{offline:true},{ready:false}])assert.equal(api.mayAutoBrowse({...allowed,...change}),false,JSON.stringify(change));
});

test('TikTok automatic browsing allows only active visible public feed routes and retains every safety gate',()=>{
 const {api}=setup({origin:'https://www.tiktok.com'});const allowed={enabled:true,scanEnabled:true,platform:'tiktok',path:'/',hidden:false,focused:true,offline:false,ready:true};
 for(const path of ['/','/foryou','/foryou/','/following','/following/'])assert.equal(api.mayAutoBrowse({...allowed,path}),true,path);
 for(const path of ['/messages','/messages/','/messages/inbox','/@creator','/@creator/video/123','/search','/tag/casino','/reels/example/','/following/private','/settings','/login'])assert.equal(api.mayAutoBrowse({...allowed,path}),false,path);
 for(const change of [{enabled:false},{scanEnabled:false},{hidden:true},{focused:false},{offline:true},{ready:false}])assert.equal(api.mayAutoBrowse({...allowed,...change}),false,JSON.stringify(change));
});

test('TikTok browse tick scrolls the visible video container, never another hidden feed or a page control',()=>{
 const innerScrolls=[];
 const container={parentElement:null,hidden:false,getAttribute:()=>null,_computed:{overflowY:'auto'},scrollHeight:2000,clientHeight:700,scrollBy:options=>innerScrolls.push(options)};
 const visibleVideo=videoFixture({top:10,left:10,right:410,bottom:610,width:400,height:600},{parentElement:container});
 const hiddenVideo=videoFixture({top:1000,left:10,right:410,bottom:1600,width:400,height:600});
 const {api,queried,scrolls}=setup({origin:'https://www.tiktok.com',path:'/foryou',fixture:{videos:[hiddenVideo,visibleVideo]}});
 api.prepareBrowse();api.autoBrowseTick();
 assert.equal(innerScrolls.length,1);assert.equal(innerScrolls[0].top,455);assert.equal(innerScrolls[0].behavior,'smooth');assert.equal(scrolls.length,0);
 assert.deepEqual(queried,['video']);
});
test('continuous scroll or mutation events cannot postpone discovery beyond 1500ms',()=>{
 const {api,delays,advance}=setup();api.schedule();assert.equal(delays.at(-1),450);advance(1200);api.schedule();assert.equal(delays.at(-1),300);advance(400);api.schedule();assert.equal(delays.at(-1),0);
});

function videoFixture(rect,extra={}) { return {isConnected:true,parentElement:null,hidden:false,getAttribute:()=>null,getBoundingClientRect:()=>rect,currentTime:7.25,paused:false,muted:true,volume:0,...extra}; }
test('media capture refuses private, hidden and unfocused pages before reading video geometry',()=>{
 for(const options of [{path:'/direct/inbox/'},{path:'/messages/'},{hidden:true},{focused:false}]){
  const {api,queried}=setup(options);assert.equal(api.mediaContext().ok,false);assert.ok(!queried.includes('video'));
 }
});
test('media capture bounds its crop to visible viewport and selects largest visible video',()=>{
 const small=videoFixture({top:0,left:0,right:100,bottom:100,width:100,height:100});
 const large=videoFixture({top:-40,left:300,right:1100,bottom:850,width:800,height:890});
 const offscreen=videoFixture({top:1000,left:0,right:900,bottom:1700,width:900,height:700});
 const {api}=setup({path:'/reels/real/',fixture:{videos:[small,offscreen,large]}});const context=api.mediaContext();
 assert.equal(context.ok,true);assert.deepEqual(JSON.parse(JSON.stringify(context.rect)),{x:300,y:0,width:700,height:800});assert.equal(context.url,'https://www.instagram.com/reels/real/');assert.equal(context.mediaTime,7.25);assert.equal(context.muted,true);
});
test('missing or tiny video has no media capture target',()=>{
 assert.equal(setup().api.mediaContext().reason,'no-video');
 const video=videoFixture({top:10,left:10,right:50,bottom:50,width:40,height:40});assert.equal(setup({fixture:{videos:[video]}}).api.mediaContext().ok,false);
});
test('same-route recycled video source receives a new media identity',()=>{
 const video=videoFixture({top:0,left:0,right:400,bottom:600,width:400,height:600},{currentSrc:'https://cdn.example/first.mp4',duration:8});
 const {api}=setup({fixture:{videos:[video]}});const first=api.mediaContext();assert.equal(first.mediaId,api.mediaContext().mediaId);
 video.currentSrc='https://cdn.example/next.mp4';assert.notEqual(first.mediaId,api.mediaContext().mediaId);assert.equal(api.mediaContext().duration,8);
});
test('tab audio is never attributed when multiple players or a different offscreen player are audible',()=>{
 const a=videoFixture({top:0,left:0,right:400,bottom:600,width:400,height:600},{muted:false,volume:1});
 const b=videoFixture({top:1000,left:0,right:400,bottom:1600,width:400,height:600},{muted:false,volume:1});
 const {api}=setup({fixture:{videos:[a,b]}});assert.equal(api.mediaContext().reason,'ambiguous-audio');a.muted=true;assert.equal(api.mediaContext().reason,'ambiguous-audio');
});

test('autoscroll waits for three evaluated frames and speech rather than passing a slow model after32seconds',()=>{
 const {api}=setup();const current={ok:true,url:'https://www.instagram.com/reels/sample/',mediaId:'video-a'};
 const state={active:true,...current,coverage:{since:1000,frame:{status:'running',completedCount:0},audio:{status:'complete'}},pending:['frame']};
 assert.equal(api.mediaAdvanceGate(state,current,120000,1000).ready,false);
 for(const count of [0,1,2])assert.equal(api.mediaAdvanceGate({...state,pending:[],coverage:{...state.coverage,frame:{status:'complete',completedCount:count}}},current,120000,1000).ready,false);
 const framesDone={...state,pending:[],coverage:{...state.coverage,frame:{status:'complete',completedCount:3}}};
 assert.equal(api.mediaAdvanceGate(framesDone,current,120000,1000).ready,true);
 assert.equal(api.mediaAdvanceGate({...framesDone,coverage:{...framesDone.coverage,audio:{status:'running'}}},current,120000,1000).ready,false);
 assert.equal(api.mediaAdvanceGate({...framesDone,coverage:{...framesDone.coverage,audio:{status:'unavailable',reason:'muted'}}},current,120000,1000).ready,true);
});

test('autoscroll cannot reuse coverage from an old media identity, and timeout is explicitly incomplete',()=>{
 const {api}=setup();const current={ok:true,url:'https://www.instagram.com/',mediaId:'next-video'};
 const state={active:true,url:current.url,mediaId:'old-video',coverage:{since:1000,frame:{status:'complete',completedCount:3},audio:{status:'complete'}},pending:[]};
 assert.equal(api.mediaAdvanceGate(state,current,500000,1000).ready,false);
 const pending={...state,mediaId:current.mediaId,pending:['frame'],coverage:{...state.coverage,frame:{status:'running'}}};
 const expired=api.mediaAdvanceGate(pending,current,241000,1000);
 assert.equal(expired.ready,true);assert.equal(expired.incomplete,true);
 assert.equal(api.mediaAdvanceGate({...pending,paused:true,reason:'inactive'},current,500000,1000).ready,false);
 assert.equal(api.mediaAdvanceGate({...pending,paused:true,reason:'no-video'},{ok:false,reason:'no-video'},500000,1000).incomplete,true);
});

test('risk detection cancels the one-click sessions scroll even when manual scrolling was never enabled',()=>{
 const {api,messages}=setup();assert.equal(api.effectiveAutoBrowse(),false);
 api.setMediaState({active:true,autoBrowse:true,sessionId:'capture-one'});assert.equal(api.effectiveAutoBrowse(),true);
 api.stopOnSignal();assert.equal(api.effectiveAutoBrowse(),false);
 assert.equal(messages.length,1);assert.equal(messages[0].type,'SAFENET_MEDIA_BROWSE_STOP');assert.equal(messages[0].sessionId,'capture-one');
 api.setMediaState({active:false,autoBrowse:true,sessionId:'capture-one'});assert.equal(api.effectiveAutoBrowse(),false);
});

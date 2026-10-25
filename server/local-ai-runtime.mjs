import {existsSync,mkdirSync,openSync,closeSync} from 'node:fs';
import {resolve} from 'node:path';
import {spawn} from 'node:child_process';

export async function ensureLocalAiRuntime(){
  const endpoint='http://127.0.0.1:11434/api/version';
  const ready=async()=>{try{return (await fetch(endpoint,{signal:AbortSignal.timeout(1200)})).ok;}catch{return false;}};
  if(await ready())return {available:true,started:false};
  const executable=resolve('data/runtime/ollama/ollama.exe');
  if(process.platform!=='win32'||!existsSync(executable))return {available:false,started:false};
  mkdirSync(resolve('data/models/ollama'),{recursive:true});
  const log=openSync(resolve('data/runtime/ollama-server.log'),'a');
  const child=spawn(executable,['serve'],{windowsHide:true,detached:true,stdio:['ignore',log,log],env:{...process.env,
    OLLAMA_HOST:'127.0.0.1:11434',OLLAMA_MODELS:resolve('data/models/ollama'),OLLAMA_NO_CLOUD:'1',
    OLLAMA_NUM_PARALLEL:'1',OLLAMA_MAX_LOADED_MODELS:'1',OLLAMA_CONTEXT_LENGTH:'4096'}});
  closeSync(log);child.on('error',()=>{});child.unref();
  for(let attempt=0;attempt<20;attempt++){if(await ready())return {available:true,started:true};await new Promise(resolve=>setTimeout(resolve,250));}
  return {available:false,started:true};
}

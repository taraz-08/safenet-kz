import express from 'express';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadEnvFile } from 'node:process';
import { createApp } from './app.mjs';
import { ensureLocalAiRuntime } from './local-ai-runtime.mjs';

if(existsSync(resolve('.env')))loadEnvFile(resolve('.env'));
// The web app stays reachable while the GPU runtime performs its cold start.
void ensureLocalAiRuntime().catch(()=>console.error('Local AI runtime could not start; see the AI status panel.'));
const app=createApp();
app.locals.watchtower.start();
// Automatic screening starts with the server: the demo stream is replayed once, humans only review the queue.
app.locals.pipeline.start();
// Discovery of real public Telegram channels runs continuously while the server is up.
app.locals.discovery.start();
app.locals.social.start();
if(app.locals.watchtower.snapshot().enabled)void app.locals.watchtower.run().catch(error=>console.error('Watchtower:',error.code||'START_FAILED'));
const port=Number(process.env.PORT||4310);
app.get('/demo-feed',(_req,res)=>res.sendFile(resolve('public/demo-feed.html')));
app.get('/demo/content.js',(_req,res)=>res.sendFile(resolve('extension/content.js')));
app.get('/pitch',(_req,res)=>res.sendFile(resolve('docs/pitch.html')));
if(process.argv.includes('--dev')){
  const {createServer}=await import('vite');
  const vite=await createServer({server:{middlewareMode:true},appType:'spa'});
  app.use(vite.middlewares);
}else{
  const dist=resolve('dist');
  if(!existsSync(resolve(dist,'index.html')))throw new Error('Build the frontend first: npm run build');
  app.use(express.static(dist));
  app.get('/{*path}',(req,res)=>/\.[a-z0-9]+$/i.test(req.path)?res.sendStatus(404):res.sendFile(resolve(dist,'index.html')));
}
const server=app.listen(port,'127.0.0.1',()=>console.log(`SafeNet KZ ready at http://127.0.0.1:${port}`));
server.on('error',error=>{console.error(error.code==='EADDRINUSE'?`Port ${port} is in use. Open http://127.0.0.1:${port} or set PORT.`:error);process.exit(1);});
async function shutdown(){app.locals.watchtower.close();app.locals.pipeline.close();app.locals.discovery.close();app.locals.social.close();app.locals.aiService.close();server.close();await app.locals.mediaService?.close();process.exit(0);}
process.once('SIGTERM',shutdown);process.once('SIGINT',shutdown);

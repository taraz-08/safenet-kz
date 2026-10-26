import express from 'express';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadEnvFile } from 'node:process';
import { createApp } from './app.mjs';
import { parseTelegramSeeds } from './discovery.mjs';
import { ensureLocalAiRuntime } from './local-ai-runtime.mjs';

if(existsSync(resolve('.env')))loadEnvFile(resolve('.env'));
const telegramSeeds=parseTelegramSeeds(process.env.SAFENET_TELEGRAM_SEEDS);
const socialEnabledValue=process.env.SAFENET_SOCIAL_ENABLED;
if(socialEnabledValue!==undefined&&!['0','1'].includes(socialEnabledValue))throw new Error('SAFENET_SOCIAL_ENABLED must be 1 or 0, or unset to preserve the saved setting.');
const socialEnabled=socialEnabledValue===undefined?undefined:socialEnabledValue==='1';
// The web app stays reachable while the GPU runtime performs its cold start.
void ensureLocalAiRuntime().catch(()=>console.error('Local AI runtime could not start; see the AI status panel.'));
// On Railway (or with SAFENET_HOSTED=1) the server listens publicly; SAFENET_ACCESS_KEY puts the whole site behind a password.
const hosted=Boolean(process.env.RAILWAY_ENVIRONMENT)||process.env.SAFENET_HOSTED==='1';
// Genuine findings only, locally as on the hosted site; editing stays local. SAFENET_LIVE_ONLY=0 brings back the
// demo cases and the synthetic stream for development on this computer.
const liveOnlyValue=process.env.SAFENET_LIVE_ONLY;
if(liveOnlyValue!==undefined&&!['0','1'].includes(liveOnlyValue))throw new Error('SAFENET_LIVE_ONLY must be 1 or 0, or unset.');
const liveOnly=hosted||liveOnlyValue!=='0';
const allowedHosts=[process.env.RAILWAY_PUBLIC_DOMAIN,...String(process.env.SAFENET_ALLOWED_HOSTS||'').split(',')].map(value=>String(value||'').trim().toLowerCase()).filter(Boolean);
// Keep mutable state on a volume without hiding the bundled model, corpus and metrics.
const dataDir=resolve(process.env.SAFENET_DATA_DIR||process.env.RAILWAY_VOLUME_MOUNT_PATH||'data');
const app=createApp({storePath:resolve(dataDir,'cases.json'),hosted,liveOnly,allowedHosts,accessKey:process.env.SAFENET_ACCESS_KEY||null,adminCode:process.env.SAFENET_ADMIN_CODE||null,telegramSeeds,socialEnabled});
app.locals.watchtower.start();
// Synthetic replay is available only in local/offline mode.
if(!app.locals.liveOnly)app.locals.pipeline.start();
// Discovery of real public Telegram channels runs continuously while the server is up.
app.locals.discovery.start();
app.locals.social.start();
if(app.locals.watchtower.snapshot().enabled)void app.locals.watchtower.run().catch(error=>console.error('Watchtower:',error.code||'START_FAILED'));
const port=Number(process.env.PORT||4310);
// createApp rejects these demo-only routes (including /demo-feed.html in dist) in liveOnly mode.
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
const bindHost=process.env.HOST||(hosted?'0.0.0.0':'127.0.0.1');
const server=app.listen(port,bindHost,()=>console.log(`SafeNet KZ ready at http://${bindHost}:${port} (${hosted?(process.env.SAFENET_ACCESS_KEY?'hosted, password':'hosted, read-only'):liveOnly?'local, live only':'local'})`));
server.on('error',error=>{console.error(error.code==='EADDRINUSE'?`Port ${port} is in use. Open http://127.0.0.1:${port} or set PORT.`:error);process.exit(1);});
async function shutdown(){app.locals.watchtower.close();app.locals.pipeline.close();app.locals.discovery.close();app.locals.social.close();app.locals.aiService.close();server.close();await app.locals.mediaService?.close();process.exit(0);}
process.once('SIGTERM',shutdown);process.once('SIGINT',shutdown);

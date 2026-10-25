// Isolated visual fixture for inspecting the real loading and empty states.
// No user case database is read or written.
import express from 'express';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createApp} from '../server/app.mjs';
const temp=mkdtempSync(join(tmpdir(),'safenet-preview-'));
const preview=express();
preview.use('/api/cases',(req,res,next)=>setTimeout(next,8000));
preview.use(createApp({storePath:join(temp,'cases.json'),seed:false}));
preview.use(express.static(resolve('dist')));
preview.get('/',(_req,res)=>res.sendFile(resolve('dist/index.html')));
const server=preview.listen(4311,'127.0.0.1',()=>console.log('Isolated loading/empty QA fixture: http://127.0.0.1:4311'));
process.on('SIGINT',()=>server.close(()=>{rmSync(temp,{recursive:true,force:true});process.exit(0);}));

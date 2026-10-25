import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createMediaService as createService, validateMediaInput, publicMediaUrl, MediaError } from './media.mjs';
const createMediaService = options => createService({ decodeQr: async () => ({ qr: [], available: true }), ...options });

const frame = { kind:'frame', data:readFileSync(new URL('../qa/ocr-fixture.png',import.meta.url)).toString('base64'), mimeType:'image/png',
  url:'https://www.instagram.com/reels/Abc123/?utm_source=test#tracking', platform:'instagram', locale:'kk',startMs:1000,endMs:1000 };
const wav = Buffer.alloc(44); wav.write('RIFF');wav.writeUInt32LE(36,4);wav.write('WAVEfmt ',8);wav.writeUInt32LE(16,16);
wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);wav.writeUInt32LE(16000,24);wav.writeUInt32LE(32000,28);wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);wav.write('data',36);
const audio = {...frame,kind:'audio',data:wav.toString('base64'),mimeType:'audio/wav',startMs:10000,endMs:20000};

test('media validates public sources, excludes private routes and strips tracking',()=>{
  assert.equal(validateMediaInput(frame).url,'https://www.instagram.com/reels/Abc123/');
  assert.equal(publicMediaUrl('https://www.tiktok.com/@author/video/123','tiktok').platform,'tiktok');
  for(const url of ['http://www.instagram.com/p/id/','https://instagram.com.attacker.test/p/id/',
    'https://www.instagram.com/direct/inbox/','https://www.instagram.com/%64irect/reels/id/',
    'https://www.instagram.com/accounts/login/','https://www.instagram.com/stories/author/',
    'https://www.tiktok.com/messages','https://user:password@www.instagram.com/p/id/',
    'https://www.instagram.com:444/p/id/'])assert.throws(()=>validateMediaInput({...frame,url}),{code:'invalid_source'});
  assert.throws(()=>validateMediaInput({...frame,platform:'tiktok'}),{code:'invalid_source'});
});

test('media bounds payload bytes, declared format, pixel count and timestamps before processing',()=>{
  for(const data of ['', 'data:image/png;base64,AAAA','!!!!!!','YQ==\n'])assert.throws(()=>validateMediaInput({...frame,data}));
  assert.throws(()=>validateMediaInput({...frame,data:'A'.repeat(3*1024*1024)}),{code:'media_too_large'});
  assert.throws(()=>validateMediaInput({...frame,mimeType:'image/svg+xml'}),{code:'invalid_mime'});
  assert.throws(()=>validateMediaInput({...frame,mimeType:'image/jpeg'}),{code:'invalid_media'});
  const enormous=Buffer.from(frame.data,'base64');enormous.writeUInt32BE(100000,16);
  assert.throws(()=>validateMediaInput({...frame,data:enormous.toString('base64')}),{code:'invalid_dimensions'});
  for(const [startMs,endMs] of [[-1,100],[2,1],[0,86400001],[0.1,1],[0,2000]])
    assert.throws(()=>validateMediaInput({...frame,startMs,endMs}),{code:'invalid_timestamp'});
  assert.throws(()=>validateMediaInput({...audio,endMs:audio.startMs+30001}),{code:'invalid_timestamp'});
  assert.equal(validateMediaInput(audio).mimeType,'audio/wav');
});

test('recognized frame text becomes localized evidence without persistent case data',async()=>{
  const service=createMediaService({recognizeFrame:async()=>({text:'MOSTBET промокод BONUS. Регистрируйся и пополни депозит.'})});
  try {
    const result=await service.scan(frame);
    assert.equal(result.stored,false);assert.equal(result.ok,true);assert.ok(result.analysis.score>=60);
    assert.equal(result.evidence[0].kind,'frame');assert.equal(result.evidence[0].startMs,1000);
    assert.ok(result.analysis.signals.some(signal=>signal.id==='casino_mention'));
    assert.match(result.analysis.limitations[2],/кадрдан/);
  } finally {await service.close();}
});

test('speech segments retain offset timestamps and silence does not fabricate evidence',async()=>{
  const service=createMediaService({transcribeAudio:async()=>({text:'Казино. Промокод.',language:'ru',segments:[{text:'Казино.',startMs:200,endMs:1700},{text:'Промокод.',startMs:2000,endMs:3000}]})});
  try {
    const result=await service.scan({...audio,locale:'ru'});
    assert.deepEqual(result.evidence.map(({startMs,endMs})=>[startMs,endMs]),[[10200,11700],[12000,13000]]);
    assert.equal(result.language,'ru');assert.equal(result.evidence[0].kind,'audio');
    assert.match(result.analysis.limitations[2],/распознанные/);
  }finally{await service.close();}
  const silent=createMediaService({transcribeAudio:async()=>({text:'',segments:[]})});
  try{const result=await silent.scan(audio);assert.deepEqual(result.evidence,[]);assert.equal(result.analysis.score,0);}finally{await silent.close();}
});

test('one job runs at a time and excess queued work is rejected',async()=>{
  let release, calls=0;
  const blocked=new Promise(resolve=>{release=resolve;});
  const service=createMediaService({maxQueued:1,recognizeFrame:async()=>{calls++;await blocked;return{text:'Казино'};}});
  try {
    const first=service.scan(frame), second=service.scan(frame);
    assert.equal(calls,1);
    assert.throws(()=>service.scan(frame),{code:'media_busy',status:429});
    release();await Promise.all([first,second]);assert.equal(calls,2);
  }finally{await service.close();}
});

test('missing runtime/model and timeout failures stay explicit',async()=>{
  const missing=createMediaService({transcribeAudio:async()=>{throw new MediaError('model_missing',503);}});
  try{await assert.rejects(missing.scan(audio),{code:'model_missing',status:503});}finally{await missing.close();}
  const timeout=createMediaService({jobTimeoutMs:10,recognizeFrame:()=>new Promise(()=>{})});
  try{await assert.rejects(timeout.scan(frame),{code:'media_timeout',status:504});}finally{await timeout.close();}
});

test('QR findings keep a distinct evidence source and do not open decoded URLs', async () => {
  const text = 'https://casino.example/bonus';
  const service = createMediaService({ recognizeFrame: async () => ({ text: '' }), decodeQr: async () => ({ qr: [{ text, format: 'QR_CODE' }], available: true }) });
  try {
    const result = await service.scan(frame);
    assert.equal(result.evidence.length, 1);
    assert.equal(result.evidence[0].kind, 'qr');
    assert.equal(result.evidence[0].text, text);
    assert.equal(result.evidence[0].startMs, 1000);
    assert.equal(result.coverage.qr.checked, true);
    assert.equal(result.coverage.visualObjects, false);
    assert.ok(result.analysis.entities.domains.includes('casino.example'));
  } finally { await service.close(); }
});

test('QR unavailable is partial coverage and preserves successful OCR results', async () => {
  const service = createMediaService({ recognizeFrame: async () => ({ text: 'Промокод казино!' }), decodeQr: async () => { throw new MediaError('qr_unavailable', 503); } });
  try {
    const result = await service.scan(frame);
    assert.equal(result.coverage.qr.checked, false);
    assert.equal(result.coverage.qr.reason, 'qr_unavailable');
    assert.ok(result.analysis.score > 0);
    assert.equal(result.evidence[0].kind, 'frame');
  } finally { await service.close(); }
});

function modelResult(overrides = {}) {
  return { ok: true, status: 'completed', provider: 'ollama', mode: 'local', model: 'qwen3-vl:2b-instruct',
    category: 'gambling', promotional: true, context: 'promotion', summary: 'Видно игровое предложение.',
    risk: { score: 60, level: 'high', isHeuristic: true },
    observations: [{ modality: 'visual', kind: 'slot_machine', quote: '', description: 'В кадре видны барабаны игрового автомата и кнопка внесения денег.' }],
    limitations: ['Не доказательство нарушения.'], ...overrides };
}

test('visual-only finding is saveable but generated description never enters text rule engine', async () => {
  let received;
  const ai = modelResult({ observations: [{ modality: 'visual', kind: 'slot_machine', quote: '', description: 'Модель предполагает казино, сайт https://invented.example и гарантированный доход.' }] });
  const service = createMediaService({ recognizeFrame: async () => ({ text: '' }), aiService: { analyze: async input => { received = input; return ai; } } });
  try {
    const result = await service.scan({ ...frame, locale: 'ru' });
    assert.equal(result.recognizedText, ''); assert.equal(result.sourceText, '');
    assert.match(result.text, /^\[AI inference \/ AI тұжырымы\]/);
    assert.equal(result.analysis.score, 60); assert.equal(result.analysis.category, 'casino');
    assert.deepEqual(result.analysis.signals.map(item => item.id), ['local_model_observation']);
    assert.equal(result.analysis.signals[0].quote, ''); assert.equal(result.analysis.signals[0].method, 'model_inference');
    assert.deepEqual(result.analysis.entities.domains, ['www.instagram.com']);
    assert.equal(result.analysis.ai.model, 'qwen3-vl:2b-instruct');
    assert.equal(result.evidence[0].kind, 'vision'); assert.equal(result.evidence[0].method, 'model_inference');
    assert.equal(result.evidence[0].startMs, frame.startMs); assert.equal(result.coverage.visualObjects, true);
    assert.equal(received.frameBase64, frame.data); assert.equal(received.caption, ''); assert.equal(received.locale, 'ru');
    assert.match(result.analysis.summary, /Локальная ИИ-модель/);
    assert.match(result.analysis.translations.kk.summary, /Жергілікті ЖИ/);
    assert.match(result.analysis.translations.ru.limitations[2], /Остальные части видео не проверены/);
  } finally { await service.close(); }
});

test('AI unavailable preserves actual OCR rule findings and reports incomplete visual coverage', async () => {
  const text = 'MOSTBET промокод BONUS. Регистрируйся и пополни депозит.';
  const baseline = createMediaService({ recognizeFrame: async () => ({ text }) });
  const service = createMediaService({ recognizeFrame: async () => ({ text }), aiService: { analyze: async () => ({ ok: false, status: 'model_missing', reason: 'model_missing', observations: [] }) } });
  try {
    const original = await baseline.scan(frame), result = await service.scan(frame);
    assert.equal(result.analysis.score, original.analysis.score);
    assert.deepEqual(result.analysis.signals, original.analysis.signals);
    assert.equal(result.coverage.visualObjects, false); assert.equal(result.ai.reason, 'model_missing');
    assert.equal(result.analysis.ai.reason, 'model_missing'); assert.equal(result.text, text);
    assert.equal(result.evidence[0].kind, 'frame');
  } finally { await baseline.close(); await service.close(); }
});

test('successful AI never reduces existing rule score or changes original evidence quotes', async () => {
  const text = 'MOSTBET промокод BONUS. Регистрируйся и пополни депозит.';
  const baseline = createMediaService({ recognizeFrame: async () => ({ text }) });
  const service = createMediaService({ recognizeFrame: async () => ({ text }), aiService: { analyze: async () => modelResult({ category: 'none', promotional: false, context: 'uncertain', observations: [], risk: { score: 0 } }) } });
  try {
    const original = await baseline.scan(frame), result = await service.scan(frame);
    assert.equal(result.analysis.score, original.analysis.score);
    assert.deepEqual(result.analysis.signals, original.analysis.signals);
    assert.equal(result.analysis.category, original.analysis.category);
    assert.equal(result.coverage.visualObjects, true);
  } finally { await baseline.close(); await service.close(); }
});

test('speech AI analyzes recognized words while retaining verbatim segments and timestamps', async () => {
  let received;
  const text = 'Отправьте секретный код из SMS.';
  const service = createMediaService({ transcribeAudio: async () => ({ text, language: 'ru', segments: [{ text, startMs: 200, endMs: 1500 }] }),
    aiService: { analyze: async input => { received = input; return modelResult({ category: 'phishing', risk: { score: 70 }, observations: [{ modality: 'transcript', kind: 'credential_request', description: 'Запрос кода.', quote: 'секретный код' }] }); } } });
  try {
    const result = await service.scan({ ...audio, locale: 'ru' });
    assert.deepEqual(received, { transcript: text, locale: 'ru' });
    assert.equal(result.text, text); assert.equal(result.recognizedText, text);
    assert.deepEqual(result.evidence, [{ kind: 'audio', text, startMs: 10200, endMs: 11500 }]);
    assert.equal(result.coverage.aiTranscript, true); assert.equal(result.coverage.visualObjects, false);
    assert.equal(result.analysis.category, 'phishing'); assert.ok(result.analysis.score >= 70);
  } finally { await service.close(); }
});

test('silent audio does not ask AI to invent a transcript and retains no evidence', async () => {
  let calls = 0;
  const service = createMediaService({ transcribeAudio: async () => ({ text: '', segments: [] }), aiService: { analyze: async () => { calls++; return modelResult(); } } });
  try {
    const result = await service.scan(audio);
    assert.equal(calls, 0); assert.equal(result.ai.reason, 'no_transcript');
    assert.equal(result.analysis.score, 0); assert.deepEqual(result.evidence, []);
    assert.equal(result.coverage.aiTranscript, false);
  } finally { await service.close(); }
});

test('frame AI can continue when OCR is unavailable without claiming text was recognized', async () => {
  const service = createMediaService({ recognizeFrame: async () => { throw new MediaError('ocr_missing', 503); }, aiService: { analyze: async () => modelResult() } });
  try {
    const result = await service.scan(frame);
    assert.equal(result.ok, true); assert.equal(result.coverage.text, false); assert.equal(result.coverage.textReason, 'ocr_missing');
    assert.equal(result.coverage.visualObjects, true); assert.equal(result.evidence[0].kind, 'vision');
  } finally { await service.close(); }
});

test('timed-out media job cannot start delayed AI work after recognition resolves', async () => {
  let release, calls = 0;
  const delayed = new Promise(resolve => { release = resolve; });
  const service = createMediaService({ jobTimeoutMs: 10, recognizeFrame: () => delayed, aiService: { analyze: async () => { calls++; return modelResult(); } } });
  try {
    await assert.rejects(service.scan(frame), { code: 'media_timeout' });
    release({ text: 'Казино' }); await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls, 0);
  } finally { await service.close(); }
});

test('timed-out active AI is cancelled and later jobs can still proceed', async () => {
  let cancelCalls = 0, calls = 0;
  const service = createMediaService({ jobTimeoutMs: 10, recognizeFrame: async () => ({ text: '' }), aiService: {
    analyze: async () => { calls++; return calls === 1 ? new Promise(() => {}) : modelResult(); }, cancel() { cancelCalls++; },
  } });
  try {
    await assert.rejects(service.scan(frame), { code: 'media_timeout' });
    assert.equal(cancelCalls, 1);
    const result = await service.scan(frame); assert.equal(result.coverage.visualObjects, true);
  } finally { await service.close(); }
});

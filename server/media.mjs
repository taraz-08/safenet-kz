import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { createWorker, PSM } from 'tesseract.js';
import { analyzeContent, localizeAnalysis } from './engine.mjs';
import { mergeAiAnalysis } from './ai-analysis.mjs';
import { AI_LIMITS } from './ai.mjs';

const FRAME_LIMIT = 1.5 * 1024 * 1024, AUDIO_LIMIT = 2 * 1024 * 1024;
const MAX_TIME = 24 * 60 * 60 * 1000;
export class MediaError extends Error {
  constructor(code, status = 400) { super(code); this.code = code; this.status = status; }
}

export function publicMediaUrl(value, suppliedPlatform) {
  if (typeof value !== 'string' || value.length > 2048) throw new MediaError('invalid_source');
  let url;
  try { url = new URL(value); } catch { throw new MediaError('invalid_source'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) throw new MediaError('invalid_source');
  const host = url.hostname.toLowerCase();
  const platform = ['instagram.com', 'www.instagram.com'].includes(host) ? 'instagram'
    : ['tiktok.com', 'www.tiktok.com'].includes(host) ? 'tiktok' : null;
  if (!platform || (suppliedPlatform && suppliedPlatform !== platform)) throw new MediaError('invalid_source');
  let path;
  try { path = decodeURIComponent(url.pathname); } catch { throw new MediaError('invalid_source'); }
  if (/^\/(?:direct|messages|accounts|settings|login|oauth)(?:\/|$)/i.test(path)) throw new MediaError('invalid_source');
  const publicPath = platform === 'instagram'
    ? /^\/(?:$|(?:reels|explore)\/?$|(?:[\w.]+\/)?(?:p|reel|reels)\/[\w-]+\/?$)/i.test(path)
    : /^\/(?:$|(?:foryou|following|explore)\/?$|@[\w.]+(?:\/video\/\d+)?\/?$)/i.test(path);
  if (!publicPath) throw new MediaError('invalid_source');
  url.search = ''; url.hash = '';
  return { url: url.href, platform };
}

function imageDimensions(bytes, mimeType) {
  if (mimeType === 'image/png') {
    if (bytes.length < 24 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      || bytes.toString('ascii', 12, 16) !== 'IHDR') throw new MediaError('invalid_media');
    return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
  }
  if (bytes.length < 4 || bytes[0] !== 255 || bytes[1] !== 216) throw new MediaError('invalid_media');
  let position = 2;
  while (position + 4 <= bytes.length) {
    if (bytes[position] !== 255) throw new MediaError('invalid_media');
    while (bytes[position] === 255) position++;
    const marker = bytes[position++];
    if (marker === 217 || marker === 218) break;
    if (marker === 1 || (marker >= 208 && marker <= 215)) continue;
    if (position + 2 > bytes.length) break;
    const length = bytes.readUInt16BE(position);
    if (length < 2 || position + length > bytes.length) break;
    if ([192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207].includes(marker)) {
      if (length < 7) break;
      return [bytes.readUInt16BE(position + 5), bytes.readUInt16BE(position + 3)];
    }
    position += length;
  }
  throw new MediaError('invalid_media');
}

export function validateMediaInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new MediaError('invalid_request');
  if (!['frame', 'audio'].includes(input.kind)) throw new MediaError('invalid_kind');
  const source = publicMediaUrl(input.url, input.platform);
  const { startMs, endMs } = input;
  if (![startMs, endMs].every(Number.isSafeInteger) || startMs < 0 || endMs < startMs || endMs > MAX_TIME
      || endMs - startMs > (input.kind === 'audio' ? 30000 : 1000)) throw new MediaError('invalid_timestamp');
  const mimeType = String(input.mimeType || '').toLowerCase().replace(/\s+/g, '');
  const allowed = input.kind === 'frame' ? ['image/jpeg', 'image/png']
    : ['audio/webm', 'audio/webm;codecs=opus', 'audio/ogg', 'audio/ogg;codecs=opus', 'audio/wav', 'audio/x-wav'];
  if (!allowed.includes(mimeType)) throw new MediaError('invalid_mime');
  const limit = input.kind === 'frame' ? FRAME_LIMIT : AUDIO_LIMIT;
  if (typeof input.data !== 'string') throw new MediaError('invalid_media');
  if (input.data.length > Math.ceil(limit / 3) * 4) throw new MediaError('media_too_large', 413);
  if (!input.data.length || input.data.length % 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(input.data)) throw new MediaError('invalid_media');
  const bytes = Buffer.from(input.data, 'base64');
  if (!bytes.length || bytes.length > limit) throw new MediaError('media_too_large', 413);
  if (bytes.toString('base64') !== input.data) throw new MediaError('invalid_media');
  if (input.kind === 'frame') {
    const [width, height] = imageDimensions(bytes, mimeType);
    if (!width || !height || width > 4096 || height > 4096 || width * height > 6000000) throw new MediaError('invalid_dimensions');
  } else {
    const valid = mimeType.includes('webm') ? bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))
      : mimeType.includes('ogg') ? bytes.toString('ascii', 0, 4) === 'OggS'
        : bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WAVE';
    if (!valid || endMs === startMs) throw new MediaError('invalid_media');
  }
  return { kind: input.kind, bytes, mimeType, ...source, startMs, endMs, locale: input.locale === 'ru' ? 'ru' : 'kk' };
}

class AudioWorker {
  constructor(modelPath, pythonCommand) { this.modelPath = modelPath; this.pythonCommand = pythonCommand; this.pending = new Map(); this.serial = 0; }
  async start() {
    if (this.starting) return this.starting;
    this.starting = new Promise((resolveReady, rejectReady) => {
      const child = spawn(this.pythonCommand, ['-u', resolve('server/media-worker.py'), this.modelPath], {
        windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
      });
      this.child = child;
      let ready = false;
      const timer = setTimeout(() => { rejectReady(new MediaError('audio_unavailable', 503)); this.close(); }, 20000);
      child.stderr.on('data', () => {}); // Libraries may log paths; media/errors stay out of server logs.
      const lines = createInterface({ input: child.stdout });
      lines.on('line', line => {
        let response;
        try { response = JSON.parse(line); } catch { return; }
        if (response.type === 'ready') { ready = true; clearTimeout(timer); this.lastStatus = response.status; resolveReady(response.status); return; }
        const waiter = this.pending.get(response.id);
        if (!waiter) return;
        this.pending.delete(response.id); clearTimeout(waiter.timer);
        if (response.status) this.lastStatus = response.status;
        if (response.ok) waiter.resolve(response);
        else waiter.reject(new MediaError(response.code || 'audio_failed', ['model_missing', 'dependency_unavailable'].includes(response.code) ? 503 : 422));
      });
      const stopped = () => {
        clearTimeout(timer); lines.close();
        if (!ready) rejectReady(new MediaError('audio_unavailable', 503));
        if (this.child !== child) return;
        for (const waiter of this.pending.values()) { clearTimeout(waiter.timer); waiter.reject(new MediaError('audio_unavailable', 503)); }
        this.pending.clear();
        if (this.child === child) { this.child = null; this.starting = null; }
      };
      child.on('error', stopped); child.on('exit', stopped);
    });
    return this.starting;
  }
  async request(type, payload = {}, timeoutMs = 150000) {
    await this.start();
    if (!this.child || !this.child.stdin.writable) throw new MediaError('audio_unavailable', 503);
    const id = ++this.serial;
    return new Promise((resolveResult, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new MediaError('media_timeout', 504)); this.close(); }, timeoutMs);
      this.pending.set(id, { resolve: resolveResult, reject, timer });
      this.child.stdin.write(JSON.stringify({ id, type, ...payload }) + '\n', error => {
        if (error) { clearTimeout(timer); this.pending.delete(id); reject(new MediaError('audio_unavailable', 503)); }
      });
    });
  }
  close() {
    for (const waiter of this.pending.values()) { clearTimeout(waiter.timer); waiter.reject(new MediaError('audio_unavailable', 503)); }
    this.pending.clear(); this.child?.kill(); this.child = null; this.starting = null;
  }
}

export function createMediaService({ modelPath = resolve('data/models/faster-whisper-small'), pythonCommand = process.env.SAFENET_PYTHON || 'python',
  recognizeFrame, transcribeAudio, decodeQr, aiService, jobTimeoutMs = 180000, maxQueued = 2 } = {}) {
  const audio = new AudioWorker(modelPath, pythonCommand);
  const ocrPath = resolve('public/ocr');
  let ocrWorker, ocrStarting, busy = false, closed = false, ocrGeneration = 0, activeAbort;
  const queue = [];
  const frameAvailable = () => ['eng', 'rus', 'kaz'].every(language => existsSync(resolve(ocrPath, language + '.traineddata.gz')));
  async function getOcr() {
    if (!frameAvailable()) throw new MediaError('ocr_missing', 503);
    if (!ocrStarting) {
      const generation = ocrGeneration;
      ocrStarting = createWorker(['eng', 'rus', 'kaz'], 1, { langPath: ocrPath, gzip: true, cacheMethod: 'none', logger: () => {}, errorHandler: () => {} })
        .then(async worker => {
          if (closed || generation !== ocrGeneration) { await worker.terminate(); throw new MediaError('media_unavailable', 503); }
          ocrWorker = worker; await worker.setParameters({ tessedit_pageseg_mode: PSM.SPARSE_TEXT }); return worker;
        })
        .catch(() => { if (generation === ocrGeneration) ocrStarting = null; throw new MediaError('ocr_failed', 503); });
    }
    return ocrStarting;
  }
  async function status() {
    const frame = { available: frameAvailable(), ready: frameAvailable(), loaded: !!ocrWorker, reason: frameAvailable() ? null : 'ocr_missing', languages: ['eng', 'rus', 'kaz'] };
    let audioState;
    try {
      if (busy && audio.lastStatus) audioState = audio.lastStatus;
      else audioState = (await audio.request('status', {}, 20000)).status;
    } catch (error) { audioState = { available: false, ready: false, reason: error.code || 'audio_unavailable', model: 'small', device: 'cpu', languages: ['ru', 'kk', 'en'] }; }
    const qr = audioState.qr || { available: false, reason: 'qr_unavailable', engine: 'OpenCV', scope: 'sampled_frame' };
    let ai;
    if (aiService) {
      try { ai = await aiService.status(); } catch { ai = { ok: false, available: false, vision: false, text: false, reason: 'runtime_unavailable', provider: 'ollama', mode: 'local' }; }
    }
    return { ok: true, frame, audio: audioState, qr, busy, queued: queue.length, ...(ai ? { ai } : {}) };
  }
  function ensureActive(signal) { if (closed || signal?.aborted) throw new MediaError(closed ? 'media_unavailable' : 'media_timeout', closed ? 503 : 504); }
  async function execute(input, context) {
    const { signal } = context.controller;
    let recognized, recognitionError = null;
    try {
      recognized = input.kind === 'frame'
        ? recognizeFrame ? await recognizeFrame(input.bytes) : (await (await getOcr()).recognize(input.bytes)).data
        : transcribeAudio ? await transcribeAudio(input.bytes) : await audio.request('transcribe', { data: input.bytes.toString('base64') }, jobTimeoutMs);
    } catch (error) {
      if (input.kind !== 'frame' || !aiService) throw error;
      recognitionError = ['ocr_missing', 'ocr_failed'].includes(error.code) ? error.code : 'ocr_failed';
      recognized = { text: '' };
    }
    ensureActive(signal);
    const recognizedText = String(recognized?.text || '').trim().slice(0, 10000);
    let qr = [], qrCoverage = { checked: false, reason: 'not_a_frame' };
    if (input.kind === 'frame') {
      try {
        const decoded = decodeQr ? await decodeQr(input.bytes)
          : await audio.request('decode_qr', { data: input.bytes.toString('base64') }, 20000);
        qr = (Array.isArray(decoded?.qr) ? decoded.qr : []).filter(item => typeof item?.text === 'string' && item.text.length > 0 && item.text.length <= 2048).slice(0, 8);
        qrCoverage = { checked: decoded?.available !== false, reason: decoded?.available === false ? 'qr_unavailable' : null };
      } catch (error) { qrCoverage = { checked: false, reason: error.code || 'qr_unavailable' }; }
    }
    const sourceText = [recognizedText, ...qr.map(item => item.text)].filter(Boolean).join('\n').slice(0, 30000);
    let text = sourceText;
    let analysis = localizeAnalysis(analyzeContent({ text: sourceText, url: input.url, platform: input.platform }), input.locale);
    const mediaNotes = {
      ru: 'Проверены распознанные слова из выбранного кадра или звукового фрагмента. Ошибки распознавания и пропущенные фрагменты возможны; визуальные объекты без текста не классифицируются.',
      kk: 'Таңдалған кадрдан немесе дыбыс үзіндісінен танылған сөздер тексерілді. Тану қателері мен өткізіп алынған бөліктер болуы мүмкін; мәтінсіз нысандар жіктелмейді.',
    };
    analysis.limitations = analysis.limitations.map((limitation, index) => index === 2 ? mediaNotes[input.locale] : limitation);
    for (const locale of ['ru', 'kk']) if (analysis.translations?.[locale]) {
      analysis.translations[locale].limitations = analysis.translations[locale].limitations.map((limitation, index) => index === 2 ? mediaNotes[locale] : limitation);
    }
    ensureActive(signal);
    let ai;
    if (aiService && (input.kind === 'frame' || recognizedText)) {
      context.aiActive = true;
      try {
        ai = await aiService.analyze(input.kind === 'frame'
          ? { frameBase64: input.bytes.toString('base64'), caption: recognizedText.slice(0, AI_LIMITS.captionChars), locale: input.locale }
          : { transcript: recognizedText, locale: input.locale });
      } catch { ai = { ok: false, status: 'runtime_unavailable', reason: 'runtime_unavailable', provider: 'ollama', mode: 'local', observations: [] }; }
      finally { context.aiActive = false; }
    } else if (aiService) ai = { ok: false, status: 'no_transcript', reason: 'no_transcript', provider: 'ollama', mode: 'local', observations: [] };
    ensureActive(signal);
    if (ai) {
      analysis = mergeAiAnalysis(analysis, ai, input.locale);
      if (!sourceText && ai.ok && ai.observations?.length) text = '[AI inference / AI тұжырымы]\n' + ai.observations.map(item => item.description).join('\n').slice(0, 3000);
    }
    const segments = input.kind === 'audio' && Array.isArray(recognized.segments) ? recognized.segments : null;
    const evidence = !sourceText ? [] : segments?.length ? segments.filter(segment => segment.text).map(segment => ({ kind: 'audio', text: String(segment.text).slice(0, 10000),
      startMs: Math.min(input.endMs, input.startMs + Math.max(0, Math.round(Number(segment.startMs) || 0))),
      endMs: Math.min(input.endMs, input.startMs + Math.max(0, Math.round(Number(segment.endMs) || 0))) }))
      : recognizedText ? [{ kind: input.kind, text: recognizedText, startMs: input.startMs, endMs: input.endMs }] : [];
    evidence.push(...qr.map(item => ({ kind: 'qr', text: item.text, startMs: input.startMs, endMs: input.endMs, format: 'QR_CODE' })));
    if (ai?.ok && input.kind === 'frame') evidence.push(...ai.observations.filter(item => item.modality === 'visual').map(item => ({ kind: 'vision', text: item.description, startMs: input.startMs, endMs: input.endMs, model: ai.model, method: 'model_inference' })));
    return { ok: true, text, recognizedText, sourceText, analysis, evidence, qr,
      coverage: { text: !recognitionError, textReason: recognitionError, qr: qrCoverage, visualObjects: !!ai?.ok && input.kind === 'frame', aiTranscript: !!ai?.ok && input.kind === 'audio' },
      ...(ai ? { ai } : {}), stored: false, language: recognized.language || null };
  }
  async function drain() {
    if (busy || !queue.length || closed) return;
    const job = queue.shift(); busy = true;
    const controller = new AbortController(); activeAbort = controller;
    const context = { controller, aiActive: false };
    let timeout, onAbort;
    try {
      const deadline = new Promise((_, reject) => {
        onAbort = () => { if (context.aiActive) aiService?.cancel?.(); reject(new MediaError(closed ? 'media_unavailable' : 'media_timeout', closed ? 503 : 504)); };
        controller.signal.addEventListener('abort', onAbort, { once: true });
        timeout = setTimeout(() => controller.abort(), jobTimeoutMs);
      });
      const outcome = await Promise.race([execute(job.input, context), deadline]);
      job.resolve(outcome);
    } catch (error) {
      if (error.code === 'media_timeout') { audio.close(); ocrGeneration++; await ocrWorker?.terminate(); ocrWorker = null; ocrStarting = null; }
      job.reject(error instanceof MediaError ? error : new MediaError(job.input.kind === 'audio' ? 'audio_failed' : 'ocr_failed', 422));
    } finally { clearTimeout(timeout); controller.signal.removeEventListener('abort', onAbort); if (activeAbort === controller) activeAbort = null; busy = false; drain(); }
  }
  function scan(raw) {
    const input = validateMediaInput(raw);
    if (closed) throw new MediaError('media_unavailable', 503);
    if (busy && queue.length >= maxQueued) throw new MediaError('media_busy', 429);
    return new Promise((resolveResult, reject) => { queue.push({ input, resolve: resolveResult, reject }); drain(); });
  }
  async function close() { closed = true; activeAbort?.abort(); aiService?.close?.(); ocrGeneration++; for (const job of queue.splice(0)) job.reject(new MediaError('media_unavailable', 503)); audio.close(); await ocrWorker?.terminate(); }
  return { scan, status, close };
}

export function mediaErrorText(code, locale = 'ru') {
  const messages = {
    invalid_source: ['Тек ашық Instagram/TikTok жарияланымы рұқсат етіледі.', 'Разрешены только публичные страницы Instagram/TikTok.'],
    invalid_timestamp: ['Үзінді уақыты дұрыс емес; дыбыс 30 секундтан аспауы керек.', 'Неверные отметки времени; аудиофрагмент должен быть не длиннее 30 секунд.'],
    model_missing: ['Дыбыс моделі орнатылмаған. setup-media.ps1 іске қосыңыз.', 'Модель речи не установлена. Запустите setup-media.ps1.'],
    dependency_unavailable: ['Дыбысты тану модулі орнатылмаған.', 'Модуль распознавания речи не установлен.'],
    audio_unavailable: ['Дыбысты тану қызметі қолжетімсіз.', 'Служба распознавания речи недоступна.'],
    ocr_missing: ['Кадр мәтінін тану файлдары жоқ. npm run setup:ocr іске қосыңыз.', 'Нет файлов OCR. Выполните npm run setup:ocr.'],
    media_busy: ['Талдау кезегі толы. Сәл күтіңіз.', 'Очередь анализа заполнена. Подождите немного.'],
    media_timeout: ['Талдау уақыты аяқталды. Қысқа үзіндіні қайта тексеріңіз.', 'Превышено время анализа. Повторите с коротким фрагментом.'],
    media_too_large: ['Кадр шегі 1,5 МБ, дыбыс шегі 2 МБ.', 'Максимум 1,5 МБ для кадра и 2 МБ для аудио.'],
    audio_failed: ['Дыбысты оқу немесе тану мүмкін болмады.', 'Не удалось прочитать или распознать аудио.'],
    ocr_failed: ['Кадрдағы мәтінді оқу мүмкін болмады.', 'Не удалось прочитать текст кадра.'],
    no_audio_track: ['Үзіндіде дыбыс жолы жоқ.', 'В фрагменте нет аудиодорожки.'],
    audio_too_long: ['Дыбыс үзіндісі тым ұзақ.', 'Аудиофрагмент слишком длинный.'],
  };
  return (messages[code] || ['Медиа деректері дұрыс емес.', 'Некорректные медиаданные.'])[locale === 'kk' ? 0 : 1];
}

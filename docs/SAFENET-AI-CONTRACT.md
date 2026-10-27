# SafeNet AI implementation contract

This is the next-generation application, implemented alongside the existing SafeNet KZ deployment. The existing Telegram implementation and real data remain available. No CAPTCHA, login, anti-bot or browser-permission bypass is implemented.

## Architecture and ownership

- `apps/console`: Next.js / TypeScript / Tailwind / accessible shadcn-style primitives / Framer Motion / Recharts. Default API prefix `/api/v1`, proxied to FastAPI by Next. Russian default; Kazakh and English selectors.
- `services/intelligence/safenet`: FastAPI, SQLAlchemy, PostgreSQL, Celery/Redis, Playwright collectors, deterministic evidence-based analysis and optional configured LLM.
- Local development: SQLite and a real bounded thread executor, explicitly identified in health. Docker Compose: PostgreSQL and Redis/Celery. No synthetic activity in live mode.
- Browser Use is an optional explicitly configured planner, restricted to public domains and actions. Missing credentials/dependencies produce a declared capability status.
- API author owns `app.py`, `models.py`, `store.py`, `runner.py`, `worker.py`, `settings.py`, auth and infrastructure. Collector author owns `collectors.py`, `safe_fetch.py`, collector/security tests. Analysis author owns `analysis.py`, `llm.py`, detector tests. Frontend author owns `apps/console`.

## Python module interfaces

Collector: `async collect(url: str, *, platform: str = 'web', on_event=None) -> dict`. Event callback is async, accepts `{stage, message}`. Result: `{status:'completed'|'blocked'|'unavailable', url, title, text, links:[str], metadata:dict, reason:str|null, screenshot_path:str|null}`. May raise `UnsafeURL(ValueError)` for unsafe URLs. `safe_fetch.validate_url(url)` async validates public HTTP(S) DNS/IP; `safe_fetch.fetch_public(url)` async returns `{url, status_code, text, headers}` with pinned destination and redirect validation. No arbitrary browser navigation beyond platform allowlist. No auth or CAPTCHA bypass.

Analysis: `analyze(text: str, *, url: str = '', links: list[str] | None = None, locale: str = 'ru') -> dict`: `{score:int, level:'low'|'medium'|'high'|'critical', category:str, summary:str, evidence:[{code,label,quote,weight,source_url}], recommendations:[str], method:'rules', limitations:[str], language:str}`. Brand alone is not a signal. `async explain_with_llm(analysis:dict, text:str, *, question:str='', locale:str='ru') -> dict`: `{status:'completed'|'disabled'|'unavailable', provider:str, explanation:str, citations:[str]}`. LLM output never creates source evidence or changes rule scores. Credentials from environment only.

## HTTP contract

All endpoints `/api/v1`. GET public except media frame images (admin only); mutation needs admin session unless local development explicitly enables local admin. `GET /session -> {authenticated,login_enabled}`, `POST /session {code}`, `DELETE /session`. HttpOnly cookie, origin checks, rate-limited login. JSON errors `{detail:string}`.

- `GET /health -> {status, database, queue, llm, browser, version}`.
- `GET /overview?mode=live|demo -> {mode, totals:{scanned,suspicious,critical,active_agents}, distribution:[{level,count}], timeline:[{date,count,suspicious}], recent:[Scan], agents:[Agent]}`. Empty arrays/zero are real empty states.
- `GET /agents -> {items:[Agent]}`. Five agent IDs `tiktok`, `instagram`, `youtube`, `threads`, `telegram`.
- `POST /agents/start`, `POST /agents/stop -> {items:[Agent]}`.
- `POST /agents/{id}/start|stop|restart -> Agent`.
- `PATCH /agents/{id} {seeds:[url],interval_seconds:int} -> Agent`.
- `GET /agents/{id}/logs -> {items:[{id,at,stage,message,task_id}]}`.
- `POST /scans {url?:str,text?:str,platform?:str,mode:'live'|'demo',locale:'ru'|'kk'|'en'} -> Scan` (202 for queued work). One URL or text required, max text 20000, URL 2048. Demo explicit and never counted as live.
- `GET /scans?mode=live|demo&limit=50&offset=0&level=&platform= -> {items:[Scan],total:int}`.
- `GET /scans/{id} -> Scan`.
- `POST /scans/{id}/review {decision:'confirmed_signals'|'false_positive'|'needs_context',note:str} -> Scan`.
- `POST /reports {scan_id:str} -> Report`; `GET /reports -> {items:[Report]}`; `GET /reports/{id} -> Report`. Report `{id,scan_id,created_at,title,markdown}`. Markdown is downloadable locally by UI.
- `POST /assistant {question:str,scan_id?:str,locale?:str} -> {answer,provider,citations:[str],status}`. Without LLM, explicitly identified evidence-based assistant; no invented factual verification.
- `GET /settings -> {capabilities,retention_days,mode,queue,llm,browser}` (no credentials).
- `WS /events?mode=live|demo`: emits `{type:'snapshot',data:Overview}` every 2 seconds; reconnect/poll fallback.

`Agent`: `{id,name,platform,enabled,status:'idle'|'queued'|'running'|'blocked'|'failed'|'stopped',stage,last_error,last_run_at,next_run_at,seeds:[str],interval_seconds:int,checked:int,flagged:int}`.

`Scan`: `{id,url,title,platform,mode,status:'queued'|'running'|'completed'|'blocked'|'failed'|'cancelled',stage,created_at,completed_at,score:int|null,level:str|null,category:str|null,text:str,analysis:dict|null,error:str|null,review:dict|null,agent_id:str|null,metadata:dict}`. Completed means content was actually obtained or supplied by user. Scores remain null for inaccessible content. Human-submitted text source is labelled manual, not independently fetched.

Capabilities expose actual local OCR and Whisper availability in `video_analysis`,
`audio_transcription`, and `media_processing`. Optional vision service configuration
is not proof that the model is reachable; each scan reports actual status.

- `POST /media/scans`: authenticated multipart `file`, `mode`, `locale`, optional
  `source_url`. Returns Scan (202). File limit 64 MiB; request envelope 65 MiB.
  Supported containers: MP4/MOV/WebM, MP3/WAV/M4A/FLAC/OGG. Upload provenance is
  explicit and never treated as independently fetched from the supplied URL.
- `GET /scans/{id}/frames/{index}`: admin-only JPEG preview of a sampled frame.
- Instagram/TikTok video permalinks submitted to `/scans` or used by monitors also
  attempt anonymous public MP4 acquisition. Gates and unavailable media stay explicit.
- `metadata.media`: status, duration_seconds, analyzed_seconds, truncated, has_audio,
  has_video, audio/visual status/reason/model, transcript [{start,end,text}], frames
  [{at,text,ocr_confidence,observations,visual_status,thumbnail_url}], limitations.
  Confidence is uncalibrated [0,1]. At most six frames, first 120 seconds.
- Evidence can include `modality` (`speech`, `frame_text`, `page_text`) and
  `start_seconds`/`end_seconds`. `analysis.media_evidence` retains additional findings;
  only the strongest source combination contributes to the score, with no repeat bonus.

Whisper and OCR output may be incorrect. Visual model observations are separate
inferences for review, never quotes or extra risk points. A completed scan or zero
score does not establish that all frames, audio tracks or content are safe. Old text
checks retain their original text-only scope. Browser/chat MCP plugins are not
automatically connected to application workers.

## Product and design checks

Dense, calm SOC workspace; graphite background, turquoise primary action, amber/red risk accents, readable typography. Desktop 1440x900 and mobile 390x844. Primary action: Analyze URL. Navigation: Overview, Live Monitoring, Browser Agents, Detections, URL Scanner, Analytics, Assistant, Reports, Settings. Inspect empty/loading/error/partial/success/permission states. All counters and action logs derive from persisted work. Risk score is a heuristic, never a calibrated probability or a legal verdict.

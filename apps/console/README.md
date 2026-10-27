# SafeNet AI console

Next.js App Router, strict TypeScript, Tailwind CSS 4, Radix accessible dialog primitives, Framer Motion and Recharts. This application follows `../../docs/SAFENET-AI-CONTRACT.md`; all product data comes from the intelligence API. Russian is the default; Kazakh and English are available in the header. Fonts are bundled locally.

## Run

Node 22.12+:

```powershell
cd apps/console
npm ci
npm run build
npm start
```

Open `http://127.0.0.1:3000`. The repository's `Start-SafeNet-AI.ps1` can also start the built console. `npm run dev` runs on the same port; use only one frontend process at a time.

HTTP calls use same-origin `/api/v1`. Next rewrites forward to `SAFENET_API_URL`, default `http://127.0.0.1:8100`. Set this variable **before building**; rewrites are captured in the build. HttpOnly session cookies remain same-origin; credentials are never stored in localStorage. The public WebSocket URL is `NEXT_PUBLIC_WS_URL`, default `ws://127.0.0.1:8100/events`; it must be browser-reachable and configured before building. For an HTTPS deployment use `wss://`. The console falls back to HTTP polling if WebSocket is unavailable, stale, invalid or incompatible with HTTPS.

```powershell
npm run typecheck
npm test
npm run check:api
```

`check:api` is a read-only contract smoke test against the configured backend. It never starts/stops agents or alters records.

## Docker

Use `apps/console` as the build context. Dockerfile exposes port 3000 and runs the standalone server as a non-root user. The repository Compose file passes `SAFENET_API_URL=http://api:8100` as a **build argument**. Override `NEXT_PUBLIC_WS_URL` as a build argument for remote clients. The image includes its own HTTP health check. Docker must be tested in an environment with a Docker daemon; local npm build is not a Docker-image validation.

## Workflows

- Overview/Analytics: persisted totals, timeline, risk distribution and recent scans, isolated by mode.
- Live Monitoring/Browser Agents: the four actual backend agents; start/stop/restart, seed URLs, interval, logs and platform result links. Demo disables agent mutations; agent infrastructure remains live.
- Detections: server-side platform/risk filters, pagination, and clearly labelled search within the loaded page.
- Scanner: public URL, manual text, or a video/audio file. URL/text limits are 2048/20000 characters. Files accept MP4, MOV, WEBM, MP3, WAV, M4A, FLAC and OGG up to 64 MiB; only the first 120 seconds are analyzed and frames are sampled. Optional original URLs are references, not verified provenance. Uploads use same-origin multipart `/api/v1/media/scans`, retain admin cookies, and allow three minutes for transfer. Demo supports explicit text samples or user-uploaded files and stays separate from Live. Public Instagram/TikTok permalink scans use the existing `/scans` endpoint and show actual media coverage returned by the backend.
- Scan details: weighted quotations, source links, recommendations, limitations, original text, review, JSON and persisted Markdown reports. Historic captures show captured/imported timestamps and never imply a fresh fetch. Content scope is visible.
- Assistant: real endpoint, selected completed scan context, answer provider/status and citations. Evidence assistant fallback is explicitly identified when LLM is absent.
- Reports: shared persisted Live/Demo archive with mode-labelled Markdown and downloads.
- Settings: real capabilities, health, retention and admin session. Login uses the configured admin code. Explicit local-admin sessions are identified.

Media details remain visible for failed/unscored scans. They show partial/unavailable reasons, known duration and processed interval, audio/visual status and models, timestamped transcripts, sampled frames, OCR confidence and limitations. Frame JPEGs require analyst access and load through the local scan route. AI visual observations are labelled for human review and do not count as risk evidence. `analysis.media_evidence` shows matches across up to 60 windows without adding their weights to the strongest-source score. Earlier text-only scans keep their no-media notice regardless of current server capabilities. All media stages, including `waiting_media`, are translated in RU/KK/EN.

Data failures never become fabricated zeroes. Cached data remains visible with a stale/error notice. Unknown capabilities are rendered as supplied, not inferred. External sources are untrusted text and only HTTP(S) links are clickable.

## Structure and verification

`src/lib/api.ts` owns credentials, transport errors, schema validation and timeout; `src/lib/schema.ts` mirrors the contract; `src/components/providers.tsx` owns cache, session, mode and stream recovery. Screens consume these shared interfaces. `src/lib/i18n.ts` contains all interface translations. `docs/DESIGN.md` records the rendered design contract; `evidence/QA.md` records the actual checks and limits.

To verify a production build while an existing server uses `.next`, set `SAFENET_BUILD_DIR=.next-media-check` for `npm run build`. This writes separate build artifacts without restarting the server. Next may update generated TypeScript includes; run the normal `npm run typecheck` afterwards to regenerate the default route references.

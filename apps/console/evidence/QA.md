# SafeNet AI browser QA

Target: only `http://127.0.0.1:3000`; backend already owned and running separately at port 8100. No previously denied origin was opened and no browser-permission workaround was used.

## Verified

- `npm run build`: production build passed (Next.js 16.4.3).
- `npm run typecheck`: passed, including the focus restoration and contrast fixes.
- `npm test`: 8/8 passed. Tests cover credentials, errors, cancellation, schema mismatch, nullable inaccessible scans, provenance, and unsafe link schemes.
- `npm run check:api`: passed against real API; 100 live records parsed, four agents and logs, empty Demo overview, settings, health and reports.
- Real overview had 115 completed live scans and 63 suspicious materials when inspected. Values are observations, never embedded in the UI.
- Browser WebSocket connected and overview updated from real backend snapshots.
- Historical capture opened: captured timestamp, import/reanalysis timestamp, explicit not-fresh notice and content scope were visible.
- Explicit Demo sample submitted through UI: scan `830e2452-acab-4530-a92d-408eb0962798`, completed, score 75, three quoted rule findings. Live scanned/suspicious totals unchanged by this Demo action.
- Review saved through UI and read back from API: `confirmed_signals`, labelled QA note on synthetic example only.
- Report created through UI: `a2899f69-6397-439e-8ca6-98e9d2362815`, Markdown download invoked, 1411 characters, explicitly `Mode: demo`, persisted review included.
- Desktop 1440x900 viewport confirmed by DOM, no page horizontal overflow, sidebar fits without scrolling.
- Initial Lighthouse snapshot: accessibility 96, best practices 100, SEO 100, agentic browsing 100. Two issues found (metric secondary text contrast, brand accessible name); both corrected in source and awaiting final rebuilt audit.

## Final bounded browser checks

- Final mobile overview inspected inline at 390x844. Lighthouse mobile snapshot: **Accessibility 100, Best Practices 100, SEO 100, Agentic Browsing 100; 36 passed / 0 failed**. Tool-generated report: `C:\Users\dimas\AppData\Local\Temp\chrome-devtools-mcp-u0jXbT\report.json`.
- A later DOM measurement caught page overflow caused by the absolutely positioned screen-reader table heading escaping its scroll container. Added `position: relative` to `.table-scroll`; verified the change in the rendered page before rebuilding: inner viewport 390x844, document clientWidth=390, scrollWidth=390, visual viewport 390x844. This is an actual correction, not a claim based on the earlier screenshot alone.
- Mobile menu opens a labelled modal, focus enters its Close button, Escape closes it and focus returns to the Open navigation button. All icon-only buttons have accessible names.
- Switched Russian → Kazakh → English in the rendered mobile app. Verified `html.lang`, translated h1 and subtitle; width remained 390px in Kazakh and English.
- Real current records displayed localized neutral pattern labels (including casino indicators and no identified pattern), null risk for blocked/failed collection, and actual four-agent partial states. Agent failures were not presented as successful scans.
- Admin code login, seed mutation/start/stop/restart and injected network-failure states were not fully exercised end-to-end by this frontend QA; API transport error tests passed. Local administrator access was exercised against the real running API.
- An assistant question using the real completed live scan `ab89b1b8-5c59-471e-9036-2379003fa39a` was submitted via the UI after LLM configuration. The browser became unavailable during subsequent QA, so the rendered LLM response is **unverified** (do not claim a successful chat response from this run).
- A supplemental browser tab timed out after 10 seconds and the next browser call did not complete within the bounded wait. The orchestration wait was terminated; no raw CDP, alternate browser profile, origin workaround or repeated indefinite retry was used.
- WebSocket was observed connected before the timeout. HTTP fallback/reconnection logic is implemented, but the supplemental injected-failure browser check did not complete, so rendered fallback/error/login states remain unverified.
- The final desktop Lighthouse rerun was not completed because the shared browser became busy. Initial desktop score was 96; both reported source issues were corrected and the later mobile audit passed at 100.
- Final browser return to Overview could not be confirmed after the browser timeout. The app's entry URL remains `http://127.0.0.1:3000/overview`.

## Screenshot storage limitation and gate status

Chrome DevTools `take_screenshot` successfully returned inline desktop and mobile screenshots of the new app. The agent inspected those rendered pixels. The tool rejected its requested save path `apps/console/evidence/desktop-overview.png` as outside its configured workspace roots, despite that path belonging to this task's workspace. No alternate-path or raw-CDP workaround was attempted. Therefore this directory contains observations/test evidence, not fabricated PNGs. **The strict ECC evidence checker is not passed**: screenshot artifacts are unavailable and some rendered states are unverified. The limitation is recorded; no permission workaround was used.

## Final handoff

- Latest `npm run typecheck`: passed.
- Latest `npm run build`: passed after the mobile overflow correction; optimized Next.js production output is ready in `.next`.
- Latest client tests: 8/8 passed. Latest read-only API smoke: all checked endpoints passed, including the new live Telegram record and saved Demo report.
- Frontend QA process was stopped for the final build. An attempted hidden persistent restart was rejected by command policy (`blocked by policy`, no detailed reason). No alternate launch workaround was attempted. The rejected action was a composite shell command; the reason was not detailed. The agent must not use the one-click launcher as a workaround. Backend was never stopped/restarted by this frontend task.
- Dockerfile accepts `SAFENET_API_URL` and `NEXT_PUBLIC_WS_URL` build arguments, runs on port 3000; Docker image execution was not tested.

# SafeNet KZ interface contract

Surface: local analyst workspace for checking suspicious social posts. Primary action: explicitly submit text, a link or an OCR transcription. Audience: hackathon evaluators and human moderators. Tone: calm, precise and useful. Deep forest navigation, pale workspace and lime status accents distinguish the product without obscuring evidence.

Hierarchy: title and primary action; metrics computed from actual cases; activity and risk distribution; searchable case table. No fabricated live platform access. Demonstration records carry Demo badges. Risk is a heuristic signal, not a legal conclusion.

Target viewports: 1440x900 and 390x844. At narrow widths navigation becomes a dismissible drawer, metric cards become two columns, chart panels stack and the table scrolls within its own container. Case details open in a keyboard accessible modal with focus restoration.

States: loading shows progress text; empty offers first analysis/demo import; errors show actionable message and retry; partial OCR shows editable transcription and explicit submit; success opens evidence and updates stored case list; sources explain access boundaries (manual/extension, no automatic private-account access).

All nav destinations render real content. Charts derive from loaded cases. Graph comes from API. Export is server-generated. File import parses JSON/TXT. Image OCR runs in browser on explicit user-selected image, then requires separate analysis submission.

Rendered review and viewport evidence will be collected by root integration agent; do not claim unperformed checks.


Localization update: visible KK/RU switch persists in localStorage; first launch defaults to Kazakh. UI text is rendered through src/i18n.js dictionaries. Source posts and quotes remain verbatim. Engine summaries, limitations and signals use analysis.translations selected by language. Main overview and sources link to /demo-feed; sources describe automatic visible loaded Instagram/TikTok post checking through the installed, enabled browser extension. This does not imply platform API access or network-wide crawling.

# SafeNet AI console design contract

Reference: `../../../docs/SAFENET-AI-CONTRACT.md` and the supplied product brief. Product surface: an analyst's repeated monitoring, inspection and review workflow. Primary action: Analyze URL. Hierarchy: connection and mode, workspace title, persisted totals, trend and agent status, recent evidence. No marketing screen.

Calm graphite surfaces with fine separators, mint actions, desaturated blue context, amber/red risk. A small shield and a vertical activity rail identify the workspace; a restrained scan-line motif appears only in empty scanner states. Tabular numeric typography supports comparison. One consistent elevation for panels; forms and tables use dividers rather than nested cards.

Targets: 1440x900 desktop, 390x844 mobile. Desktop has a persistent 232px navigation rail. Mobile uses a keyboard-accessible modal navigation, one-column panels and horizontally scrollable tables. Text wraps; no page-level horizontal overflow. Native labels, visible focus, Radix modal focus trapping/restoration, reduced motion, semantic tables and accessible chart summaries.

| State | Trigger | Feedback | Next action |
| --- | --- | --- | --- |
| Loading | Initial API request | Stable skeleton, busy label | Navigate while loading |
| Empty | Persisted zero / empty lists | Explicit no-results state | Analyze URL or configure seeds |
| Error | HTTP/network/schema failure | Specific error, no fabricated zero | Retry / inspect settings |
| Partial | One resource fails or stream drops | Last known data labelled; polling connection state | Retry resource / continue available work |
| Success | Mutation resolves or scan completes | Live result and status toast | Inspect evidence / review / export |
| Permission | Unauthenticated mutation | Read-only notice, login control | Admin code / keep browsing |

Architecture follows Matt Pocock codebase-design: the transport module owns schema parsing, same-origin credentials, errors and timeouts; the workspace provider owns resource caching, mode isolation and websocket recovery behind a small shared interface. Screens consume those interfaces. Scores and counters are never computed from invented samples. Demo text is available only after explicitly selecting Demo and a named sample. Agent controls always operate real agents and are disabled in Demo.

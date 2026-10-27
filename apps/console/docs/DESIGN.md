# SafeNet AI console design contract

Reference: `../../../docs/SAFENET-AI-CONTRACT.md` and the supplied product brief. Product surface: an analyst's repeated monitoring, inspection and review workflow. Primary action: Analyze URL. Hierarchy: connection and mode, workspace title, persisted totals, trend and agent status, recent evidence. No marketing screen.

Day mode uses cool paper surfaces and deep green actions; night mode uses calm graphite surfaces and mint actions. Both retain blue context and amber, orange and rose risk indicators. A small shield and a vertical activity rail identify the workspace; a restrained scan-line motif appears only in empty scanner states. Tabular numeric typography supports comparison. One consistent elevation for panels; forms and tables use dividers rather than nested cards.

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

## Appearance and semantic colors

`html[data-theme="light"]` and `html[data-theme="dark"]` select complete palettes in `src/app/globals.css`. The root defaults to dark until the appearance bootstrap resolves the preference. CSS does not independently follow `prefers-color-scheme`: the shared appearance provider resolves Light, Dark and System, keeping the document, controls and saved preference in agreement. Each palette sets native `color-scheme`, including selects and scrollbars.

| Role | Night | Day | Use |
| --- | --- | --- | --- |
| Canvas / panel | `#10161e` / `#151f29` | `#f3f6f8` / `#ffffff` | Workspace and readable content surfaces |
| Primary / secondary text | `#edf3f7` / `#cad6e0` | `#182a35` / `#354d5d` | Headings, evidence, table content |
| Supporting text | `#a5b5c4` | `#526777` | Labels, timestamps, help, disabled text |
| Brand action | `#66dfbe` | `#08765e` | Analyze, active navigation, appearance selection, focus |
| Low risk | `#6bdfbd` | `#08765e` | Low-risk series and badges |
| Medium risk | `#edbe75` | `#926000` | Warnings and medium-risk series |
| High risk | `#f4a177` | `#b34d24` | High-risk series and badges |
| Critical risk | `#fb91a5` | `#bc3355` | Critical-risk series and errors |

Components use semantic surface, text, border, shadow and status tokens. Shared `color-mix()` tokens derive subtle backgrounds and borders from each palette; there are no light-only component overrides. Surfaces cover the sidebar, topbar, forms, tables, empty/loading states, notices, media details, chat, reports, dialogs and toasts. Media images preserve their original colors. Network SVG nodes, selected nodes, edges and labels use dedicated graph tokens; chart strokes, fills, axes, grids and tooltips use the same risk and surface system. Risk names, values and badges remain visible alongside color.

## Readability and interaction

Inter body text is 14px with a 1.6 line height. Controls use 13px; supporting labels use 12px. Small metadata has an 11px floor instead of the previous 5–10px sizes. Evidence paragraphs retain generous line spacing, and numeric totals retain tabular figures. Panels use a restrained shared shadow and existing 8–14px corner radii. Tables gain vertical cell padding and keep overflow inside their own scroll container.

Keyboard focus uses a 3px brand outline. Inputs have a distinct stronger border, visible placeholder text, brand focus, and critical-color invalid states. Disabled controls keep readable supporting text on a raised surface instead of fading the entire control. Hover states use semantic surfaces and are suppressed for disabled buttons. Reduced motion remains respected; chart animations remain off, and changing appearance does not animate the whole page.

The compact `.theme-toggle` shows an icon and the translated current appearance on desktop. At 540px and below it becomes a 44px icon button; its supplied accessible name continues to describe the target appearance. Settings use a `.theme-preference` fieldset, legend and help, with three `.theme-options` buttons. `aria-pressed="true"` gains a strong border, inset outline, tinted surface and heavier label. Options stack icon above label on narrow screens so translated labels fit.

At 390px the header has a breadcrumb/menu row and a controls row. Guest sign-in may wrap its label while mode, language and the theme button retain their targets. Actions and notices wrap; controls are at least 44px tall on mobile, and editable text fields use 16px to avoid mobile focus zoom. Below 380px, metric cards and the donut layout stack. The original 1440px and 390px viewport targets remain the acceptance sizes.

Palette verification checks ordinary and muted text, placeholders, risk badges, informational notices, action labels and selected graph labels at 4.5:1 or better; input borders and focus colors at 3:1 or better. These are token-level checks, not a substitute for rendered accessibility review. Browser QA should cover both themes at the target sizes, guest and signed-in headers, all three locales, keyboard focus, settings options, chart tooltip hover, open scan/media dialogs and the network graph. Theme persistence, initial paint and System behavior belong to the shared appearance provider's integration checks.

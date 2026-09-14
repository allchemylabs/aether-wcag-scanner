# Aether WCAG Scanner

A Claude Code plugin that finds **WCAG 2.1 AA accessibility violations** and
returns **ready-to-apply fixes** — not just a list of problems.

It drives a real browser (Playwright + axe-core) across desktop, tablet, and
mobile viewports, then pairs each violation with a concrete fix: corrected
HTML, the relevant WCAG success criteria, and technique code examples.

---

## Why it's different

Plain Claude Code can *guess* at accessibility issues by reading your markup.
This plugin actually **runs your page** and grounds every fix in the WCAG spec.

| | Plain Claude Code | Aether (offline) | Aether (with API key) |
|---|---|---|---|
| Detection | Eyeballs the HTML it can see | Real browser + axe-core, all viewports | Real browser + axe-core, all viewports |
| Coverage | Misses computed/runtime issues | Catches contrast, ARIA, focus, names | Same |
| Fixes | Generic suggestions | Built-in fix templates | RAG-backed fixes + WCAG technique code |
| Grounding | None | Rule IDs + severity | Cited success criteria + techniques |
| Works offline | n/a | Yes | Falls back to offline automatically |

The scanner **degrades gracefully**: with no API key (or when offline or
rate-limited) it still returns template-based fixes for every violation. Add an
API key and the same violations come back with corpus-grounded fixes and WCAG
technique snippets.

---

## Install

```
/plugin marketplace add allchemylabs/claude-plugins
/plugin install aether-wcag-scanner@allchemylabs
```

Once the official Claude Code marketplace listing is live, you can also install
it directly from there.

### Optional: enable RAG-powered fixes

The plugin works fully offline out of the box. To enable corpus-grounded fixes
from the hosted insights engine, set your Allchemy Labs API key when prompted
during install (or via the plugin's config). Without a key, you get template
fixes — no account required.

---

## The 5 tools

| Tool | What it does |
|---|---|
| `aether_scan_and_fix` | **Recommended.** Scan a URL — or a single-page app across routes via the `spa` block — and return violations *with* fixes, each verified on the real browser, in one call. Set `maxFixes: 0` for a fast scan-only pass. |
| `aether_get_fix` | Get a fix for one specific violation (verified on the real browser). Omit `html` to instead get a rule-level explanation — WCAG success criteria and technique examples. |
| `aether_verify_fix` | Deterministically verify a fix with real Playwright + axe — re-scan a URL or diff original vs fixed HTML. Reports whether the target cleared, any new regressions, and the net compliance delta. |
| `aether_check_html` | Analyze an HTML snippet for issues — no live URL or browser needed. |
| `aether_submit_feedback` | Rate a fix (useful / not useful) so the guidance engine keeps improving; your correction helps seed better fixes. |

Just ask Claude naturally, e.g. *"check localhost:3000 for accessibility
issues and fix them"* — it will pick the right tool.

## The `/wcag-scan` skill

Run `/wcag-scan <url>` for a guided workflow: scan → review violations → apply
fixes → re-scan to verify → summarize. The skill orchestrates the tools above
and edits your files in place.

---

## Scanning single-page apps

Pass a `spa` block to `aether_scan_and_fix` instead of `url`:

```json
{ "spa": { "entryUrl": "http://localhost:4200", "framework": "angular", "maxRoutes": 10 } }
```

- `entryUrl` — where the app boots. Routes are discovered by crawling client-side links
  unless you list them in `routes: [{ "path": "/settings", "name": "Settings" }]`.
- `framework` — `angular`, `react`, `vue`, or omit to auto-detect.
- `maxRoutes` — cap on discovered routes.

Navigation is client-side (the browser context and app state are kept between routes),
and readiness is decided by a layered stability cascade — DOM quiet, framework hooks such
as Angular testability, pending-request drain — never by Playwright's `networkidle`,
which deadlocks on apps with long-polling or websockets. A config that sets
`networkIdle` is rejected for that reason.

## Requirements

- Node.js >= 20
- Chromium (installed automatically on first run)

## License

MIT for the client (this plugin). The hosted insights engine and related
Allchemy Labs services are proprietary — see `LICENSE` and `NOTICE`.

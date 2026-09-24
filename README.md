# Aether WCAG Scanner

A Claude Code plugin that finds **WCAG 2.1 AA accessibility violations** and
returns **ready-to-apply fixes** — not just a list of problems.

It drives a real browser (Playwright + axe-core) across desktop, tablet, and
mobile viewports, then pairs each violation with a concrete fix: corrected
HTML, the relevant WCAG success criteria, and technique code examples.

---

## Why it's different

An AI coding agent working from markup alone has to infer what a page does. Aether runs
the page in a real browser, measures it with axe-core, and grounds every suggested fix in
the WCAG spec, so the agent is working from measurements rather than inference.

| | Coding agent alone | Aether, offline | Aether, with API key |
|---|---|---|---|
| **How it looks at the page** | Reads the HTML it is given | Renders the page in Chromium at desktop, tablet and mobile widths and runs axe-core | Same |
| **What it can measure** | Structure visible in the markup | What axe measures on the rendered page: contrast, accessible names, ARIA usage, focusable regions, landmarks | Same |
| **Fix suggestions** | From the model's general knowledge | Deterministic templates for the common rules | Templates first, then WCAG-corpus examples, then a model; every cited technique passes a grounding check |
| **How fixes are checked** | Not checked unless you set that up | axe re-run on the fixed element; reports what cleared and what regressed | Same |
| **What each fix cites** | Whatever the model recalls | The axe rule and its severity | The WCAG success criteria and techniques, with rejected candidates shown |
| **Network** | Depends on the agent | None; runs entirely on your machine | Fix requests go to the hosted engine; falls back to offline templates when it is unreachable |

## Install

```
/plugin marketplace add https://github.com/allchemylabs/claude-plugins.git
/plugin install aether-wcag-scanner@allchemylabs
```

Once the official Claude Code marketplace listing is live, you can also install
it directly from there.

The install prompts for your **Allchemy Labs API key**; paste the key you got
from [beta.allchemylabs.ai](https://beta.allchemylabs.ai). To set or change it
later:

```
/plugin configure aether-wcag-scanner@allchemylabs
```

The first start installs the plugin's dependencies (about a minute) and the
first scan downloads Chromium for Playwright. If `/mcp` shows the server as not
connected right after install, wait a moment and run `/reload-plugins`.

### Running without a key

The scanner itself runs locally and works without a key: you get template
fixes for every violation. The key adds corpus-grounded fixes from the hosted
insights engine. Set it via the prompt above, or put `ALLCHEMY_API_KEY=<key>`
in the `.env` of the project you are scanning.

---

## Use it outside Claude Code (any MCP client)

The same server is published to npm and the MCP Registry as
`@allchemylabs/aether-wcag-scanner`. Any MCP client that speaks stdio can run it:

```json
{
  "mcpServers": {
    "aether-wcag-scanner": {
      "command": "npx",
      "args": ["-y", "@allchemylabs/aether-wcag-scanner"],
      "env": { "ALLCHEMY_API_KEY": "<your beta key>" }
    }
  }
}
```

The first scan downloads Chromium once (about 150 MB). Without `ALLCHEMY_API_KEY`
the scanner still runs fully offline and returns template fixes.

Claude Code gets the `/wcag-scan` skill, which drives the scan → review → fix → verify
loop. Other agents only see the tool descriptions and the instructions the server sends at
connect time, so for the same behaviour copy [`AGENTS.md`](./AGENTS.md) into your project
(Codex reads it natively; Cursor and Windsurf accept it as a rules file). Without it an agent
may fetch the page HTML and guess instead of running the browser scan.

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

## Disclaimer

Aether is an accessibility analysis and guidance tool. Using the platform does not, by
itself, make your website, application, or digital service conformant with WCAG, the ADA
(including Title II), the European Accessibility Act, Section 508, EN 301 549, or any other
accessibility law or standard.

Automated scans detect only a subset of accessibility barriers. A "zero issues" result means
the scanner did not flag anything in its detection range — not that the property is legally
compliant.

You remain responsible for:

- reviewing findings with qualified people
- fixing issues in the underlying code and content
- conducting or commissioning manual testing and audits as needed
- maintaining accessibility as the product changes
- obtaining legal advice for your specific obligations

Aether does not provide legal advice and does not replace an accessibility audit or a
VPAT/ACR prepared by a qualified auditor.

## License

MIT for the client (this plugin). The hosted insights engine and related
Allchemy Labs services are proprietary — see `LICENSE` and `NOTICE`.

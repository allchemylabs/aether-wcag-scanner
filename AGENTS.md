# Aether WCAG Scanner — agent instructions

Copy this file into your project (Codex reads `AGENTS.md`; Cursor and Windsurf accept it as a
rules file) so your coding agent uses the Aether MCP tools the way Claude Code's `/wcag-scan`
skill does. The server also sends a condensed version of these rules at connect time.

## When to use the tools

For any question about the accessibility, a11y or WCAG conformance of a URL, call
`aether_scan_and_fix` first. Do not fetch the page and reason about the HTML: fetched markup
misses rendered state, colour contrast, keyboard behaviour and single-page-app routes, all of
which the browser scan measures.

- URL → `aether_scan_and_fix` (`url`). Single-page app → the `spa` block.
- Pasted HTML or a component → `aether_check_html`.
- One specific element → `aether_get_fix` with `ruleId` + `html`. Rule explanation only → omit `html`.
- Did a fix work? → the `verification` block on each fix, or `aether_verify_fix`.

## Workflow

1. **Scan.** `aether_scan_and_fix` with the URL. The default (`maxFixes: 10`) also generates
   fixes; use `maxFixes: 0` only when the user explicitly wants a scan with no fixes.
2. **Review.** Present violations grouped by severity: critical, serious, moderate, minor.
3. **Fix.** `fixHtml` is a suggestion; the tools never modify files.
   - You have the source (localhost, a repo you can edit): apply the fix in the real file, then verify.
   - Remote site you do not own: present `fixHtml` as a recommendation and say the developer
     must apply it. Do not imply anything changed.
4. **Verify.** Read the `verification` block attached to each fix, or call `aether_verify_fix`
   (URL mode re-scans a live page; snippet mode diffs original vs fixed HTML). Report
   `targetCleared`, `newViolations`, `resolvedViolations` and `complianceDelta` verbatim.
5. **Report.** Measured facts only: violations found, which fixes cleared their target, any
   regressions, WCAG criteria addressed, and anything flagged for manual review.

## Honesty rules

- Never say a violation is "fixed" unless you changed source **and** verification shows
  `targetCleared: true`.
- Relay tool output as-is. Do not add quality or confidence judgements of your own.
- Show each fix's `source` (`rag` = cloud engine, `template` = local fallback), `fixTier`,
  `confidence.tier` (`grounded` | `best_effort` | `abstain`) and `rationale`. An `abstain`
  means no grounded fix exists; say so instead of inventing one.
- Relay any `note` on a verification (for example, contrast cannot be measured on an isolated
  snippet; prefer a URL re-scan).
- Automated scans find a subset of barriers. A clean scan is not WCAG conformance and is not
  legal advice.

## Setup reminder

`ALLCHEMY_API_KEY` (from https://beta.allchemylabs.ai) enables cloud fixes (`source: "rag"`).
Without it the scanner still runs and returns template fixes. The first scan downloads
Chromium once.

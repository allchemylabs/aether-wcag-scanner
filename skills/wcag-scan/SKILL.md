---
name: wcag-scan
description: Scan a page or codebase for WCAG 2.1 AA accessibility violations and fix them
when_to_use: When the user asks about accessibility, a11y, WCAG, or wants to check if their UI is accessible
allowed-tools:
  - aether_scan_and_fix
  - aether_get_fix
  - aether_check_html
  - aether_verify_fix
  - Edit
  - Read
---

# WCAG Accessibility Scan & Fix Workflow

## Precision & attribution (read first)

Relay tool outputs verbatim — `fixHtml`, scan results, and verification verdicts
come from the tools, not from you. Do **NOT** invent quality, effectiveness, or
confidence claims (e.g. "Solid", "Bad fix", "No-op", "this should work") unless
they come directly from a tool result.

The only authoritative "did this fix work?" signal is the `verification` block
returned by `aether_scan_and_fix` / `aether_get_fix`, or a call to
`aether_verify_fix`. When you report on a fix, cite the measured fields:
`targetCleared`, `newViolations`, `resolvedViolations`, and `complianceDelta`.
Any added context must be labeled unverified and based only on provided data.

**Do not editorialize about the tools themselves.** Never rank, compare, or
comment on their speed, robustness, reliability, or which is "better" (e.g. "the
SPA scan is the most robust", "the single-URL scan is more reliable"). Select the
appropriate tool for the task and relay its results. If a tool returns no results
or fails, state that factually and try an alternative — without characterizing
the toolset.

**Never claim you "fixed" anything unless you actually changed source.** The
tools only *generate* suggested `fixHtml`; they do not modify any file. A fix is
only "applied"/"fixed"/"resolved" after you run `Edit` on real source **and** a
`verification` confirms `targetCleared: true`. When scanning a remote URL you do
not have the source for, `fixHtml` is a *recommendation only* — say so, and do
not imply anything was changed.

## 1. Scan

Call `aether_scan_and_fix` with the target URL (localhost or production). This is the recommended starting point — it scans AND generates fixes in one call. For a fast scan-only pass with no fix generation, set `maxFixes: 0`.

If the user provides HTML or a component instead of a URL, use `aether_check_html` for instant static analysis without needing a browser.

For SPAs (Angular/React/Vue), call `aether_scan_and_fix` with the `spa` block (`entryUrl`, optional `framework`/`routes`/`maxRoutes`) instead of `url`. It handles client-side routing, stability detection, and multi-route scanning, and returns a per-route breakdown.

## 2. Review

Present violations grouped by severity (critical first):
- **Critical** — blocks access entirely (missing alt, unlabeled inputs)
- **Serious** — significant barriers (low contrast, missing link text)
- **Moderate** — usability issues (missing landmarks, heading order)
- **Minor** — best practice issues (empty headings)

## 3. Fix

`fixHtml` is a *suggestion* — the tools never modify any file. What you do with
it depends on whether you have the source:

- **You have the local source** (localhost, a repo you can Read/Edit): locate the
  real element in source and apply the `fixHtml` with the Edit tool. Only after
  that Edit **and** a passing `verification` (`targetCleared: true`) may you say a
  violation is "fixed"/"applied".
- **Remote URL with no source access:** present the `fixHtml` as a *recommendation
  only*. Do not use the Edit tool on unrelated files and do not imply anything was
  changed. Make clear the developer must apply it in their own codebase.

The fixes come from a WCAG corpus and include proper ARIA patterns, not just
placeholder text.

If you need a fix for a specific element not covered in the scan results, call `aether_get_fix` with the rule ID and HTML.

If you need more details on a specific violation without an element to fix, call `aether_get_fix` with just the `ruleId` (omit `html`) — it returns WCAG technique code examples and failure pattern descriptions in explanation mode.

## 4. Verify

Verification is measured by the real Playwright + axe-core engine — never assert
a fix worked without it.

- **When a URL exists** (localhost or deployed): after applying fixes, call
  `aether_verify_fix` with the `url` (URL mode) to re-scan the live page. Pass
  the pre-fix violation set as `baseline` for a full new/resolved delta.
- **Before deploy / no URL:** call `aether_verify_fix` with `originalHtml` +
  `fixedHtml` (snippet mode) to diff the fix in isolation.

`aether_scan_and_fix` and `aether_get_fix` already attach a `verification` block
per fix — read it instead of re-verifying when the fix is unchanged.

Report the measured delta verbatim: `targetCleared`, any `newViolations`
(regressions), `resolvedViolations`, and `complianceDelta`. If `verification`
carries a `note` (e.g. snippet mode can't reproduce color-contrast), relay it
and prefer a URL re-scan.

## 5. Report

Summarize using measured facts only:
- Total violations found, and — per the `verification` verdicts — which fixes
  cleared their target (`targetCleared: true`) vs which did not.
- Any `newViolations` a fix introduced, and the net `complianceDelta`.
- WCAG success criteria addressed (from the tool output).
- Items the tools flagged for manual review (e.g. a `note` about dynamic-theme
  contrast or meaningful alt text). Do not add your own pass/fail judgments.

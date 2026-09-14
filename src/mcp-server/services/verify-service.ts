/**
 * Verify Service — deterministic fix verification on the real browser engine.
 *
 * Every "did this fix work?" answer here is MEASURED by the same headless
 * Chromium + axe-core engine that `aether_scan_url` / `aether_scan_and_fix` use
 * — never by regex heuristics or model opinion. Two modes:
 *
 *   - `verifySnippet`  → runs real axe on the original HTML and the fixed HTML
 *                        (via `ClusterScanner.scanHtml`) and DIFFS them. Fast,
 *                        deploy-free, but can't reproduce external-CSS or true
 *                        page-context rules (see `note`).
 *   - `verifyUrl`      → full real scan of a live URL (`scanUrl`). Optionally
 *                        diffs against a prior baseline for a full delta.
 *
 * Both reuse the shared warm Chromium via `withScanner`, and the same delta
 * engine (`snapshotViolations` + `diffSnapshots`) used by the scan scheduler.
 *
 * We NEVER read raw snippet violations: `page.setContent` wraps a fragment in a
 * full document, so page-level rules (html-has-lang, document-title, region,
 * landmark-*) appear as wrapper noise. Diffing original vs fixed cancels those
 * artifacts, leaving only what the fix changed.
 */

import { withScanner } from './scanner-manager.ts';
import {
  snapshotViolations,
  diffSnapshots,
  type ViolationSnapshot,
} from '../../concepts/a11y-scanner/scan-scheduler.ts';

/** A minimal violation identity surfaced in verification output. */
export interface ViolationRef {
  ruleId: string;
  target: string;
  impact?: string;
}

export interface VerificationResult {
  /** Always the real browser engine — no static analysis in verification. */
  engine: 'browser-axe';
  /** `snippet` = HTML string diff; `url` = live re-scan. */
  scope: 'snippet' | 'url';
  /** The axe rule the fix was meant to resolve. */
  targetRule: string;
  /** MEASURED: the target rule fired before and no longer fires after. */
  targetCleared: boolean;
  /** Regressions the fix introduced (present after, absent before). */
  newViolations: ViolationRef[];
  /** Improvements (present before, absent after). */
  resolvedViolations: ViolationRef[];
  /** Total violation counts before/after and the net reduction (positive = fewer). */
  complianceDelta: { before: number; after: number; net: number };
  /** If the target still fires, the nodes still flagged for it. */
  remaining?: ViolationRef[];
  /** Human-readable delta summary from `diffSnapshots`. */
  summary: string;
  /** Honest caveat (engine limitation / missing baseline). */
  note?: string;
}

export interface VerifySnippetArgs {
  ruleId: string;
  originalHtml: string;
  fixedHtml: string;
}

export interface VerifyUrlArgs {
  ruleId: string;
  url: string;
  /** Prior violation set (e.g. from an earlier scan) for a full delta. */
  baseline?: ViolationRef[];
}

/**
 * Rules that snippet mode cannot faithfully reproduce because they depend on
 * external stylesheets, computed layout, or true page context. When the target
 * is one of these we tell the caller to prefer a live URL re-scan.
 */
const SNIPPET_UNRELIABLE_RULES = new Set([
  'color-contrast',
  'color-contrast-enhanced',
  'link-in-text-block',
  'target-size',
  'scrollable-region-focusable',
]);

function toRef(s: ViolationSnapshot): ViolationRef {
  return { ruleId: s.ruleId, target: s.target, impact: s.impact };
}

/** Build snapshots from a caller-supplied baseline `{ruleId,target}[]`. */
function baselineToSnapshots(baseline: ViolationRef[]): ViolationSnapshot[] {
  return baseline.map((b) => ({
    key: `${b.ruleId}::${b.target}`,
    ruleId: b.ruleId,
    target: b.target,
    impact: b.impact,
  }));
}

/**
 * Verify a fix by running real axe on the original and fixed HTML strings and
 * diffing the results. Deterministically flags no-ops (nothing changes) and bad
 * fixes (target persists or a new rule appears).
 */
export async function verifySnippet(args: VerifySnippetArgs): Promise<VerificationResult> {
  const { ruleId, originalHtml, fixedHtml } = args;

  return withScanner(async (scanner) => {
    const [before, after] = await Promise.all([
      scanner.scanHtml(originalHtml),
      scanner.scanHtml(fixedHtml),
    ]);

    const beforeSnaps = snapshotViolations(before.violations);
    const afterSnaps = snapshotViolations(after.violations);
    const diff = diffSnapshots(beforeSnaps, afterSnaps);

    const firedBefore = beforeSnaps.some((s) => s.ruleId === ruleId);
    const firesAfter = afterSnaps.some((s) => s.ruleId === ruleId);
    const targetCleared = firedBefore && !firesAfter;

    const remaining = afterSnaps.filter((s) => s.ruleId === ruleId).map(toRef);

    const notes: string[] = [];
    if (!firedBefore) {
      notes.push(
        `Target rule "${ruleId}" did not fire on the original snippet (snippet mode wraps fragments in a full document, so element-level context may differ). Re-scan the live URL to confirm.`,
      );
    }
    if (SNIPPET_UNRELIABLE_RULES.has(ruleId)) {
      notes.push(
        `Rule "${ruleId}" depends on external CSS / computed layout that snippet mode cannot reproduce. Prefer verifyUrl against the live page for an authoritative result.`,
      );
    }

    return {
      engine: 'browser-axe' as const,
      scope: 'snippet' as const,
      targetRule: ruleId,
      targetCleared,
      newViolations: diff.newViolations.map(toRef),
      resolvedViolations: diff.fixedViolations.map(toRef),
      complianceDelta: {
        before: beforeSnaps.length,
        after: afterSnaps.length,
        net: beforeSnaps.length - afterSnaps.length,
      },
      ...(remaining.length > 0 ? { remaining } : {}),
      summary: diff.summary,
      ...(notes.length > 0 ? { note: notes.join(' ') } : {}),
    };
  });
}

/**
 * Verify against a live URL with a full real scan. With a `baseline` the result
 * carries a true new/resolved delta; without one it reports the current state
 * and notes that a baseline is required for a full delta.
 */
export async function verifyUrl(args: VerifyUrlArgs): Promise<VerificationResult> {
  const { ruleId, url, baseline } = args;

  return withScanner(async (scanner) => {
    const result = await scanner.scanUrl(url);

    if (!result || !result.success) {
      throw new Error(result?.error ?? 'Scan failed');
    }

    const currentSnaps = snapshotViolations(result.violations);
    const targetCleared = !currentSnaps.some((s) => s.ruleId === ruleId);
    const remaining = currentSnaps.filter((s) => s.ruleId === ruleId).map(toRef);

    if (baseline && baseline.length > 0) {
      const baseSnaps = baselineToSnapshots(baseline);
      const diff = diffSnapshots(baseSnaps, currentSnaps);
      return {
        engine: 'browser-axe' as const,
        scope: 'url' as const,
        targetRule: ruleId,
        targetCleared,
        newViolations: diff.newViolations.map(toRef),
        resolvedViolations: diff.fixedViolations.map(toRef),
        complianceDelta: {
          before: baseSnaps.length,
          after: currentSnaps.length,
          net: baseSnaps.length - currentSnaps.length,
        },
        ...(remaining.length > 0 ? { remaining } : {}),
        summary: diff.summary,
      };
    }

    // No baseline: report current state only.
    return {
      engine: 'browser-axe' as const,
      scope: 'url' as const,
      targetRule: ruleId,
      targetCleared,
      newViolations: [],
      resolvedViolations: [],
      complianceDelta: {
        before: currentSnaps.length,
        after: currentSnaps.length,
        net: 0,
      },
      ...(remaining.length > 0 ? { remaining } : {}),
      summary: targetCleared
        ? `Rule "${ruleId}" is not present after scan. ${currentSnaps.length} total violation(s) on the page.`
        : `Rule "${ruleId}" still fires (${remaining.length} node(s)). ${currentSnaps.length} total violation(s) on the page.`,
      note: 'No baseline supplied — reporting current state only. Pass the pre-fix violation set as `baseline` for a full new/resolved delta.',
    };
  });
}

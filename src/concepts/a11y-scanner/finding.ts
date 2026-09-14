/**
 * Finding assembly — fuse axe violations with grounded WCAG guidance into the
 * single Finding object every surface renders.
 *
 * Responsibilities:
 *   1. Fingerprint each issue as sha1(axeRule + elementRole + chosenTechnique)
 *      so the same grounded issue is stable and collapsible.
 *   2. Deduplicate within a scan: identical fingerprints collapse into one
 *      Finding, summing occurrences and unioning CSS targets.
 *   3. Apply `sharesRemediationWith`: cluster axe rules that share a single
 *      root-cause fix so reports surface the primary fix once instead of N times.
 *
 * The grounding gate itself lives in the Python insights engine
 * (`ontology/`); this module is the TypeScript consumer of its output
 * (`grounded`, `rejectedTechniques`, `element`) plus the owner of the
 * within-scan shared-remediation link (per the serialization contract).
 */

import { createHash } from 'node:crypto';
import type { ArtifactVersions, Violation, ViolationGuidance, ViolationNode } from '../../types/a11y';
import type { Finding } from '../../types/finding';

/**
 * Rules where a zero-area tracking pixel is genuinely noise, not a defect a
 * developer should chase (SME Issue 5). A 1x1 analytics beacon has no accessible
 * name to fix — flagging its missing `title`/`alt` wastes reviewer time. Scoped
 * deliberately: a missing alt on a *real* image is always a defect.
 */
const NOISE_SUPPRESSIBLE_RULES = new Set(['frame-title', 'image-alt']);

/**
 * True when a node is a tracking-pixel false-positive for a suppressible rule:
 * Tier-1 layout flagged it a tracking pixel AND it is hidden by an ancestor or
 * injected at the end of `<body>` (both hallmarks of an off-content beacon).
 * Requiring the second signal keeps a genuinely small-but-visible control from
 * being misclassified.
 */
function isTrackingPixelNoise(ruleId: string, node: ViolationNode): boolean {
  if (!NOISE_SUPPRESSIBLE_RULES.has(ruleId)) return false;
  const layout = node.layout;
  if (!layout) return false;
  return !!layout.isTrackingPixel && (!!layout.hiddenByAncestor || !!layout.atEndOfBody);
}

/**
 * Shared-remediation clusters — the TypeScript mirror of the ontology's
 * SHARED_REMEDIATION_GROUPS (source of truth in
 * `insights-engine/ontology/rules.py`). Kept here because the within-scan link
 * is applied on the aggregator side.
 */
export interface SharedRemediationGroup {
  templateId: string;
  axeRules: string[];
  primaryRule: string;
  note: string;
}

export const SHARED_REMEDIATION_GROUPS: SharedRemediationGroup[] = [
  {
    templateId: 'wrap-in-main',
    axeRules: ['landmark-one-main', 'region'],
    primaryRule: 'landmark-one-main',
    note:
      'Add the <main> landmark first — it resolves the bulk of downstream ' +
      "'content outside landmark' (region) instances.",
  },
];

/** Return the shared-remediation group an axe rule belongs to, if any. */
export function sharedGroupForRule(axeRule: string): SharedRemediationGroup | undefined {
  return SHARED_REMEDIATION_GROUPS.find((g) => g.axeRules.includes(axeRule));
}

/**
 * Stable fingerprint for a grounded issue.
 * sha1(axeRule + elementRole + chosenTechnique) — the same rule on the same
 * kind of element with the same chosen fix always hashes identically.
 */
export function computeFingerprint(
  axeRule: string,
  elementRole: string,
  chosenTechnique: string,
): string {
  return createHash('sha1')
    .update(`${axeRule}\u0000${elementRole}\u0000${chosenTechnique}`)
    .digest('hex');
}

function targetsOf(violation: Violation): string[] {
  const out: string[] = [];
  for (const node of violation.nodes ?? []) {
    if (Array.isArray(node.target)) out.push(node.target.join(' '));
    else if (node.target) out.push(String(node.target));
  }
  return out;
}

/**
 * Mint a stable finding id from the scan id + fingerprint. Deterministic so the
 * same collapsed issue in a scan always yields the same id (feedback key).
 */
export function computeFindingId(scanId: string, fingerprint: string): string {
  const h = createHash('sha1').update(`${scanId}\u0000${fingerprint}`).digest('hex');
  return `f_${h.slice(0, 16)}`;
}

export interface BuildFindingsOptions {
  /** Groups all findings of one scan run; also seeds the finding id. */
  scanId?: string;
  /** Component version stamps echoed from the insights response (§2). */
  versions?: ArtifactVersions;
  /** Rendering mode set by the producing tool (§5). */
  renderMode?: 'deterministic' | 'grounded_semantic';
}

/**
 * Build the collapsed, grounded Finding list for a scan.
 *
 * @param violations  axe violations (already viewport-merged).
 * @param guidance    per-rule grounded guidance from the insights API.
 * @param options     scan-level identity/version stamps (§2).
 */
export function buildFindings(
  violations: Violation[],
  guidance?: ViolationGuidance[],
  options?: BuildFindingsOptions,
): Finding[] {
  const guidanceByRule = new Map<string, ViolationGuidance>();
  for (const g of guidance ?? []) guidanceByRule.set(g.violationId, g);

  const scanId = options?.scanId;
  const byFingerprint = new Map<string, Finding>();
  const order: string[] = [];

  for (const violation of violations) {
    const g = guidanceByRule.get(violation.id);
    const elementRole = g?.element?.role ?? g?.element?.tag ?? '';
    const chosenTechnique = g?.techniques?.[0]?.technique_id ?? '';
    const fingerprint = computeFingerprint(violation.id, elementRole, chosenTechnique);

    const targets = targetsOf(violation);
    const occurrences = Math.max(violation.nodes?.length ?? 0, targets.length, 1);
    // First captured node's screenshots (CLI/pipeline report only; desktop-only).
    const screenshot = violation.nodes?.find((n) => n.screenshot)?.screenshot;
    // Tier-1 tracking-pixel noise (SME Issue 5) — count suppressible nodes.
    const noiseNodes = (violation.nodes ?? []).filter((n) => isTrackingPixelNoise(violation.id, n)).length;

    const existing = byFingerprint.get(fingerprint);
    if (existing) {
      existing.occurrences += occurrences;
      for (const t of targets) if (!existing.targets.includes(t)) existing.targets.push(t);
      // Keep the first non-empty screenshot when issues collapse.
      if (!existing.screenshot && screenshot) existing.screenshot = screenshot;
      // Accumulate noise count across collapsed occurrences.
      if (noiseNodes > 0) {
        existing.noise = {
          suppressed: false,
          reason: 'tracking-pixel',
          count: (existing.noise?.count ?? 0) + noiseNodes,
        };
      }
      continue;
    }

    const finding: Finding = {
      // ---- What's wrong (identity) ----
      findingId: computeFindingId(scanId ?? '', fingerprint),
      axeRule: violation.id,
      description: violation.description,
      impact: violation.impact,
      // ---- The fix first (SME Issue 2: lead with the actionable answer) ----
      fixHtml: g?.fixHtml,
      fixExplanation: g?.fixExplanation,
      fixTier: g?.fixTier,
      confidence: g?.confidence,
      rationale: g?.rationale,
      // Element screenshots (CLI/pipeline report only; carried from the node).
      ...(screenshot && { screenshot }),
      // ---- Supporting WCAG context ----
      wcagCriteria: (g?.criteria ?? []).map((c) => ({ sc: c.sc_num, title: c.title, level: c.level })),
      techniques: (g?.techniques ?? []).map((t) => ({
        id: t.technique_id,
        title: t.title,
        description: t.description,
        codeSnippet: t.code_snippet,
      })),
      failures: (g?.failures ?? []).map((f) => ({
        id: f.failure_id,
        title: f.title,
        description: f.description,
        codeSnippet: f.code_snippet,
      })),
      // ---- Provenance / grounding ----
      scanId,
      renderMode: options?.renderMode,
      versions: options?.versions,
      fingerprint,
      element: g?.element,
      chosenTechnique,
      // Default true when the gate did not run (scan-only / template fallback),
      // so ungated flows are not falsely reported as "not grounded".
      grounded: g?.grounded ?? true,
      path: g?.path,
      rejectedTechniques: g?.rejectedTechniques ?? [],
      occurrences,
      targets,
      sharesRemediationWith: [],
      isPrimaryRemediation: false,
      ...(noiseNodes > 0 && {
        noise: { suppressed: false, reason: 'tracking-pixel' as const, count: noiseNodes },
      }),
    };

    byFingerprint.set(fingerprint, finding);
    order.push(fingerprint);
  }

  const findings = order.map((fp) => byFingerprint.get(fp)!);
  // Resolve suppression once collapse is complete: suppress only when EVERY
  // occurrence is tracking-pixel noise (a mix keeps the finding actionable).
  for (const finding of findings) {
    if (finding.noise) finding.noise.suppressed = finding.noise.count >= finding.occurrences;
  }
  applySharedRemediation(findings);
  return findings;
}

/**
 * Link findings whose axe rules cluster onto one root-cause fix. For each group
 * present in the scan, every member points at its siblings and the group's
 * primary rule is flagged so reports can fix it first.
 */
function applySharedRemediation(findings: Finding[]): void {
  const rulesPresent = new Set(findings.map((f) => f.axeRule));

  for (const finding of findings) {
    const group = sharedGroupForRule(finding.axeRule);
    if (!group) continue;

    finding.sharesRemediationWith = group.axeRules.filter(
      (r) => r !== finding.axeRule && rulesPresent.has(r),
    );
    finding.isPrimaryRemediation = group.primaryRule === finding.axeRule;
  }
}

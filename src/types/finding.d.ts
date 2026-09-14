/**
 * Finding — the single enriched object every delivery surface renders.
 *
 * A Finding fuses an axe violation with its grounded WCAG guidance (criteria,
 * accepted techniques/failures, the chosen fix) and the grounding-gate verdict
 * (grounded flag + rejected techniques). It carries a stable `fingerprint` so
 * the same issue collapses to one row within a scan, and `sharesRemediationWith`
 * so clustered root-cause fixes (e.g. add <main> resolves many `region` hits)
 * are surfaced instead of repeated.
 *
 * Reports show the collapsed, grounded fix by default; corpus depth
 * (all techniques/failures, rejected candidates) sits behind progressive
 * disclosure.
 */

import type {
  GroundedElement,
  RejectedTechnique,
  GroundingPath,
  FixTier,
  Confidence,
  Rationale,
  ArtifactVersions,
  ViolationShots,
} from './a11y';

/**
 * Feedback captured against a finding (schema present from day 1; §6).
 * Populated by the feedback-submission path, not by buildFindings.
 */
export interface Feedback {
  rating: 'useful' | 'not_useful' | null;
  reason_code:
    | 'wrong_fix'
    | 'didnt_apply'
    | 'broke_something'
    | 'unclear'
    | 'wrong_technique'
    | 'other'
    | null;
  developer_correction: string | null;
  free_text: string | null;
  rated_by: string | null;
  rated_at: string | null;
}

/**
 * Post-MVP interpretive surface (schema only at MVP; §5.5). Never populated or
 * rendered by the MVP tools; exists so the artifact shape is stable from day 1.
 */
export interface SemanticSurface {
  populated: boolean;
  cluster_id: string | null;
  narrative: string | null;
  cited_findings: string[];
}

export interface Finding {
  // ---- What's wrong (identity) ----
  /** Stable, unique per collapsed finding within a scan. `f_<sha1-prefix>`. */
  findingId: string;
  /** The axe rule id (e.g. "image-alt", "aria-allowed-attr"). */
  axeRule: string;
  description: string;
  impact?: string;

  // ---- The fix first (SME Issue 2: lead with the actionable answer) ----
  fixHtml?: string;
  fixExplanation?: string;
  /** Which fix-builder tier produced the fix. */
  fixTier?: FixTier;
  /** Confidence tier — grounded/best_effort/abstain. */
  confidence?: Confidence;
  /** Synthesized rationale (templated-first). Renderers use this, not raw chunks. */
  rationale?: Rationale;

  /**
   * Element screenshots for this finding (CLI/pipeline report only). Carried
   * from the first collapsed node that captured them. Never set for MCP.
   */
  screenshot?: ViolationShots;

  // ---- Supporting WCAG context ----
  wcagCriteria: Array<{ sc: string; title: string; level: string }>;
  techniques: Array<{ id: string; title?: string; description: string; codeSnippet?: string }>;
  failures: Array<{ id: string; title?: string; description: string; codeSnippet?: string }>;

  // ---- Provenance / grounding (§2, §3) ----
  /** Groups findings from one scan run. */
  scanId?: string;
  /** Rendering mode set by the producing tool (§5). */
  renderMode?: 'deterministic' | 'grounded_semantic';
  /** Component version stamps for feedback attribution (§2). */
  versions?: ArtifactVersions;
  /** sha1(axeRule + elementRole + chosenTechnique) — stable within & across scans. */
  fingerprint: string;
  /** The offending element as derived by the grounding layer (if available). */
  element?: GroundedElement;
  /** Top accepted technique id used for the chosen fix ('' when none). */
  chosenTechnique: string;
  /** Gate verdict: true when at least one cited technique passed the gate. */
  grounded: boolean;
  /** How the technique candidates were sourced (drives confidence). */
  path?: GroundingPath;
  /** Candidates the gate rejected (hallucination classes), kept for audit. */
  rejectedTechniques: RejectedTechnique[];

  /** How many element instances collapsed under this fingerprint within the scan. */
  occurrences: number;
  /** The CSS targets collapsed under this finding. */
  targets: string[];

  /** Other axe rules present in this scan that share this finding's root-cause fix. */
  sharesRemediationWith: string[];
  /** True when this rule is the primary (fix-first) rule of its remediation group. */
  isPrimaryRemediation: boolean;

  /**
   * Noise classification (SME Issue 5). Present only when every collapsed node
   * of this finding is a tracking-pixel false-positive — a zero-area analytics
   * beacon failing `frame-title`/`image-alt` while hidden by an ancestor or
   * injected at the end of `<body>`. Derived from Tier-1 `node.layout`. The
   * finding is NOT dropped (an honest count must not silently shrink and a real
   * regression must not be masked); reports render it de-emphasized/collapsed.
   */
  noise?: {
    suppressed: boolean;
    reason: 'tracking-pixel';
    /** How many of the collapsed occurrences matched the noise signal. */
    count: number;
  };

  // ---- Feedback + post-MVP semantic (schema from day 1) ----
  feedback?: Feedback;
  semantic?: SemanticSurface;
}

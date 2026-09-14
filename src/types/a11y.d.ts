export interface Violation {
  id: string;
  description: string;
  impact?: string;
  helpUrl?: string;
  help?: string;
  nodes?: ViolationNode[];
}

export interface ViolationNode {
  html: string;
  target?: string | string[];
  failureSummary?: string;
  parentHtml?: string;    // outerHTML of parent element (truncated to 500 chars)
  childrenHtml?: string;  // innerHTML of the element itself (truncated to 1000 chars)
  siblingHtml?: string;   // sibling opening tags (attrs only) for tight lockups (≤4 children), 500 chars — lets contrast flag logo-adjacent text
  /**
   * axe-core's own per-node diagnostics (the `any`/`all`/`none` check buckets).
   * Previously discarded at the map step; captured so the fix pipeline can use
   * the structured `data`/`relatedNodes` axe already computed (Tier 0). Flows to
   * BOTH the CLI report and the MCP plugin (it's free — axe's own output).
   */
  checks?: NodeChecks;
  /**
   * Live-DOM geometry + hidden-state axe never captures (Tier 1). Populated
   * desktop-only, best-effort. Drives tracking-pixel suppression in finding.ts
   * (SME Issue 5). Small metadata (numbers/booleans) — flows to BOTH the CLI
   * report and the MCP plugin; only heavy screenshot images stay MCP-off.
   */
  layout?: NodeLayout;
  /**
   * Tabular context axe never provides (Tier 2). For `empty-table-header` we
   * walk the column's data cells so the fix can suggest a real header name and
   * explain the header↔cell harm (SME Issue 4). Small strings — flows to BOTH
   * the CLI report and the MCP plugin.
   */
  table?: TableContext;
  /**
   * Resolved idref context (Tier 2). Confirms an `aria-controls` listbox and
   * `aria-activedescendant` wiring so the combobox fix (SME Issue 3) can emit
   * the full WAI-APG pattern. Small metadata — flows to BOTH surfaces.
   */
  refs?: ReferencedContext;
  /**
   * Element screenshots (CLI/pipeline report only — never populated for MCP).
   * Captured desktop-only, best-effort, in Phase 1. See `screenshot.ts`.
   */
  screenshot?: ViolationShots;
}

/**
 * Column context for an empty `<th>` (SME Issue 4). axe reports `data:null` and
 * no related nodes for `empty-table-header`, so a meaningful fix requires
 * traversing the column's data cells — done best-effort from the live page.
 */
export interface TableContext {
  columnIndex: number;
  sampleCells: string[];        // text of the column's data cells (first K rows, trimmed)
  suggestedHeader?: string;     // conservative heuristic from sampleCells (may be absent)
  isRowHeader?: boolean;        // scope="row" / first-column header (column traversal N/A)
}

/**
 * Resolved reference wiring for a control (SME Issue 3 combobox). Populated from
 * the live DOM: does the `aria-controls` idref resolve to a listbox, is
 * `aria-activedescendant` present, and the `label[for]`/labelled-by target.
 */
export interface ReferencedContext {
  controls?: AxeRelatedNode;        // aria-controls target (combobox → listbox)
  hasActiveDescendant?: boolean;
  labelledBy?: AxeRelatedNode;      // aria-labelledby / label[for] ↔ control
}

/**
 * Geometry and visibility of a violating element, captured from the live
 * Playwright page (axe reports none of this). Used to tell a genuine defect
 * from an off-tree/zero-area tracking pixel (SME Issue 5). All fields optional
 * so a partial/failed capture is never ambiguous.
 */
export interface NodeLayout {
  boundingBox?: { x: number; y: number; width: number; height: number };
  display?: string;
  visibility?: string;
  opacity?: number;
  hiddenByAncestor?: boolean;   // an ancestor is aria-hidden / inert / display:none / visibility:hidden
  atEndOfBody?: boolean;        // element sits among the last children of <body>
  isTrackingPixel?: boolean;    // zero/near-zero area, or a beacon/analytics src
}

/**
 * A related element axe points at inside a check result (e.g. the duplicate
 * landmark for `landmark-unique`, or the offending children for
 * `aria-required-children`). Trimmed to bound payload size.
 */
export interface AxeRelatedNode {
  html: string;               // outerHTML, truncated
  target?: string | string[];
}

/**
 * One axe check result within a node's any/all/none bucket. `data` is
 * deliberately polymorphic (null | object | array | string) — axe uses it
 * differently per rule (e.g. color-contrast → object of colors; aria-allowed-attr
 * → array of attrs; listitem → {messageKey}).
 */
export interface AxeCheckResult {
  id: string;
  impact?: string;
  message?: string;
  data?: unknown;
  relatedNodes?: AxeRelatedNode[];
}

export interface NodeChecks {
  any: AxeCheckResult[];
  all: AxeCheckResult[];
  none: AxeCheckResult[];
}

/**
 * The pair of element screenshots attached to a violation node for the
 * CLI/pipeline report. `crop`/`context` are either a relative report path
 * (default `--json-screenshots=paths`) or a base64 data URI (`=base64`).
 */
export interface ViolationShots {
  crop?: string;
  context?: string;
  boundingBox?: { x: number; y: number; width: number; height: number };
  viewport?: 'desktop' | 'tablet' | 'mobile';   // viewport the shot was captured at (first-seen)
  /**
   * Caption shown when capture was skipped or only partial, so a missing image
   * is never ambiguous: non-rendered metadata element, element hidden at the
   * desktop capture viewport (responsive/mobile-only), a zero-area/tracking
   * pixel, or a page-level issue rendered as a single full-page shot.
   */
  note?: string;
}

export interface ViewportResult {
  viewport: string;
  width: number;
  height: number;
  violations: Violation[];
  statistics: {
    critical: number;
    serious: number;
    moderate: number;
    minor: number;
    total: number;
  };
}

export interface CorpusInsight {
  criterionId: string;
  criterionLevel?: string;
  failureCount: number;
  techniqueCount: number;
  relatedCriteria: string[];
  failures: Array<{ failure_id?: string; description: string; code_snippet?: string }>;
  techniques: Array<{ technique_id?: string; description: string; code_snippet?: string }>;
}

export interface ViolationPattern {
  pattern: string;
  description: string;
  violationIds: string[];
  affectedElements: number;
  severity: string;
  criterionId?: string;
}

export interface GroundedElement {
  tag: string;
  role?: string;
  key: string;
  categories: string[];
}

export interface RejectedTechnique {
  id: string;
  reason: string;
}

// ---- Grounded Artifact primitives (docs/grounded-artifact-schema.md) ----

/** How the technique candidates were sourced (drives confidence). */
export type GroundingPath = 'curated_edge' | 'embedding_ranked' | 'permissive_no_edge';

/** Which fix-builder tier produced the fix. */
export type FixTier = 'template' | 'kb_example' | 'llm';

/** Confidence tier — grounded/best_effort/abstain are first-class (§4). */
export type ConfidenceTier = 'grounded' | 'best_effort' | 'abstain';

export interface Confidence {
  tier: ConfidenceTier;
  reasons: string[];
  review_recommended: boolean;
}

/** A single synthesized rationale field. `source` stamps the ladder rung (§3). */
export interface RationaleField {
  text: string | null;
  source: 'templated' | 'llm_from_chunk' | null;
}

export interface Rationale {
  why_it_fails: RationaleField;
  why_fix_works: RationaleField;
  /** Provenance ref only — NEVER rendered as the explanation (§3). */
  raw_chunk_ref?: string | null;
}

/** Component version stamps for feedback attribution (§2). */
export type ArtifactVersions = Record<string, string>;

export interface ViolationGuidance {
  violationId: string;
  // ---- The fix first (SME Issue 2: lead with the actionable answer) ----
  fixHtml?: string;
  fixExplanation?: string;
  fixTier?: FixTier;
  confidence?: Confidence;
  rationale?: Rationale;
  // ---- Supporting WCAG context ----
  criteria: Array<{ sc_num: string; title: string; level: string }>;
  techniques: Array<{ technique_id: string; title?: string; description: string; code_snippet?: string }>;
  failures: Array<{ failure_id: string; title?: string; description: string; code_snippet?: string }>;
  // Grounding-gate outputs (present when the insights API ran the ontology gate).
  // Optional so template/metadata fallbacks and older API responses stay valid.
  grounded?: boolean;
  rejectedTechniques?: RejectedTechnique[];
  element?: GroundedElement;
  // ---- Grounded Artifact fields (populated by the insights API) ----
  path?: GroundingPath;
  /** True when the Tier-3 LLM budget (per-request or global daily) ran out before this violation. */
  budgetExhausted?: boolean;
  /** Set when the output sanitizer discarded a generated fix (reason codes, e.g. 'active_content:script'). */
  fixRejected?: string;
}

export interface InsightsResult {
  summary: string;
  rootCause: string;
  rootCausePatterns?: Array<{
    type: string;
    criterion?: string;
    description: string;
    violation_ids?: string[];
    total_elements?: number;
  }>;
  userImpact: string;
  priorityFixes: string[];
  wcagReferences: string[];
  corpusInsights?: CorpusInsight[];
  violationPatterns?: ViolationPattern[];
  violationGuidance?: ViolationGuidance[];
  /** Component version stamps for feedback attribution (§2). */
  versions?: ArtifactVersions;
}

export interface PageScanResult {
  url: string;
  violations: Violation[];
  scanDate: string;
  success: boolean;
  error?: string;
  insights?: InsightsResult;
  insightsError?: string;
  viewportResults?: ViewportResult[];
  uiAutomationResults?: import('./ui-automation').UIAutomationSequenceResult;
  // SPA-scan annotations (populated by SPAScanner only)
  route?: string;
  stateKey?: string;
  stabilityStrategy?: string;
  discoveryMethod?: 'manual' | 'crawled';
}

/** Descriptor for the element-screenshot artifacts of a scan (report metadata). */
export interface ScreenshotsMetadata {
  enabled: boolean;
  mode?: 'inline' | 'files' | 'both';
  jsonMode?: 'paths' | 'base64' | 'none';
  format?: 'webp' | 'png';
  types?: string[];
  directory?: string;
  count?: number;
  /** `local` (Phase 1) — foreshadows the Phase-2 `gcs` value. */
  storage?: 'local' | 'gcs';
  /** Whether consent/overlay scrims were suppressed during capture. */
  overlaySuppression?: boolean;
}

export interface ScanReport {
  metadata: {
    url: string;
    scanDate: string;
    pageScanned: string;
    standard: string;
    screenshots?: ScreenshotsMetadata;
  };
  statistics: {
    critical: number;
    serious: number;
    moderate: number;
    minor: number;
    total: number;
  };
  summary: string;
  violations: Violation[];
  insights?: InsightsResult;
  insightsError?: string;
  findings?: import('./finding').Finding[];
  viewportResults?: ViewportResult[];
  uiAutomationResults?: import('./ui-automation').UIAutomationSequenceResult;
  pipeline?: {
    failOn: string;
    threshold: number;
    failingViolations: number;
    passed: boolean;
    elapsedMs: number;
    timestamp: string;
  };
}

// ============================================================================
// SSE Streaming Types
// ============================================================================

export interface SSEProgressEvent {
  event: string;
  data: Record<string, unknown>;
}

export interface AsyncJobResponse {
  jobId: string;
  statusUrl: string;
  mode: 'async';
}

export interface JobStatus {
  jobId: string;
  status: 'pending' | 'running' | 'complete' | 'failed';
  progress: number;
  total: number;
  result?: InsightsResult;
  error?: string;
}

export interface StreamOptions {
  onProgress?: (event: SSEProgressEvent) => void;
}

// ============================================================================
// Multi-Page Scan Types
// ============================================================================

export interface MultiPageScanReport {
  metadata: {
    domain: string;
    scanDate: string;
    pagesScanned: number;
    standard: string;
  };
  statistics: {
    critical: number;
    serious: number;
    moderate: number;
    minor: number;
    total: number;
    pagesWithIssues: number;
  };
  summary: string;
  pageResults: PageScanResult[];
  pipeline?: {
    failOn: string;
    threshold: number;
    failingViolations: number;
    passed: boolean;
    elapsedMs: number;
    timestamp: string;
  };
}

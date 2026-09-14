import type { Violation, ViewportResult, InsightsResult } from './a11y';
import type { UIAutomationStep, UIAutomationSequenceResult } from './ui-automation';

// ============================================================================
// Framework hint
// ============================================================================

export type SPAFramework = 'angular' | 'react' | 'vue' | 'generic';

// ============================================================================
// Config (loaded from JSON)
// ============================================================================

/**
 * Discovery mode — only `manual` is supported in Milestone 1.
 * `auto` and `both` are reserved for Milestone 2.
 */
export type SPADiscoveryMode = 'manual' | 'auto' | 'both';

export interface SPADiscoveryConfig {
  mode: SPADiscoveryMode;
  /** Reserved for Milestone 2 */
  maxRoutes?: number;
  /** Reserved for Milestone 2 */
  excludePatterns?: string[];
}

/**
 * Per-route stability overrides. When set, these take precedence over
 * the global `stability` block of SPAScanConfig for this route only.
 */
export interface SPAStabilityOverrides {
  mutationDebounceMs?: number;
  angularTestabilityTimeoutMs?: number;
  maxTimeoutMs?: number;
}

export interface SPARouteConfig {
  /** Client-side route path, e.g. "/dashboard" or "#/users/new" */
  path: string;
  /**
   * Human-readable name for the route. Used as part of the state fingerprint,
   * so two routes with the same `path` but different `name` are reported as
   * distinct scans (fixes Pa11y #98-class bug).
   */
  name: string;
  /** Steps to run after navigation, before axe scan */
  interactions?: UIAutomationStep[];
  /**
   * Layer 5 escape hatch — if provided, scanner will waitForSelector(...)
   * as part of the stability cascade before running axe.
   */
  waitForSelector?: string;
  /** Route-specific stability timing overrides */
  stabilityOverrides?: SPAStabilityOverrides;
}

export interface SPAStabilityConfig {
  /** MutationObserver quiet period in ms. Default: framework-specific. */
  mutationDebounceMs?: number;
  /**
   * Max time to wait for Angular Testability `isStable()` to resolve.
   * Guards against the setInterval-in-NgZone deadlock bug.
   * Default: 5000ms.
   */
  angularTestabilityTimeoutMs?: number;
  /** Hard cap per route — always terminates regardless of which layer is running. Default: 15000ms. */
  maxTimeoutMs?: number;
}

export interface SPAAuthConfig {
  /** Steps to run once at startup before any route scanning */
  steps: UIAutomationStep[];
}

export interface SPAScanConfig {
  /** Entry URL — the scanner navigates here once, then client-side routes from there */
  entryUrl: string;
  /** Framework hint — drives default stability timings */
  framework: SPAFramework;
  discovery: SPADiscoveryConfig;
  routes: SPARouteConfig[];
  stability?: SPAStabilityConfig;
  auth?: SPAAuthConfig;
  /**
   * GUARDRAIL: must never be set. Scanner refuses to run if present.
   * Exists only so we can detect and reject legacy configs from other tools.
   * @deprecated Do not use. `networkidle` is unreliable on SPAs — use the
   *             stability cascade instead.
   */
  networkIdle?: never;
}

// ============================================================================
// Results
// ============================================================================

/**
 * Which strategy in the stability cascade "won" for a given page.
 * See spa-stability.ts for the layer definitions.
 */
export type SPAStabilityStrategy =
  | 'domcontentloaded'
  | 'angular-testability'
  | 'angular-testability-timeout' // fell through due to deadlock guard
  | 'hashchange'
  | 'mutation-observer'
  | 'wait-for-selector'
  | 'hard-timeout';

export interface SPARouteResult {
  /** Original route config path, e.g. "/dashboard" */
  route: string;
  /** Full URL scanned (after fragment preservation) */
  url: string;
  /**
   * `${url}#${stateFingerprint}` — the key under which this result is stored.
   * Same URL with different state fingerprints produces distinct results.
   * This is the Pa11y #98 fix at the data-model level.
   */
  stateKey: string;
  /** SHA-1 of body.innerHTML.length + visibleHeadings + routeName */
  stateFingerprint: string;
  /** Human-readable name from route config */
  routeName: string;
  /** Which stability strategy resolved first for this route */
  stabilityStrategy: SPAStabilityStrategy;
  /** Time spent waiting for stability, ms */
  stabilityDurationMs: number;
  /** How the route was discovered. Always `manual` in Milestone 1. */
  discoveryMethod: 'manual' | 'crawled';
  violations: Violation[];
  viewportResults?: ViewportResult[];
  scanDate: string;
  success: boolean;
  error?: string;
  insights?: InsightsResult;
  uiAutomationResults?: UIAutomationSequenceResult;
}

export interface SPAStabilityMetrics {
  /** Per-layer win counts across all routes — observability for customers tuning their config */
  winsByStrategy: Record<SPAStabilityStrategy, number>;
  totalRoutes: number;
  averageDurationMs: number;
}

export interface SPAScanReport {
  metadata: {
    entryUrl: string;
    framework: SPAFramework;
    scanDate: string;
    routesScanned: number;
    standard: string;
  };
  statistics: {
    critical: number;
    serious: number;
    moderate: number;
    minor: number;
    total: number;
    routesWithIssues: number;
  };
  summary: string;
  routeResults: SPARouteResult[];
  stabilityMetrics: SPAStabilityMetrics;
  pipeline?: {
    failOn: string;
    threshold: number;
    failingViolations: number;
    passed: boolean;
    elapsedMs: number;
    timestamp: string;
  };
}

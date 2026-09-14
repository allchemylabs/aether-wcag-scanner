/**
 * aether_scan_and_fix — Hero tool (expected 80% of usage).
 *
 * Combined scan + fix. Scans a target for WCAG violations, then calls the RAG
 * API to generate fixes for the top N most severe violations. Returns
 * violations paired with fixes in one response.
 *
 * Two scan modes, selected by input:
 *   • Single page  — pass `url`. Scans across desktop/tablet/mobile viewports
 *     (filterable via `viewport`) using the shared cluster scanner.
 *   • SPA          — pass `spa` { entryUrl, framework?, routes?, maxRoutes? }.
 *     Framework-aware, multi-route scan; returns per-route breakdown.
 *
 * Set `maxFixes: 0` for a fast scan-only pass (no cloud RAG calls).
 */

import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { withScanner } from '../services/scanner-manager.ts';
import { interleaveByRule } from './fix-priority.ts';
import { getFix } from '../services/fix-service.ts';
import { logToolEntry, logError } from '../services/log.ts';
import type { RateLimitInfo, TierInfo } from '../services/fix-service.ts';
import type { GroundedElement, RejectedTechnique, GroundingPath, Confidence, FixTier, Rationale } from '../../types/a11y';
import { verifySnippet } from '../services/verify-service.ts';
import type { VerificationResult } from '../services/verify-service.ts';
import { calculateViolationStats } from '../../concepts/a11y-scanner/stats.ts';
import type { Violation } from '../../types/a11y';
import { SPAScanner } from '../../concepts/a11y-scanner/spa-scanner.ts';
import type { SPAScanConfig, SPAFramework, SPARouteConfig } from '../../types/spa-config';
import { toolError } from './tool-response.ts';
import { isScannableUrl } from '../../concepts/a11y-scanner/url-guard.ts';

const URL_GUARD_MESSAGE = 'Only http(s) URLs to non-metadata hosts can be scanned';

/** Route paths may be relative ("/dashboard", "/#/x") or absolute same-scheme URLs. */
function isScannableRoutePath(path: string): boolean {
  return !/^[a-z][a-z0-9+.-]*:/i.test(path) || isScannableUrl(path);
}

const SEVERITY_ORDER: Record<string, number> = {
  critical: 4,
  serious: 3,
  moderate: 2,
  minor: 1,
};

const SpaInput = z
  .object({
    entryUrl: z
      .string()
      .url()
      .max(2048)
      .refine(isScannableUrl, URL_GUARD_MESSAGE)
      .describe('The SPA entry URL (e.g. http://localhost:4200)'),
    framework: z
      .enum(['angular', 'react', 'vue', 'generic'])
      .optional()
      .default('generic')
      .describe('Frontend framework. Auto-detected if "generic".'),
    routes: z
      .array(
        z.object({
          path: z
            .string()
            .max(2048)
            .refine(isScannableRoutePath, URL_GUARD_MESSAGE)
            .describe('Route path (e.g. "/dashboard", "/#/settings")'),
          name: z.string().max(200).describe('Human-readable route name'),
        }),
      )
      .max(100)
      .optional()
      .default([])
      .describe('Manually-specified routes to scan (max 100). Empty = auto-discover.'),
    maxRoutes: z
      .number()
      .int()
      .min(1)
      .max(100)
      .optional()
      .default(20)
      .describe('Maximum routes to discover automatically (default 20)'),
  })
  .refine(
    (spa) =>
      spa.routes.every((r) => {
        // Absolute route URLs must share the entry origin — the scanner never
        // hops off the site it was pointed at (protocol-relative "//x" too).
        try {
          return new URL(r.path, spa.entryUrl).origin === new URL(spa.entryUrl).origin;
        } catch {
          return false;
        }
      }),
    'Every route must resolve to the same origin as entryUrl',
  )
  .describe(
    'Scan a Single-Page Application across multiple routes instead of a single ' +
      'URL. Presence of this block selects SPA mode. Mutually exclusive with `url`.',
  );

const ScanAndFixInput = {
  url: z
    .string()
    .url()
    .max(2048)
    .refine(isScannableUrl, URL_GUARD_MESSAGE)
    .optional()
    .describe('Single-page target URL (e.g. http://localhost:3000). Provide this OR `spa`, not both.'),
  spa: SpaInput.optional(),
  viewport: z
    .enum(['all', 'desktop', 'tablet', 'mobile'])
    .optional()
    .default('all')
    .describe('Single-page mode only: viewport(s) to report. "all" scans desktop, tablet, and mobile.'),
  maxFixes: z
    .number()
    .int()
    .min(0)
    .max(50)
    .optional()
    .default(10)
    .describe('Maximum number of violations to generate fixes for (default 10). Set 0 for a scan-only pass (no RAG calls).'),
  minSeverity: z
    .enum(['critical', 'serious', 'moderate', 'minor'])
    .optional()
    .default('moderate')
    .describe('Minimum severity to include (default "moderate")'),
  verifyFixes: z
    .boolean()
    .optional()
    .default(true)
    .describe('Re-run real axe on each generated fix (original vs fixed HTML) to measure whether it works (default true)'),
};

/** One node-level violation, optionally tagged with its SPA route. */
interface NodeEntry {
  violation: Violation;
  nodeIndex: number;
  route?: string;
  routeUrl?: string;
}

/** A generated fix plus provenance/verification metadata. */
interface FixEntry {
  ruleId: string;
  description: string;
  impact: string;
  html: string;
  target?: string | string[];
  route?: string;
  fixHtml: string;
  explanation: string;
  wcagCriteria: Array<{ sc: string; title: string; level: string }>;
  techniques: Array<{ id: string; description: string; codeSnippet?: string }>;
  source: string;
  rateLimitInfo?: RateLimitInfo;
  tierInfo?: TierInfo;
  verification?: VerificationResult;
  grounded?: boolean;
  rejectedTechniques?: RejectedTechnique[];
  element?: GroundedElement;
  // ---- Grounded Artifact fields (deterministic surface: badge + templated
  // rationale; never raw chunk text or LLM narrative) ----
  path?: GroundingPath;
  confidence?: Confidence;
  fixTier?: FixTier;
  rationale?: Rationale;
}

/** Flatten prioritized violations into per-node entries (severity-sorted). */
function toNodeEntries(violations: Violation[], minLevel: number): NodeEntry[] {
  const filtered = violations
    .filter((v) => (SEVERITY_ORDER[v.impact ?? 'minor'] ?? 1) >= minLevel)
    .sort(
      (a, b) =>
        (SEVERITY_ORDER[b.impact ?? 'minor'] ?? 1) - (SEVERITY_ORDER[a.impact ?? 'minor'] ?? 1),
    );
  const entries: NodeEntry[] = [];
  for (const v of filtered) {
    for (let i = 0; i < (v.nodes?.length ?? 0); i++) {
      entries.push({ violation: v, nodeIndex: i });
    }
  }
  return entries;
}

/** Generate (and optionally verify) fixes for the top N node entries. */
async function generateFixes(
  nodeEntries: NodeEntry[],
  maxFixes: number,
  verifyFixes: boolean,
  scanId: string,
  fallbackUrl?: string,
): Promise<FixEntry[]> {
  const fixEntries: FixEntry[] = [];
  // Round-robin across rules within each severity tier so ten near-identical
  // ARIA nodes cannot crowd out a strong single-node fix like image-alt.
  const toFix = interleaveByRule(nodeEntries).slice(0, maxFixes);

  for (const { violation, nodeIndex, route, routeUrl } of toFix) {
    const node = violation.nodes![nodeIndex];
    try {
      const fix = await getFix({
        ruleId: violation.id,
        html: node.html,
        parentHtml: node.parentHtml,
        childrenHtml: node.childrenHtml,
        siblingHtml: node.siblingHtml,
        failureSummary: node.failureSummary,
        checks: node.checks,
        url: routeUrl ?? fallbackUrl,
        // Hero tool renders a deterministic surface (badge + templated
        // rationale, no LLM narrative) — skip Path A (docs §8).
        mode: 'deterministic',
        scanId,
      });

      // Deterministically verify the fix on the real browser engine (diff
      // original vs fixed HTML). Never invent a quality verdict.
      let verification: VerificationResult | undefined;
      if (verifyFixes) {
        try {
          verification = await verifySnippet({
            ruleId: violation.id,
            originalHtml: node.html,
            fixedHtml: fix.fixHtml,
          });
        } catch (err) {
          // Best-effort; the fix itself is still returned. Log so a missing
          // verification block isn't a silent mystery in a bug report.
          logError('scan_and_fix verification failed', err, { scanId, ruleId: violation.id });
        }
      }

      fixEntries.push({
        ruleId: violation.id,
        description: violation.description,
        impact: violation.impact ?? 'unknown',
        html: node.html,
        target: node.target,
        ...(route ? { route } : {}),
        fixHtml: fix.fixHtml,
        explanation: fix.explanation,
        wcagCriteria: fix.wcagCriteria,
        techniques: fix.techniques,
        source: fix.source,
        rateLimitInfo: fix.rateLimitInfo,
        tierInfo: fix.tierInfo,
        ...(verification ? { verification } : {}),
        ...(fix.grounded !== undefined ? { grounded: fix.grounded } : {}),
        ...(fix.rejectedTechniques ? { rejectedTechniques: fix.rejectedTechniques } : {}),
        ...(fix.element ? { element: fix.element } : {}),
        ...(fix.path ? { path: fix.path } : {}),
        ...(fix.confidence ? { confidence: fix.confidence } : {}),
        ...(fix.fixTier ? { fixTier: fix.fixTier } : {}),
        ...(fix.rationale ? { rationale: fix.rationale } : {}),
      });
    } catch (err) {
      // Fix generation failed entirely (not just a RAG→template fallback). Log
      // the underlying cause; the user only sees source:'error' otherwise.
      logError('scan_and_fix fix generation failed', err, { scanId, ruleId: violation.id });
      fixEntries.push({
        ruleId: violation.id,
        description: violation.description,
        impact: violation.impact ?? 'unknown',
        html: node.html,
        target: node.target,
        ...(route ? { route } : {}),
        fixHtml: node.html,
        explanation: 'Fix generation failed. Review manually.',
        wcagCriteria: [],
        techniques: [],
        source: 'error',
      });
    }
  }
  return fixEntries;
}

/**
 * Aggregate RAG status + a one-line notice so the user knows WHY fixes degraded
 * (auth/rate-limit/expiry) instead of silently seeing source:"template".
 */
function ragSummary(fixEntries: FixEntry[]): {
  ragStatus: 'rag' | 'template' | 'degraded';
  notice?: string;
} {
  const degradation = fixEntries.find((e) => e.rateLimitInfo)?.rateLimitInfo;
  const hasRag = fixEntries.some((e) => e.source === 'rag');
  const ragStatus: 'rag' | 'template' | 'degraded' = degradation
    ? 'degraded'
    : hasRag
      ? 'rag'
      : 'template';
  return { ragStatus, ...(degradation?.message ? { notice: degradation.message } : {}) };
}

const DISCLAIMER =
  'fixHtml values are suggested remediations, not applied changes. This tool did not modify any file. Apply each suggestion to your own source and re-verify before considering a violation fixed.';

export function registerScanAndFix(server: McpServer): void {
  server.tool(
    'aether_scan_and_fix',
    'Scan a URL (or a multi-route SPA via the `spa` block) for WCAG 2.1 AA accessibility violations AND generate RAG-powered fixes in one call. Returns violations paired with fixHtml, explanations, and WCAG technique references. Set maxFixes:0 for a fast scan-only pass. This is the recommended tool for accessibility auditing — use it when a developer asks to check or fix accessibility.',
    ScanAndFixInput,
    async ({ url, spa, viewport, maxFixes, minSeverity, verifyFixes }) => {
      const scanId = `scan_${randomUUID()}`;
      logToolEntry('aether_scan_and_fix', scanId, { url, entryUrl: spa?.entryUrl });
      try {
        // Exactly one target must be provided.
        if (!url && !spa) {
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({ error: 'Provide either `url` (single page) or `spa` (SPA scan).' }),
              },
            ],
            isError: true,
          };
        }
        if (url && spa) {
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({ error: '`url` and `spa` are mutually exclusive — provide only one.' }),
              },
            ],
            isError: true,
          };
        }

        const minLevel = SEVERITY_ORDER[minSeverity] ?? 2;

        return spa
          ? await runSpa(spa, minLevel, maxFixes, verifyFixes, scanId)
          : await runSinglePage(url!, viewport, minLevel, maxFixes, verifyFixes, scanId);
      } catch (err) {
        return toolError(err, { url, spa });
      }
    },
  );
}

/** Single-page scan across viewports (absorbs the former aether_scan_url). */
async function runSinglePage(
  url: string,
  viewport: 'all' | 'desktop' | 'tablet' | 'mobile',
  minLevel: number,
  maxFixes: number,
  verifyFixes: boolean,
  scanId: string,
) {
  const result = await withScanner((scanner) => scanner.scanUrl(url));

  if (!result || !result.success) {
    return {
      content: [
        { type: 'text' as const, text: JSON.stringify({ error: result?.error ?? 'Scan failed', url }) },
      ],
      isError: true,
    };
  }

  const stats = calculateViolationStats(result.violations);

  let viewportResults = result.viewportResults ?? [];
  if (viewport !== 'all') {
    viewportResults = viewportResults.filter((vr) => vr.viewport === viewport);
  }

  const nodeEntries = toNodeEntries(result.violations, minLevel);
  const fixEntries = await generateFixes(nodeEntries, maxFixes, verifyFixes, scanId, url);
  const { ragStatus, notice } = ragSummary(fixEntries);

  const verifiedCount = fixEntries.filter((e) => e.verification?.targetCleared).length;
  const unverifiedFixCount = fixEntries.filter((e) => !e.verification?.targetCleared).length;

  const output = {
    mode: 'single-page' as const,
    url: result.url,
    scanDate: result.scanDate,
    statistics: stats,
    totalViolations: result.violations.length,
    viewportBreakdown: viewportResults.map((vr) => ({
      viewport: vr.viewport,
      width: vr.width,
      height: vr.height,
      statistics: vr.statistics,
    })),
    fixesGenerated: fixEntries.length,
    fixesAreSuggestions: true,
    disclaimer: DISCLAIMER,
    ragStatus,
    ...(notice ? { notice } : {}),
    ...(maxFixes > 0 ? { verifiedCount, unverifiedFixCount } : {}),
    violationsWithFixes: fixEntries,
    remainingViolations: nodeEntries
      .slice(fixEntries.length)
      .map((e) => ({
        ruleId: e.violation.id,
        description: e.violation.description,
        impact: e.violation.impact,
      })),
  };

  return { content: [{ type: 'text' as const, text: JSON.stringify(output, null, 2) }] };
}

/** Multi-route SPA scan (absorbs the former aether_scan_spa). */
async function runSpa(
  spa: {
    entryUrl: string;
    framework: 'angular' | 'react' | 'vue' | 'generic';
    routes: Array<{ path: string; name: string }>;
    maxRoutes: number;
  },
  minLevel: number,
  maxFixes: number,
  verifyFixes: boolean,
  scanId: string,
) {
  let scanner: SPAScanner | null = null;
  try {
    const spaRoutes: SPARouteConfig[] = spa.routes.map((r) => ({ path: r.path, name: r.name }));
    const useAutoDiscovery = spaRoutes.length === 0;
    const config: SPAScanConfig = {
      entryUrl: spa.entryUrl,
      framework: spa.framework as SPAFramework,
      discovery: {
        mode: useAutoDiscovery ? 'auto' : 'both',
        maxRoutes: spa.maxRoutes,
      },
      routes: spaRoutes,
    };

    scanner = new SPAScanner(config);
    await scanner.initialize();
    const report = await scanner.scan();

    // Flatten route violations into node entries, tagged with their route, then
    // prioritize globally by severity so the fix budget goes to the worst issues
    // regardless of which route they live on.
    const nodeEntries: NodeEntry[] = [];
    for (const r of report.routeResults) {
      for (const entry of toNodeEntries(r.violations, minLevel)) {
        nodeEntries.push({ ...entry, route: r.routeName || r.route, routeUrl: r.url });
      }
    }
    nodeEntries.sort(
      (a, b) =>
        (SEVERITY_ORDER[b.violation.impact ?? 'minor'] ?? 1) -
        (SEVERITY_ORDER[a.violation.impact ?? 'minor'] ?? 1),
    );

    const fixEntries = await generateFixes(nodeEntries, maxFixes, verifyFixes, scanId);
    const { ragStatus, notice } = ragSummary(fixEntries);

    const verifiedCount = fixEntries.filter((e) => e.verification?.targetCleared).length;
    const unverifiedFixCount = fixEntries.filter((e) => !e.verification?.targetCleared).length;

    const output = {
      mode: 'spa' as const,
      entryUrl: report.metadata.entryUrl,
      framework: report.metadata.framework,
      scanDate: report.metadata.scanDate,
      routesScanned: report.metadata.routesScanned,
      statistics: report.statistics,
      summary: report.summary,
      stabilityMetrics: report.stabilityMetrics,
      routeResults: report.routeResults.map((r) => ({
        route: r.route,
        url: r.url,
        routeName: r.routeName,
        stabilityStrategy: r.stabilityStrategy,
        stabilityDurationMs: r.stabilityDurationMs,
        discoveryMethod: r.discoveryMethod,
        success: r.success,
        error: r.error,
        violationCount: r.violations.length,
        violations: r.violations.map((v) => ({
          ruleId: v.id,
          description: v.description,
          impact: v.impact,
          nodeCount: v.nodes?.length ?? 0,
        })),
      })),
      fixesGenerated: fixEntries.length,
      fixesAreSuggestions: true,
      disclaimer: DISCLAIMER,
      ragStatus,
      ...(notice ? { notice } : {}),
      ...(maxFixes > 0 ? { verifiedCount, unverifiedFixCount } : {}),
      violationsWithFixes: fixEntries,
      remainingViolations: nodeEntries.slice(fixEntries.length).map((e) => ({
        ruleId: e.violation.id,
        description: e.violation.description,
        impact: e.violation.impact,
        route: e.route,
      })),
    };

    return { content: [{ type: 'text' as const, text: JSON.stringify(output, null, 2) }] };
  } finally {
    if (scanner) {
      await scanner.cleanup().catch(() => void 0);
    }
  }
}

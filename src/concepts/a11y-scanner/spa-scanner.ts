/**
 * SPA Scanner
 * ===========
 *
 * Scans a Single-Page App across a list of manually-configured routes.
 *
 * Key behaviours that differ from ClusterScanner:
 *
 *   1. **Single browser context reused across all routes.** This preserves
 *      auth cookies, localStorage, and any in-memory SPA state. Creating a
 *      fresh context per route (as Pa11y does) silently logs the user out.
 *
 *   2. **Client-side route navigation.** Instead of `page.goto(entryUrl/path)`
 *      for every route (which would force a full reload and lose SPA state),
 *      the scanner sets `location.href` in the browser so the framework's
 *      router picks it up and runs its own transitions.
 *
 *   3. **State-keyed results.** Results are stored under `${url}#${fingerprint}`.
 *      Two routes with the same `path` but different `name` — e.g. "dashboard
 *      empty" vs "dashboard loaded" — are reported as distinct scans. This is
 *      the Pa11y #98 fix at the data-model level.
 *
 *   4. **URL fragments preserved verbatim.** Lighthouse silently normalizes
 *      `https://app/#/dashboard` → `https://app/`, breaking hash routing. We
 *      never normalize.
 *
 *   5. **Stability cascade, not `networkidle`.** See spa-stability.ts.
 *
 *   6. **Viewport resize instead of new contexts.** Scanning at multiple
 *      viewports resizes the existing page rather than creating a new context
 *      per viewport, again to preserve SPA state.
 */

import { chromium } from 'playwright';
import { ensureChromiumInstalled } from './browser-bootstrap.ts';
import type { Browser, BrowserContext, Page } from 'playwright';
import { createHash } from 'crypto';
import { runAxeOnPage as runAxe } from './axe.ts';
import { runUIAutomationSequenceWithScans } from '../ui-automation/step-runner.ts';
import { calculateViolationStats } from './stats.ts';
import {
  waitForSPAStable,
  resolveStabilityTimings,
  type ResolvedStabilityTimings,
} from './spa-stability.ts';
import { detectFramework } from './spa-detect.ts';
import { discoverRoutes } from './spa-route-discovery.ts';
import { captureViolationScreenshots } from './screenshot.ts';
import { captureNodeLayouts } from './node-layout.ts';
import { captureNodeContext } from './node-context.ts';
import type { ScanOptions } from './cluster-scanner.ts';
import { getChromiumLaunchArgs } from './browser-args.ts';
import { assertScannableUrl, assertSameOriginScannable } from './url-guard.ts';
import type {
  SPAScanConfig,
  SPARouteConfig,
  SPARouteResult,
  SPAScanReport,
  SPAStabilityMetrics,
  SPAStabilityStrategy,
} from '../../types/spa-config';
import type { Violation, ViewportResult } from '../../types/a11y';
import type { UIAutomationSequenceResult } from '../../types/ui-automation';

const VIEWPORTS = [
  { label: 'desktop', width: 1920, height: 1080 },
  { label: 'tablet', width: 1024, height: 768 },
  { label: 'mobile', width: 375, height: 812 },
] as const;

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// ----------------------------------------------------------------------------
// Scanner
// ----------------------------------------------------------------------------

export class SPAScanner {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private readonly config: SPAScanConfig;
  private readonly tags?: string[];

  /** State-keyed result store — fixes Pa11y #98 at the data-model level */
  private readonly results = new Map<string, SPARouteResult>();

  constructor(config: SPAScanConfig, tags?: string[]) {
    this.config = config;
    this.tags = tags;
  }

  // --------------------------------------------------------------------------
  // Lifecycle
  // --------------------------------------------------------------------------

  async initialize(): Promise<void> {
    await ensureChromiumInstalled();
    this.browser = await chromium.launch({
      headless: true,
      // Sandbox stays on unless root / AETHER_NO_SANDBOX=1 (browser-args.ts).
      args: getChromiumLaunchArgs(),
    });

    // Single context reused across all routes — preserves auth + SPA state.
    // Start at desktop viewport; we'll resize between viewport scans.
    this.context = await this.browser.newContext({
      userAgent: USER_AGENT,
      viewport: { width: VIEWPORTS[0].width, height: VIEWPORTS[0].height },
    });
    this.page = await this.context.newPage();
  }

  async cleanup(): Promise<void> {
    if (this.page) {
      await this.page.close().catch(() => void 0);
      this.page = null;
    }
    if (this.context) {
      await this.context.close().catch(() => void 0);
      this.context = null;
    }
    if (this.browser) {
      await this.browser.close().catch(() => void 0);
      this.browser = null;
    }
  }

  // --------------------------------------------------------------------------
  // Top-level scan entry point
  // --------------------------------------------------------------------------

  async scan(opts?: ScanOptions): Promise<SPAScanReport> {
    if (!this.page) {
      throw new Error('SPAScanner not initialized. Call initialize() first.');
    }
    const page = this.page;
    const startTime = Date.now();

    // 1. Navigate to entry URL (full load, preserves fragment)
    // Defense in depth: the MCP schema already refines entryUrl; CLI configs
    // (spa-config-loader) come straight from a JSON file, so re-check here.
    assertScannableUrl(this.config.entryUrl);
    process.stderr.write(`[spa] Navigating to entry URL ${this.config.entryUrl}\n`);
    await page.goto(this.config.entryUrl, {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });

    // 2. Auto-detect framework if not specified
    if (this.config.framework === 'generic') {
      const detected = await detectFramework(page);
      if (detected !== 'generic') {
        process.stderr.write(`[spa] Auto-detected framework: ${detected}\n`);
        (this.config as { framework: string }).framework = detected;
      }
    }

    // 3. Run auth flow once (in the same context so cookies persist)
    if (this.config.auth?.steps && this.config.auth.steps.length > 0) {
      process.stderr.write(`[spa] Running ${this.config.auth.steps.length} auth step(s)\n`);
      try {
        // We run auth as UI automation but discard the axe results — the
        // auth pages aren't what we're scanning.
        await runUIAutomationSequenceWithScans(page, this.config.auth.steps, []);
      } catch (err) {
        process.stderr.write(`[spa] Auth flow failed: ${(err as Error).message}\n`);
        throw new Error(`SPA auth failed: ${(err as Error).message}`);
      }
    }

    // 4. Auto-discover routes if configured
    let routes: SPARouteConfig[] = [...this.config.routes];
    const discoveryMode = this.config.discovery?.mode;
    if (discoveryMode === 'auto' || discoveryMode === 'both') {
      process.stderr.write(`[spa] Auto-discovering routes (mode: ${discoveryMode})\n`);
      const discovered = await discoverRoutes(page, this.config.entryUrl, {
        maxRoutes: this.config.discovery?.maxRoutes,
        excludePatterns: this.config.discovery?.excludePatterns?.map(p => new RegExp(p)),
        framework: this.config.framework,
      });
      process.stderr.write(`[spa] Discovered ${discovered.length} route(s)\n`);

      // Merge: manual routes first, then discovered routes (skip duplicates)
      const existingPaths = new Set(routes.map(r => r.path));
      for (const d of discovered) {
        if (!existingPaths.has(d.path)) {
          routes.push({
            path: d.path,
            name: d.linkText ?? d.path,
          });
          existingPaths.add(d.path);
        }
      }
    }

    // Build a set of manually-configured paths to distinguish discovery method
    const manualPaths = new Set(this.config.routes.map(r => r.path));

    // 5. Scan each route
    for (const route of routes) {
      try {
        const method = manualPaths.has(route.path) ? 'manual' as const : 'crawled' as const;
        const result = await this.scanRoute(route, method, opts);
        this.results.set(result.stateKey, result);
      } catch (err) {
        process.stderr.write(
          `[spa] Route "${route.name}" (${route.path}) failed: ${(err as Error).message}\n`,
        );
        // Record failure result so report still reflects the attempt
        const failedKey = `${this.resolveRouteUrl(route.path)}#error-${route.name}`;
        this.results.set(failedKey, {
          route: route.path,
          url: this.resolveRouteUrl(route.path),
          stateKey: failedKey,
          stateFingerprint: 'error',
          routeName: route.name,
          stabilityStrategy: 'hard-timeout',
          stabilityDurationMs: 0,
          discoveryMethod: 'manual',
          violations: [],
          scanDate: new Date().toISOString(),
          success: false,
          error: (err as Error).message,
        });
      }
    }

    return this.buildReport(startTime);
  }

  // --------------------------------------------------------------------------
  // Per-route scan
  // --------------------------------------------------------------------------

  private async scanRoute(
    route: SPARouteConfig,
    discoveryMethod: 'manual' | 'crawled' = 'manual',
    scanOpts?: ScanOptions,
  ): Promise<SPARouteResult> {
    if (!this.page) {
      throw new Error('Page not initialized');
    }
    const page = this.page;
    const targetUrl = this.resolveRouteUrl(route.path);
    // Routes (manual or discovered) must stay on the entry origin and must be
    // scannable. A `//evil.example/x` or absolute cross-origin route is refused
    // here and recorded as a failed route by the caller.
    assertSameOriginScannable(targetUrl, this.config.entryUrl);
    process.stderr.write(`[spa] → Scanning ${route.name} (${targetUrl})\n`);

    // Client-side navigation — set location.href so the framework router
    // picks it up, rather than page.goto() which would full-reload and
    // destroy SPA state.
    await this.navigateClientSide(page, targetUrl);

    // Resolve stability timings for this route (global config + per-route overrides)
    const timings: ResolvedStabilityTimings = resolveStabilityTimings(
      this.config.framework,
      this.config.stability,
      route.stabilityOverrides,
    );

    // Run the stability cascade
    const stability = await waitForSPAStable(page, {
      framework: this.config.framework,
      timings,
      waitForSelector: route.waitForSelector,
      currentUrl: targetUrl,
    });

    process.stderr.write(
      `[spa]   stability: ${stability.strategy} (${stability.durationMs}ms)\n`,
    );

    // Per-viewport scan (resize instead of new context)
    const perViewport: Violation[][] = [];
    const viewportResults: ViewportResult[] = [];
    let uiAutomationResults: UIAutomationSequenceResult | undefined;
    // Shared across this route's viewports so a violation is screenshotted once,
    // at the first viewport it appears in (aligned with mergeViolations() dedup).
    const captured = new Set<string>();

    for (const vp of VIEWPORTS) {
      try {
        await page.setViewportSize({ width: vp.width, height: vp.height });
        // Give the SPA a beat to respond to the resize (responsive breakpoints,
        // lazy components). Use the mutation observer quiet period rather
        // than a fixed sleep.
        await waitForSPAStable(page, {
          framework: this.config.framework,
          timings: { ...timings, maxTimeoutMs: Math.min(timings.maxTimeoutMs, 5000) },
          currentUrl: targetUrl,
        });

        // Run interactions on first (desktop) viewport only — subsequent
        // viewports scan the same resulting DOM state.
        if (vp.label === 'desktop' && route.interactions && route.interactions.length > 0) {
          const initialAxe = await runAxe(page, this.tags);
          uiAutomationResults = await runUIAutomationSequenceWithScans(
            page,
            route.interactions,
            initialAxe.violations,
          );
        }

        const axeResult = await runAxe(page, this.tags);
        // If interactions ran, prefer the aggregated set from the sequence
        // (captures violations introduced by each step).
        const violations =
          uiAutomationResults?.allViolationsFound ?? axeResult.violations;

        // Live-DOM geometry + hidden-state (SME Issue 5, Tier 1) — desktop-only,
        // always on. Small metadata that flows to BOTH the CLI report and the MCP
        // plugin; drives tracking-pixel suppression in finding.ts. Desktop is
        // first and mergeViolations() keeps the first-seen node.
        if (vp.label === 'desktop') {
          await captureNodeLayouts(page, violations);
          // Tier 2 (SME Issue 4 table headers + Issue 3 combobox wiring).
          await captureNodeContext(page, violations);
        }

        // Element screenshots (SME Issue 1) — captured at every viewport,
        // deduped via the shared `captured` set so each violation is shot once,
        // at the first viewport it appears in (route-prefixed filename to avoid
        // cross-route collisions). Best-effort, never throws.
        if (scanOpts?.screenshots) {
          await captureViolationScreenshots(
            page,
            violations,
            { ...scanOpts.screenshots, url: targetUrl, namePrefix: route.name },
            vp.label as 'desktop' | 'tablet' | 'mobile',
            captured,
          );
        }

        perViewport.push(violations);
        const stats = calculateViolationStats(violations);
        viewportResults.push({
          viewport: vp.label,
          width: vp.width,
          height: vp.height,
          violations,
          statistics: stats,
        });
        process.stderr.write(
          `[spa]   [${vp.label}] ${stats.total} violation(s)\n`,
        );
      } catch (err) {
        process.stderr.write(
          `[spa]   [${vp.label}] scan failed: ${(err as Error).message}\n`,
        );
      }
    }

    const mergedViolations = this.mergeViolations(perViewport);

    // Compute state fingerprint — runs after all viewports so we capture
    // the final DOM state after interactions.
    const stateFingerprint = await this.computeStateFingerprint(page, route.name);
    const stateKey = `${targetUrl}#${stateFingerprint}`;

    return {
      route: route.path,
      url: targetUrl,
      stateKey,
      stateFingerprint,
      routeName: route.name,
      stabilityStrategy: stability.strategy,
      stabilityDurationMs: stability.durationMs,
      discoveryMethod,
      violations: mergedViolations,
      viewportResults,
      scanDate: new Date().toISOString(),
      success: true,
      ...(uiAutomationResults && { uiAutomationResults }),
    };
  }

  // --------------------------------------------------------------------------
  // Client-side navigation
  // --------------------------------------------------------------------------
  //
  // Set `location.href` inside the browser so the framework router handles
  // the transition. This preserves SPA state (auth, loaded data, in-memory
  // stores) — critical for scanning authenticated routes without re-logging-in.

  private async navigateClientSide(page: Page, targetUrl: string): Promise<void> {
    // Second layer (scanRoute already checked): never drive the browser to a
    // URL outside the entry origin, even via the page.goto() fallback below.
    assertSameOriginScannable(targetUrl, this.config.entryUrl);
    const currentUrl = page.url();
    if (currentUrl === targetUrl) {
      // Already there — nothing to do. The caller will still run the
      // stability cascade, which handles the "already rendered" case.
      return;
    }

    try {
      await page.evaluate((url) => {
        // Prefer History API for pushState apps; fall back to location.href
        // for hash-routed apps or full-URL changes.
        if (url.includes('#')) {
          window.location.href = url;
        } else {
          try {
            const path = new URL(url, window.location.href).pathname + new URL(url, window.location.href).search;
            window.history.pushState({}, '', path);
            // Trigger popstate so frameworks listening to it re-render
            window.dispatchEvent(new PopStateEvent('popstate'));
          } catch {
            window.location.href = url;
          }
        }
      }, targetUrl);
    } catch {
      // Fall back to full navigation if evaluate fails
      await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    }
  }

  /**
   * Compute the absolute URL for a route path, preserving URL fragments
   * verbatim. Never strips `#/` — that's the Lighthouse bug.
   */
  private resolveRouteUrl(path: string): string {
    // Absolute URL passed in — use as-is, preserving fragments
    if (/^https?:\/\//.test(path)) {
      return path;
    }
    // Relative path — join against entryUrl. URL constructor preserves
    // fragments correctly.
    try {
      return new URL(path, this.config.entryUrl).toString();
    } catch {
      // Fallback for exotic paths
      const base = this.config.entryUrl.replace(/\/$/, '');
      const suffix = path.startsWith('/') || path.startsWith('#') ? path : `/${path}`;
      return `${base}${suffix}`;
    }
  }

  // --------------------------------------------------------------------------
  // State fingerprint
  // --------------------------------------------------------------------------
  //
  // SHA-1 of three signals that distinguish logical page states without
  // being brittle to minor text changes:
  //   - body.innerHTML.length      (rough content volume)
  //   - number of visible headings (structural signal)
  //   - route name                 (human intent)
  //
  // Intentionally NOT a hash of body.innerHTML itself — that would over-
  // fingerprint (every dynamic timestamp creates a new state). See the
  // open questions section of docs/plan-spa-angular-scanning.md.

  private async computeStateFingerprint(page: Page, routeName: string): Promise<string> {
    let signals: { bodyLen: number; headingCount: number };
    try {
      signals = (await page.evaluate(() => {
        const body = document.body;
        const bodyLen = body ? body.innerHTML.length : 0;
        const headings = Array.from(
          document.querySelectorAll('h1, h2, h3, h4, h5, h6'),
        ).filter((h) => {
          const rect = (h as HTMLElement).getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        });
        return { bodyLen, headingCount: headings.length };
      })) as { bodyLen: number; headingCount: number };
    } catch {
      signals = { bodyLen: 0, headingCount: 0 };
    }

    const material = `${signals.bodyLen}|${signals.headingCount}|${routeName}`;
    return createHash('sha1').update(material).digest('hex').slice(0, 16);
  }

  // --------------------------------------------------------------------------
  // Viewport violation merge (same dedup logic as ClusterScanner)
  // --------------------------------------------------------------------------

  private nodeKey(ruleId: string, node: { target?: string | string[]; html: string }): string {
    const target = Array.isArray(node.target) ? node.target.join(',') : String(node.target ?? '');
    return `${ruleId}::${target}::${node.html}`;
  }

  private mergeViolations(perViewport: Violation[][]): Violation[] {
    const seenNodes = new Set<string>();
    const ruleMap = new Map<string, Violation>();

    for (const violations of perViewport) {
      for (const v of violations) {
        if (!ruleMap.has(v.id)) {
          ruleMap.set(v.id, { ...v, nodes: [] });
        }
        const merged = ruleMap.get(v.id)!;
        for (const node of v.nodes ?? []) {
          const key = this.nodeKey(v.id, node);
          if (!seenNodes.has(key)) {
            seenNodes.add(key);
            merged.nodes!.push(node);
          }
        }
      }
    }

    return Array.from(ruleMap.values()).filter((v) => (v.nodes?.length ?? 0) > 0);
  }

  // --------------------------------------------------------------------------
  // Report builder
  // --------------------------------------------------------------------------

  private buildReport(startTime: number): SPAScanReport {
    const routeResults = Array.from(this.results.values());
    const allViolations: Violation[] = routeResults.flatMap((r) => r.violations);
    const stats = calculateViolationStats(allViolations);
    const routesWithIssues = routeResults.filter(
      (r) => r.success && r.violations.length > 0,
    ).length;

    const metrics = this.buildStabilityMetrics(routeResults);

    const summary =
      stats.total === 0
        ? `Scanned ${routeResults.length} route(s). No accessibility violations found.`
        : `Scanned ${routeResults.length} route(s). Found ${stats.total} violation(s) ` +
          `across ${routesWithIssues} route(s).`;

    return {
      metadata: {
        entryUrl: this.config.entryUrl,
        framework: this.config.framework,
        scanDate: new Date().toISOString(),
        routesScanned: routeResults.length,
        standard: 'WCAG 2.1 AA',
      },
      statistics: {
        ...stats,
        routesWithIssues,
      },
      summary,
      routeResults,
      stabilityMetrics: metrics,
    };
  }

  private buildStabilityMetrics(routeResults: SPARouteResult[]): SPAStabilityMetrics {
    const winsByStrategy: Record<SPAStabilityStrategy, number> = {
      'domcontentloaded': 0,
      'angular-testability': 0,
      'angular-testability-timeout': 0,
      'hashchange': 0,
      'mutation-observer': 0,
      'wait-for-selector': 0,
      'hard-timeout': 0,
    };
    let totalDuration = 0;
    for (const r of routeResults) {
      winsByStrategy[r.stabilityStrategy] =
        (winsByStrategy[r.stabilityStrategy] ?? 0) + 1;
      totalDuration += r.stabilityDurationMs;
    }
    return {
      winsByStrategy,
      totalRoutes: routeResults.length,
      averageDurationMs:
        routeResults.length > 0 ? Math.round(totalDuration / routeResults.length) : 0,
    };
  }
}

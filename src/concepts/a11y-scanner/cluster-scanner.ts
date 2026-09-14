import { chromium } from 'playwright';
import type { Browser, BrowserContext } from 'playwright';
import { runAxeOnPage as runAxe } from './axe.ts';
import { loadUIAutomationSteps } from '../ui-automation/step-loader.ts';
import { runUIAutomationSequenceWithScans } from '../ui-automation/step-runner.ts';
import type { PageScanResult, Violation, ViolationNode, ViewportResult } from '../../types/a11y';
import type { UIAutomationSequenceResult } from '../../types/ui-automation';
import { calculateViolationStats } from './stats.ts';
import { captureViolationScreenshots, type ScreenshotScanOptions } from './screenshot.ts';
import { captureNodeLayouts } from './node-layout.ts';
import { captureNodeContext } from './node-context.ts';
import { getChromiumLaunchArgs } from './browser-args.ts';
import { assertScannableUrl } from './url-guard.ts';

/**
 * Per-scan options. Kept as a parameter (never instance state) because the MCP
 * server shares a single scanner singleton — MCP calls omit `screenshots` so no
 * capture happens and no base64 leaks into JSON-RPC responses.
 */
export interface ScanOptions {
  screenshots?: ScreenshotScanOptions;
}

/** Constructor options for ClusterScanner. */
export interface ClusterScannerOptions {
  /**
   * Whether to look up and run `ui-steps/<host>.json` UI-automation sequences
   * for each scanned URL. Loading is additionally gated on `UI_STEPS_DIR`
   * being set (see step-loader.ts). Default true for CLI use; the MCP server
   * passes `false` so a repository's env/step files can never drive the
   * browser during a plugin scan.
   */
  uiAutomation?: boolean;
}

const VIEWPORTS = [
  { label: 'desktop', width: 1920, height: 1080 },
  { label: 'tablet',  width: 1024, height: 768  },
  { label: 'mobile',  width: 375,  height: 812  },
] as const;

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/**
 * CSP applied to snippet verification documents: nothing may load or execute
 * except inline styles (needed so `style="display:none"` etc. still affect
 * what axe considers visible). Blocks inline `<script>`, external scripts,
 * images, frames, fonts, media and fetch/XHR/beacon.
 */
const SNIPPET_CSP_META =
  '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'">';

/**
 * Wrap an untrusted HTML snippet so the CSP meta is the first thing in <head>.
 * Fragments get the same `<html><head></head><body>` shell `page.setContent`
 * would have synthesised (so wrapper-noise rules fire identically); full
 * documents get the meta injected into their existing <head> (or a new one).
 */
export function wrapSnippetWithCsp(html: string): string {
  const headOpen = /<head\b[^>]*>/i.exec(html);
  if (headOpen) {
    const at = headOpen.index + headOpen[0].length;
    return html.slice(0, at) + SNIPPET_CSP_META + html.slice(at);
  }
  const htmlOpen = /<html\b[^>]*>/i.exec(html);
  if (htmlOpen) {
    const at = htmlOpen.index + htmlOpen[0].length;
    return html.slice(0, at) + `<head>${SNIPPET_CSP_META}</head>` + html.slice(at);
  }
  return `<!DOCTYPE html><html><head>${SNIPPET_CSP_META}</head><body>${html}</body></html>`;
}

/**
 * Cluster-based Scanner using Playwright
 * Uses Playwright for efficient browser management and scaling
 * Supports concurrent tasks with proper resource management
 * Scans at multiple viewports to catch responsive-breakpoint violations
 */
export class ClusterScanner {
  private browser: Browser | null = null;
  private maxConcurrency: number;
  private tags?: string[];
  private uiAutomation: boolean;

  constructor(maxConcurrency: number = 20, tags?: string[], options: ClusterScannerOptions = {}) {
    this.maxConcurrency = maxConcurrency;
    this.tags = tags;
    this.uiAutomation = options.uiAutomation ?? true;
  }

  /**
   * Initialize the browser
   */
  async initialize(): Promise<void> {
    this.browser = await chromium.launch({
      headless: true,
      // Sandbox stays on unless root / AETHER_NO_SANDBOX=1 (browser-args.ts).
      args: getChromiumLaunchArgs(),
    });
  }

  /**
   * Create a browser context for a specific viewport
   */
  private async createContext(viewport: { width: number; height: number }): Promise<BrowserContext> {
    if (!this.browser) {
      throw new Error('Browser not initialized. Call initialize() first.');
    }

    return this.browser.newContext({
      userAgent: USER_AGENT,
      viewport,
    });
  }

  /**
   * Build a dedup key for a violation node: ruleId::target::html
   */
  private nodeKey(ruleId: string, node: ViolationNode): string {
    const target = Array.isArray(node.target) ? node.target.join(',') : String(node.target ?? '');
    return `${ruleId}::${target}::${node.html}`;
  }

  /**
   * Merge violations from multiple viewport scans, deduplicating at the node level.
   * Two nodes are considered identical when ruleId + target selector + html match.
   */
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

    // Drop rules that ended up with zero nodes after dedup (shouldn't happen, but safe)
    return Array.from(ruleMap.values()).filter(v => (v.nodes?.length ?? 0) > 0);
  }

  /**
   * Navigate to a URL with retry logic for flaky page loads.
   * First attempt: waitUntil 'domcontentloaded', 30s timeout.
   * Retry: waitUntil 'commit' (first bytes received), 30s timeout.
   */
  private async navigateWithRetry(page: import('playwright').Page, url: string): Promise<void> {
    const attempts = [
      { waitUntil: 'domcontentloaded' as const, timeout: 30000 },
      { waitUntil: 'commit' as const, timeout: 30000 },
    ];

    for (let i = 0; i < attempts.length; i++) {
      try {
        await page.goto(url, attempts[i]);
        return;
      } catch (err) {
        if (i < attempts.length - 1) {
          console.warn(`Navigation to ${url} failed (attempt ${i + 1}), retrying: ${(err as Error).message}`);
        } else {
          throw err;
        }
      }
    }
  }

  /**
   * Wait for the DOM to stabilize using a MutationObserver with debounce.
   * Resolves once no DOM mutations have occurred for `debounceMs`,
   * or when `maxWait` is reached (whichever comes first).
   *
   * Works for SPAs, streaming sites, and static pages alike because it's
   * event-driven (no polling) and ignores continuous network activity.
   */
  private async waitForDomStable(
    page: import('playwright').Page,
    debounceMs: number = 1500,
    maxWait: number = 15000,
  ): Promise<void> {
    try {
      await page.evaluate(`new Promise(resolve => {
        var timer;
        var target = document.body || document.documentElement;
        function done() { observer.disconnect(); resolve(); }
        var observer = new MutationObserver(function() {
          clearTimeout(timer);
          timer = setTimeout(done, ${debounceMs});
        });
        observer.observe(target, {
          childList: true, subtree: true, attributes: true, characterData: true
        });
        timer = setTimeout(done, ${debounceMs});
        setTimeout(done, ${maxWait});
      })`);
    } catch {
      // Context destroyed by navigation — page has moved on, that's OK
    }
  }

  /**
   * Wait for delayed navigations to settle (e.g. Amazon's CAPTCHA redirect).
   * Waits up to `maxWait` ms, resolving once no new navigations occur for `quietMs`.
   */
  private async waitForNavigationsToSettle(
    page: import('playwright').Page,
    quietMs: number = 3000,
    maxWait: number = 15000,
  ): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < maxWait) {
      try {
        await page.waitForNavigation({ timeout: quietMs, waitUntil: 'domcontentloaded' });
        // A navigation happened — loop and wait for more
      } catch {
        // Timeout means no navigation occurred within quietMs — settled
        return;
      }
    }
  }

  /**
   * Detect CAPTCHA / bot-gate pages.
   * Uses visible body text (not full HTML) to avoid false positives from
   * font names ("Roboto"), meta tags (<meta name="robots">), or reCAPTCHA
   * widgets loaded as non-blocking scripts.
   * Also requires a small page (< 50KB) since real pages are much larger.
   */
  private async detectCaptcha(page: import('playwright').Page): Promise<string | null> {
    try {
      const result = await page.evaluate(`(() => {
        var html = document.documentElement.innerHTML;
        if (html.length > 50000) return null;
        var text = (document.body ? document.body.innerText : '').toLowerCase();
        var markers = ['validatecaptcha', 'automated access', 'unusual traffic',
                       'verify you are a human', 'press & hold',
                       'click the button below to continue',
                       'please verify you are a human',
                       'are not a robot', 'bot detection'];
        for (var i = 0; i < markers.length; i++) {
          if (text.indexOf(markers[i]) !== -1) return markers[i];
        }
        return null;
      })()`);
      return result as string | null;
    } catch {
      return null;
    }
  }

  /**
   * Scan a URL at a single viewport. Returns violations or throws on nav failure.
   */
  private async scanAtViewport(
    url: string,
    viewport: { label: string; width: number; height: number },
    scanOpts?: ScanOptions,
    captured?: Set<string>,
  ): Promise<{ violations: Violation[]; axeError?: string; uiAutomationResults?: UIAutomationSequenceResult }> {
    const context = await this.createContext({ width: viewport.width, height: viewport.height });
    try {
      const page = await context.newPage();
      try {
        await this.navigateWithRetry(page, url);

        // Wait for delayed redirects to settle (e.g. Amazon 202 → self-redirect)
        await this.waitForNavigationsToSettle(page);

        // Detect CAPTCHA / bot-gate pages
        const captchaMarker = await this.detectCaptcha(page);
        if (captchaMarker) {
          throw new Error(`Bot detection page (matched: "${captchaMarker}"). Site requires a real browser session.`);
        }

        await this.waitForDomStable(page);

        // Scroll to bottom to trigger lazy-loaded content, then back to top
        await page.evaluate('window.scrollTo(0, document.body.scrollHeight)');
        await this.waitForDomStable(page, 1000, 8000);
        await page.evaluate('window.scrollTo(0, 0)');

        // Run initial Axe scan
        const result = await runAxe(page, this.tags);
        // stderr, not stdout: the MCP server shares this scan path and requires
        // stdout stay JSON-RPC only. CLI progress belongs on stderr regardless.
        console.error(`  [${viewport.label}] ${viewport.width}x${viewport.height} → ${result.violations.reduce((s, v) => s + (v.nodes?.length || 1), 0)} nodes across ${result.violations.length} rules`);

        // Live-DOM geometry + hidden-state (SME Issue 5, Tier 1) — desktop-only,
        // always on. Small metadata (numbers/booleans) that flows to BOTH the CLI
        // report and the MCP plugin; it drives tracking-pixel suppression in
        // finding.ts. Desktop is scanned first and mergeViolations() keeps the
        // first-seen node, so the desktop node carries the layout into the merge.
        if (viewport.label === 'desktop') {
          await captureNodeLayouts(page, result.violations);
          // Tier 2 (SME Issue 4 table headers + Issue 3 combobox wiring) —
          // desktop-only, always on, bounded, never throws.
          await captureNodeContext(page, result.violations);
        }

        // Element screenshots (SME Issue 1) — captured at every viewport but
        // deduped via the shared `captured` set so each violation is shot once,
        // at the first viewport it appears in (mergeViolations() keeps that same
        // first-seen node). This gives responsive/mobile-only violations a real
        // shot from where they render. Best-effort, never throws.
        if (scanOpts?.screenshots && captured) {
          await captureViolationScreenshots(
            page,
            result.violations,
            { ...scanOpts.screenshots, url },
            viewport.label as 'desktop' | 'tablet' | 'mobile',
            captured,
          );
        }

        let uiAutomationResults: UIAutomationSequenceResult | undefined;

        // Run UI automation steps (opt-in: constructor flag + UI_STEPS_DIR env)
        try {
          const steps = this.uiAutomation ? await loadUIAutomationSteps(url) : [];
          if (steps.length > 0) {
            console.error(`  [${viewport.label}] Running ${steps.length} UI automation steps with per-step scanning`);
            uiAutomationResults = await runUIAutomationSequenceWithScans(page, steps, result.violations);

            uiAutomationResults.stepExecutions.forEach((exec, index) => {
              const status = exec.success ? 'OK' : 'FAIL';
              const afterCount = exec.violationsAfterStep
                ? exec.violationsAfterStep.reduce((s, v) => s + (v.nodes?.length || 1), 0)
                : 'N/A';
              console.error(`    [${status}] Step ${index + 1}: ${exec.step.action} - ${exec.step.name} (${exec.stepDurationMs}ms) -> ${afterCount} violations${exec.error ? ' - ' + exec.error : ''}`);
            });
          }
        } catch (err) {
          console.warn(`  [${viewport.label}] UI automation error: ${(err as Error).message}`);
        }

        // Use all violations found during automation if available, otherwise use final violations after last step
        // allViolationsFound includes violations discovered across all automation steps and tabs
        const finalViolations = uiAutomationResults?.allViolationsFound ||
                                 uiAutomationResults?.stepExecutions[uiAutomationResults.stepExecutions.length - 1]?.violationsAfterStep ||
                                 result.violations;

        // Second screenshot pass for violations discovered *during* UI automation
        // (e.g. color-contrast on elements only flagged after a tab renders). The
        // first pass above only saw the pre-automation `result.violations`; anything
        // surfaced by the per-step re-scans in step-runner never went through capture.
        // The shared `captured` set makes this a no-op for already-shot violations,
        // so we only pay for the newly-discovered ones, shot from the final page state.
        if (scanOpts?.screenshots && captured && uiAutomationResults) {
          await captureViolationScreenshots(
            page,
            finalViolations,
            { ...scanOpts.screenshots, url },
            viewport.label as 'desktop' | 'tablet' | 'mobile',
            captured,
          );
        }

        return {
          violations: finalViolations,
          axeError: result.axeError,
          uiAutomationResults,
        };
      } finally {
        await page.close();
      }
    } finally {
      await context.close();
    }
  }

  /**
   * Scan a single URL across all viewports, merging & deduplicating violations
   */
  async scanUrl(url: string, scanOpts?: ScanOptions): Promise<PageScanResult | null> {
    if (!this.browser) {
      throw new Error('Browser not initialized. Call initialize() first.');
    }

    try {
      // Defense in depth: tool schemas already refine the URL, but every caller
      // (CLI, batch scanner, verify-service) funnels through here.
      assertScannableUrl(url);

      const perViewport: Violation[][] = [];
      const viewportResults: ViewportResult[] = [];
      const axeErrors: string[] = [];
      let uiAutomationResults: UIAutomationSequenceResult | undefined;
      // Shared across viewports so a violation is screenshotted once, at the
      // first viewport it appears in (aligned with mergeViolations() dedup).
      const captured = new Set<string>();

      for (const vp of VIEWPORTS) {
        try {
          const { violations, axeError, uiAutomationResults: viewportUiResults } = await this.scanAtViewport(url, vp, scanOpts, captured);
          perViewport.push(violations);
          if (axeError) axeErrors.push(`[${vp.label}] ${axeError}`);
          if (!uiAutomationResults) {
            uiAutomationResults = viewportUiResults;
          }

          // Build per-viewport result with independent statistics
          const stats = calculateViolationStats(violations);
          viewportResults.push({
            viewport: vp.label,
            width: vp.width,
            height: vp.height,
            violations,
            statistics: stats,
          });
        } catch (err) {
          console.warn(`  [${vp.label}] scan failed: ${(err as Error).message}`);
          // Continue with remaining viewports
        }
      }

      if (perViewport.length === 0) {
        return {
          url,
          violations: [],
          scanDate: new Date().toISOString(),
          success: false,
          error: 'All viewport scans failed',
        };
      }

      const merged = this.mergeViolations(perViewport);
      const combinedError = axeErrors.length > 0
        ? `Axe analysis partial failure: ${axeErrors.join('; ')}`
        : undefined;

      return {
        url,
        violations: merged,
        viewportResults,
        scanDate: new Date().toISOString(),
        success: true,
        ...(combinedError && { error: combinedError }),
        ...(uiAutomationResults && { uiAutomationResults }),
      };
    } catch (err) {
      return {
        url,
        violations: [],
        scanDate: new Date().toISOString(),
        success: false,
        error: (err as Error).message,
      };
    }
  }

  /**
   * Run real axe-core against an HTML string (no network fetch).
   *
   * Loads the markup via `page.setContent` into a single desktop context and
   * runs the same `runAxe` engine used for live URLs — so a fix can be verified
   * before it is deployed. `setContent` wraps a fragment in
   * `<html><head></head><body>…</body></html>`, which makes page-level rules
   * (html-has-lang, document-title, region, landmark-*) fire as wrapper noise.
   * Callers must therefore DIFF original vs fixed rather than read raw snippet
   * violations; the diff cancels those artifacts, leaving only what the fix
   * actually changed. Single viewport — verification needs no responsive sweep.
   *
   * Sandboxed: the snippet is untrusted markup (it may come from an LLM or a
   * pasted component). Two layers, both always on:
   *   1. every network request in the context is ABORTED (`context.route`) —
   *      setContent needs no network and axe is injected over CDP;
   *   2. the document is wrapped with a CSP of `default-src 'none'` (inline
   *      styles allowed so `style="display:none"` still hides nodes from axe),
   *      which stops inline/`<script src>` execution, images, frames, fonts
   *      and fetch/XHR beacons before they even reach the route handler.
   * Page JavaScript stays ENABLED because axe-core itself needs timers to run
   * (`javaScriptEnabled:false` makes `AxeBuilder.analyze()` hang) — the CSP is
   * what keeps the snippet's own scripts from executing.
   */
  async scanHtml(html: string): Promise<{ violations: Violation[]; axeError?: string }> {
    if (!this.browser) {
      throw new Error('Browser not initialized. Call initialize() first.');
    }

    const desktop = VIEWPORTS[0];
    const context = await this.createContext({ width: desktop.width, height: desktop.height });
    try {
      // No network at all for snippet verification — setContent needs none.
      await context.route('**/*', (route) => route.abort());
      const page = await context.newPage();
      try {
        await page.setContent(wrapSnippetWithCsp(html), { waitUntil: 'domcontentloaded' });
        await this.waitForDomStable(page, 500, 4000);
        return await runAxe(page, this.tags);
      } finally {
        await page.close();
      }
    } finally {
      await context.close();
    }
  }

  /**
   * Scan multiple URLs with automatic concurrency management
   */
  async scanUrls(urls: string[]): Promise<PageScanResult[]> {
    if (!this.browser) {
      throw new Error('Browser not initialized. Call initialize() first.');
    }

    const results: (PageScanResult | null)[] = [];

    // Process URLs in batches respecting max concurrency
    for (let i = 0; i < urls.length; i += this.maxConcurrency) {
      const batch = urls.slice(i, i + this.maxConcurrency);
      const batchResults = await Promise.all(
        batch.map((url, index) =>
          this.scanUrl(url).then(result => {
            results[i + index] = result;
            return result;
          })
        )
      );
    }

    // Filter out null results (unchanged pages)
    return results.filter((r): r is PageScanResult => r !== null);
  }

  /**
   * Cleanup resources
   */
  async cleanup(): Promise<void> {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
    }
  }

  /**
   * Get scanner statistics
   */
  getStats() {
    return {
      maxConcurrency: this.maxConcurrency,
      viewports: VIEWPORTS.map(v => `${v.label} (${v.width}x${v.height})`),
    };
  }
}

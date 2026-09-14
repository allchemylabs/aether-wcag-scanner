#!/usr/bin/env node
/**
 * Pipeline Runner - CI/CD-friendly accessibility scanner
 *
 * Usage:
 *   npx ts-node pipeline-runner.ts <url> [options]
 *
 * Options:
 *   --fail-on <level>     Fail if violations at this level or above exist (critical|serious|moderate|minor)
 *   --threshold <n>       Max allowed violations before failing (default: 0)
 *   --output <path>       Write JSON report to file (default: stdout)
 *   --format <fmt>        Output format: json | summary (default: summary)
 *   --no-insights         Skip RAG API call (faster CI runs)
 *   --multi               Enable multi-page scanning
 *   --ui-steps-dir <dir>  Load UI automation steps from this directory (opt-in)
 *
 * Environment Variables:
 *   SCAN_URL              URL to scan (alternative to positional arg)
 *   SCAN_THRESHOLD        Max violations threshold
 *   SCAN_FAIL_ON          Minimum severity to fail on
 *   SCAN_OUTPUT           Report output file path
 *   FIRECRAWL_API_KEY     For multi-page scanning
 *   MULTI_PAGE            Enable multi-page scanning
 *   SCAN_CONCURRENCY      Number of concurrent scans
 *   AXE_TAGS              Comma-separated axe rule tags
 *   UI_STEPS_DIR          Directory of UI automation steps (same as --ui-steps-dir)
 *
 * Exit Codes:
 *   0 = pass (all checks passed)
 *   1 = fail (violations exceed threshold)
 *   2 = error (scanner error)
 */

import 'dotenv/config.js';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync } from 'fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClusterScanner, type ScanOptions } from './cluster-scanner.ts';
import { SPAScanner } from './spa-scanner.ts';
import { LocalFileSink } from './screenshot-sink.ts';
import type { ScreenshotScanOptions } from './screenshot.ts';
import { loadSPAConfig, SPAConfigError } from './spa-config-loader.ts';
import { generateReport } from './report.ts';
import { getCrawlMap, extractDomain, filterDomainUrls, deduplicateUrls } from './firecrawl.ts';
import { filterUrls, limitUrls } from './url-filter.ts';
import { aggregateResults, getViolationSummary, getWorstPages, getFailedScans } from './aggregator.ts';
import { calculateViolationStats, countViolationsAtOrAbove } from './stats.ts';
import { HTMLReporter } from '../../testing-agent/html-reporter.ts';
import { AutomationReporter } from '../../testing-agent/automation-reporter.ts';
import { ScanScheduler, type ScheduleConfig } from './scan-scheduler.ts';
import type { Violation, ScanReport, MultiPageScanReport, PageScanResult } from '../../types/a11y';
import type { SPAScanReport, SPARouteResult } from '../../types/spa-config';
import type { BatchReport } from '../../testing-agent/types.ts';

// ============================================================================
// CLI Argument Parsing
// ============================================================================

interface PipelineOptions {
  url: string;
  failOn: 'critical' | 'serious' | 'moderate' | 'minor';
  threshold: number;
  output: string | null;
  outputDir: string | null;
  format: 'json' | 'summary';
  noInsights: boolean;
  multi: boolean;
  spaConfigPath: string | null;
  spaQuickUrl: string | null;
  concurrency: number;
  axeTags?: string[];
  schedule: string | null;
  scheduleOnce: boolean;
  notifyWebhook: string | null;
  // ---- Element screenshots (SME Issue 1) ----
  screenshots: boolean;                              // master on/off (default ON)
  screenshotMode: 'inline' | 'files' | 'both';       // HTML encoding (default inline)
  jsonScreenshots: 'paths' | 'base64' | 'none';      // JSON encoding (default paths)
  screenshotsDir: string;                            // subdir (default screenshots)
  maxScreenshots: number;                            // default 50 (~25 violations x 2)
  screenshotTimeout: number;                         // per-shot ms (default 2000)
  suppressOverlays: boolean;                         // hide consent scrims for shots (default ON)
}

const VALID_FAIL_ON = new Set(['critical', 'serious', 'moderate', 'minor']);

export function parseArgs(argv?: string[]): PipelineOptions {
  const args = argv ?? process.argv.slice(2);

  let url = process.env.SCAN_URL || '';
  const envFailOn = process.env.SCAN_FAIL_ON || '';
  let failOn: PipelineOptions['failOn'] = VALID_FAIL_ON.has(envFailOn)
    ? envFailOn as PipelineOptions['failOn']
    : 'serious';
  let threshold = parseInt(process.env.SCAN_THRESHOLD || '0', 10);
  let output: string | null = process.env.SCAN_OUTPUT || null;
  let outputDir: string | null = null;
  let format: PipelineOptions['format'] = 'summary';
  let noInsights = false;
  let multi = process.env.MULTI_PAGE === 'true';
  let spaConfigPath: string | null = process.env.SPA_CONFIG || null;
  let spaQuickUrl: string | null = null;
  let concurrency = parseInt(process.env.SCAN_CONCURRENCY || '5', 10);
  let axeTags: string[] | undefined;
  let schedule: string | null = process.env.SCAN_SCHEDULE || null;
  let scheduleOnce = false;
  let notifyWebhook: string | null = process.env.SCAN_NOTIFY_WEBHOOK || null;
  // Element screenshots default ON for CLI/pipeline reports.
  let screenshots = true;
  let screenshotMode: PipelineOptions['screenshotMode'] = 'inline';
  let jsonScreenshots: PipelineOptions['jsonScreenshots'] = 'paths';
  let screenshotsDir = 'screenshots';
  let maxScreenshots = 50;
  let screenshotTimeout = 2000;
  // Consent/overlay suppression for element screenshots defaults ON.
  let suppressOverlays = true;

  if (process.env.AXE_TAGS) {
    axeTags = process.env.AXE_TAGS.split(',').map(t => t.trim()).filter(Boolean);
  }

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === '--fail-on' && args[i + 1]) {
      failOn = args[++i] as PipelineOptions['failOn'];
    } else if (arg === '--threshold' && args[i + 1]) {
      threshold = parseInt(args[++i], 10);
    } else if (arg === '--output' && args[i + 1]) {
      output = args[++i];
    } else if (arg === '--output-dir' && args[i + 1]) {
      outputDir = args[++i];
    } else if (arg === '--format' && args[i + 1]) {
      format = args[++i] as PipelineOptions['format'];
    } else if (arg === '--no-insights') {
      noInsights = true;
    } else if (arg === '--multi') {
      multi = true;
    } else if (arg === '--spa' && args[i + 1]) {
      spaConfigPath = args[++i];
    } else if (arg === '--spa-quick' && args[i + 1]) {
      spaQuickUrl = args[++i];
    } else if (arg === '--concurrency' && args[i + 1]) {
      concurrency = parseInt(args[++i], 10);
    } else if (arg === '--schedule' && args[i + 1]) {
      schedule = args[++i];
    } else if (arg === '--schedule-once') {
      scheduleOnce = true;
    } else if (arg === '--notify-webhook' && args[i + 1]) {
      notifyWebhook = args[++i];
    } else if (arg === '--no-screenshots') {
      screenshots = false;
    } else if (arg.startsWith('--screenshot-mode')) {
      const val = arg.includes('=') ? arg.split('=')[1] : args[++i];
      if (val === 'inline' || val === 'files' || val === 'both') screenshotMode = val;
    } else if (arg.startsWith('--json-screenshots')) {
      const val = arg.includes('=') ? arg.split('=')[1] : args[++i];
      if (val === 'paths' || val === 'base64' || val === 'none') jsonScreenshots = val;
    } else if (arg.startsWith('--screenshots-dir')) {
      screenshotsDir = arg.includes('=') ? arg.split('=')[1] : args[++i];
    } else if (arg.startsWith('--max-screenshots')) {
      maxScreenshots = parseInt(arg.includes('=') ? arg.split('=')[1] : args[++i], 10);
    } else if (arg.startsWith('--screenshot-timeout')) {
      screenshotTimeout = parseInt(arg.includes('=') ? arg.split('=')[1] : args[++i], 10);
    } else if (arg === '--no-overlay-suppression') {
      suppressOverlays = false;
    } else if (arg.startsWith('--ui-steps-dir')) {
      // UI automation step loading is opt-in: the scanner only reads steps
      // when UI_STEPS_DIR is set. This flag is sugar for setting that env var.
      const dir = arg.includes('=') ? arg.split('=')[1] : args[++i];
      if (dir) process.env.UI_STEPS_DIR = dir;
    } else if (arg === '--help' || arg === '-h') {
      printUsage();
      process.exit(0);
    } else if (!arg.startsWith('--') && !url) {
      url = arg;
    }
  }

  // In SPA mode, the entry URL comes from the config file or --spa-quick, not the CLI
  // In schedule mode, URL is still required (passed to scheduler as the URL list)
  if (!spaConfigPath && !spaQuickUrl && !schedule && !scheduleOnce
      && (!url || !url.startsWith('http'))) {
    printUsage();
    process.exit(2);
  }

  return {
    url, failOn, threshold, output, outputDir, format, noInsights, multi,
    spaConfigPath, spaQuickUrl, concurrency, axeTags, schedule, scheduleOnce, notifyWebhook,
    screenshots, screenshotMode, jsonScreenshots, screenshotsDir, maxScreenshots, screenshotTimeout,
    suppressOverlays,
  };
}

function printUsage(): void {
  process.stderr.write(`
Allchemy A11Y Scanner - Pipeline Runner

Usage:
  npx ts-node pipeline-runner.ts <url> [options]

Options:
  --fail-on <level>     Severity level to fail on: critical, serious, moderate, minor (default: serious)
  --threshold <n>       Max violations allowed before failing (default: 0)
  --output <path>       Write JSON report to file
  --output-dir <path>   Write JSON + HTML reports to directory
  --format <fmt>        Output format: json | summary (default: summary)
  --no-insights         Skip RAG insights (faster CI runs)
  --multi               Enable multi-page scanning
  --spa <config-path>   Scan a Single-Page App using the given JSON config file
  --spa-quick <url>     Quick SPA scan: auto-detect framework, auto-discover routes (max 20)
  --concurrency <n>     Concurrent scan workers (default: 5)
  --schedule <cron>     Run scans on a cron schedule (e.g., "0 2 * * *")
  --schedule-once       Run once, produce diff report, exit
  --notify-webhook <url> Send webhook notification on regressions
  --no-screenshots      Disable element screenshots (default: ON for reports)
  --screenshot-mode <m> HTML encoding: inline | files | both (default: inline)
  --json-screenshots <m> JSON encoding: paths | base64 | none (default: paths)
  --screenshots-dir <p> Screenshots subdirectory (default: screenshots)
  --max-screenshots <n> Max screenshots per run (default: 50)
  --screenshot-timeout <ms> Per-shot timeout (default: 2000)
  --no-overlay-suppression  Keep consent/overlay scrims in screenshots (default: suppressed)
  --ui-steps-dir <dir>  Load UI automation steps from <dir> (opt-in; sets UI_STEPS_DIR)
  -h, --help            Show this help

Environment Variables:
  SCAN_URL, SCAN_THRESHOLD, SCAN_FAIL_ON, SCAN_OUTPUT, SPA_CONFIG, UI_STEPS_DIR
  FIRECRAWL_API_KEY, MULTI_PAGE, SCAN_CONCURRENCY, AXE_TAGS
  SCAN_SCHEDULE, SCAN_NOTIFY_WEBHOOK

Exit Codes:
  0 = pass    1 = fail    2 = error
`);
}

// ============================================================================
// Summary Output
// ============================================================================

function printSummary(
  stats: { critical: number; serious: number; moderate: number; minor: number; total: number },
  failOn: string,
  threshold: number,
  failingCount: number,
  passed: boolean,
  url: string,
  elapsed: number,
): void {
  const line = '─'.repeat(52);
  process.stderr.write(`\n${line}\n`);
  process.stderr.write(`  ACCESSIBILITY SCAN REPORT\n`);
  process.stderr.write(`${line}\n`);
  process.stderr.write(`  URL:        ${url}\n`);
  process.stderr.write(`  Duration:   ${(elapsed / 1000).toFixed(1)}s\n`);
  process.stderr.write(`  Standard:   WCAG 2.1 AA\n`);
  process.stderr.write(`${line}\n`);
  process.stderr.write(`  VIOLATIONS\n`);
  process.stderr.write(`  Critical:   ${stats.critical}\n`);
  process.stderr.write(`  Serious:    ${stats.serious}\n`);
  process.stderr.write(`  Moderate:   ${stats.moderate}\n`);
  process.stderr.write(`  Minor:      ${stats.minor}\n`);
  process.stderr.write(`  Total:      ${stats.total}\n`);
  process.stderr.write(`${line}\n`);
  process.stderr.write(`  POLICY\n`);
  process.stderr.write(`  Fail on:    ${failOn} and above\n`);
  process.stderr.write(`  Threshold:  ${threshold} allowed\n`);
  process.stderr.write(`  Failing:    ${failingCount} violation(s)\n`);
  process.stderr.write(`${line}\n`);
  process.stderr.write(`  RESULT:     ${passed ? 'PASS' : 'FAIL'}\n`);
  process.stderr.write(`${line}\n\n`);
}

// ============================================================================
// Main Pipeline
// ============================================================================

async function main(): Promise<void> {
  const opts = parseArgs();
  const startTime = Date.now();

  // ---- Schedule branch: cron or one-shot schedule with diff ----
  if (opts.schedule || opts.scheduleOnce) {
    await runScheduled(opts, startTime);
    return;
  }

  // ---- SPA branch: fully separate from single/multi page scanning ----
  if (opts.spaQuickUrl) {
    // --spa-quick: auto-generate a minimal config with crawl discovery
    const quickConfig: import('../../types/spa-config').SPAScanConfig = {
      entryUrl: opts.spaQuickUrl,
      framework: 'generic',  // auto-detected at runtime
      discovery: { mode: 'auto', maxRoutes: 20 },
      routes: [],
    };
    // Write to a temp file so runSPAScan can load it. Use the output dir when
    // given (so the generated config ships with the report); otherwise create a
    // fresh private temp dir rather than a fixed, predictable /tmp path.
    let configDir: string;
    if (opts.outputDir) {
      configDir = opts.outputDir;
      mkdirSync(configDir, { recursive: true });
    } else {
      configDir = mkdtempSync(join(tmpdir(), 'aether-'));
    }
    const tmpPath = join(configDir, 'spa-quick-config.json');
    writeFileSync(tmpPath, JSON.stringify(quickConfig, null, 2));
    opts.spaConfigPath = tmpPath;
  }
  if (opts.spaConfigPath) {
    await runSPAScan(opts, startTime);
    return;
  }

  process.stderr.write(`[pipeline] Scanning ${opts.url}\n`);
  process.stderr.write(`[pipeline] Policy: fail on ${opts.failOn}+, threshold=${opts.threshold}\n`);

  if (opts.noInsights) {
    process.stderr.write(`[pipeline] Insights: disabled (--no-insights)\n`);
  }

  const scanner = new ClusterScanner(opts.multi ? opts.concurrency : 1, opts.axeTags);

  try {
    await scanner.initialize();

    let allViolations: Violation[] = [];
    let report: ScanReport | MultiPageScanReport;
    let scanResult: PageScanResult | null = null;
    let screenshotBudget = { taken: 0, max: 0 };

    if (opts.multi) {
      // Multi-page scan
      process.stderr.write(`[pipeline] Mode: multi-page\n`);

      const crawlMap = await getCrawlMap(opts.url);
      const domain = extractDomain(opts.url);
      let urls = filterDomainUrls(crawlMap.urls, domain);
      urls = deduplicateUrls(urls);
      urls = filterUrls(urls, domain);
      urls = limitUrls(urls, parseInt(process.env.FIRECRAWL_PAGE_LIMIT || '50'));

      process.stderr.write(`[pipeline] Found ${urls.length} pages to scan\n`);

      const pageResults = await scanner.scanUrls(urls);

      // Optionally add insights
      if (!opts.noInsights) {
        for (const result of pageResults) {
          if (result.success && result.violations.length > 0) {
            try {
              const insightReport = await generateReport(result.violations, result.url);
              result.insights = insightReport.insights;
            } catch {
              // Insights are optional in CI mode
            }
          }
        }
      }

      // Aggregate
      const aggregated = aggregateResults(pageResults, domain);
      const violationSummary = getViolationSummary(pageResults);
      const worstPages = getWorstPages(pageResults, 5);
      const failedScans = getFailedScans(pageResults);

      report = {
        ...aggregated,
        advancedStats: {
          violationSummary,
          worstPages: worstPages.map(p => ({ url: p.url, violationCount: p.violations.length })),
          failedScans: failedScans.map(p => ({ url: p.url, error: p.error })),
        },
      } as MultiPageScanReport & { advancedStats: unknown };

      for (const r of pageResults) {
        allViolations.push(...r.violations);
      }
    } else {
      // Single-page scan
      process.stderr.write(`[pipeline] Mode: single-page\n`);

      // Element screenshots (SME Issue 1) — desktop-only, best-effort capture.
      const shotSetup = await buildScreenshotScanOptions(opts);
      if (shotSetup) {
        screenshotBudget = shotSetup.budget;
        process.stderr.write(
          `[pipeline] Screenshots: on (max ${opts.maxScreenshots}, mode ${opts.screenshotMode})\n`,
        );
      }

      scanResult = await scanner.scanUrl(opts.url, shotSetup?.scanOpts);

      if (!scanResult || !scanResult.success) {
        throw new Error(scanResult?.error || 'Scan failed');
      }

      allViolations = scanResult.violations;

      if (!opts.noInsights && allViolations.length > 0) {
        try {
          report = await generateReport(allViolations, opts.url);
        } catch {
          // Fall back to report without insights
          report = buildBasicReport(allViolations, opts.url);
        }
      } else {
        report = buildBasicReport(allViolations, opts.url);
      }
    }

    const stats = calculateViolationStats(allViolations);

    const failingCount = countViolationsAtOrAbove(allViolations, opts.failOn);
    const passed = failingCount <= opts.threshold;
    const elapsed = Date.now() - startTime;

    // Add pipeline metadata to report
    report.pipeline = {
      failOn: opts.failOn,
      threshold: opts.threshold,
      failingViolations: failingCount,
      passed,
      elapsedMs: elapsed,
      timestamp: new Date().toISOString(),
    };

    // Screenshot descriptor (single-page ScanReport metadata).
    if (!opts.multi && 'metadata' in report) {
      (report as ScanReport).metadata.screenshots = screenshotsMetadata(opts, screenshotBudget.taken);
    }

    // Output report
    if (opts.output) {
      writeFileSync(opts.output, stringifyReport(report, opts));
      process.stderr.write(`[pipeline] Report written to ${opts.output}\n`);
    }

    // Output directory: write JSON + HTML
    if (opts.outputDir) {
      mkdirSync(opts.outputDir, { recursive: true });
      const jsonPath = `${opts.outputDir}/report.json`;
      writeFileSync(jsonPath, stringifyReport(report, opts));
      process.stderr.write(`[pipeline] JSON report written to ${jsonPath}\n`);
      if (!opts.multi && screenshotBudget.taken > 0) {
        process.stderr.write(`[pipeline] Captured ${screenshotBudget.taken} screenshot(s)\n`);
      }

      try {
        let batchReport: BatchReport;
        let scanReports: ScanReport[];

        if (opts.multi && 'pageResults' in report) {
          // Multi-page: convert PageScanResult[] → ScanReport[] for HTMLReporter
          const multiReport = report as MultiPageScanReport;
          const successfulPages = multiReport.pageResults.filter(p => p.success);
          const failedPages = multiReport.pageResults.filter(p => !p.success);

          scanReports = successfulPages.map(p => ({
            metadata: {
              url: p.url,
              scanDate: p.scanDate,
              pageScanned: p.url,
              standard: 'WCAG 2.1 AA',
            },
            statistics: calculateViolationStats(p.violations),
            summary: `Found ${p.violations.length} violation(s).`,
            violations: p.violations,
            insights: p.insights,
            viewportResults: p.viewportResults,
          }));

          batchReport = {
            timestamp: new Date().toISOString(),
            totalUrls: multiReport.pageResults.length,
            successful: successfulPages.length,
            failed: failedPages.length,
            results: multiReport.pageResults.map(p => ({
              url: p.url,
              success: p.success,
              scanDate: p.scanDate,
              jsonFile: jsonPath,
              statistics: p.success ? calculateViolationStats(p.violations) : undefined,
              error: p.error,
            })),
          };
        } else {
          // Single-page
          scanReports = [report as ScanReport];
          batchReport = {
            timestamp: new Date().toISOString(),
            totalUrls: 1,
            successful: 1,
            failed: 0,
            results: [{
              url: opts.url,
              success: true,
              scanDate: new Date().toISOString(),
              jsonFile: jsonPath,
              statistics: stats,
            }],
          };
        }

        const htmlPath = await HTMLReporter.generateReport(
          opts.outputDir, batchReport, scanReports, { mode: opts.screenshotMode },
        );
        process.stderr.write(`[pipeline] HTML report written to ${htmlPath}\n`);
      } catch (htmlErr) {
        process.stderr.write(`[pipeline] Warning: HTML report generation failed: ${(htmlErr as Error).message}\n`);
      }

      // Generate UI automation report if automation steps were executed
      if (scanResult?.uiAutomationResults) {
        try {
          const automationPath = await AutomationReporter.generateReport(
            opts.outputDir, opts.url, scanResult.uiAutomationResults
          );
          process.stderr.write(`[pipeline] Automation report written to ${automationPath}\n`);
        } catch (autoErr) {
          process.stderr.write(`[pipeline] Warning: Automation report generation failed: ${(autoErr as Error).message}\n`);
        }
      }
    }

    if (opts.format === 'json') {
      console.log(stringifyReport(report, opts));
    } else {
      printSummary(stats, opts.failOn, opts.threshold, failingCount, passed, opts.url, elapsed);
    }

    await scanner.cleanup();

    process.exit(passed ? 0 : 1);
  } catch (err) {
    await scanner.cleanup();
    process.stderr.write(`[pipeline] ERROR: ${(err as Error).message}\n`);
    process.exit(2);
  }
}

// ============================================================================
// Element screenshots (SME Issue 1)
// ============================================================================

/**
 * Build the per-scan screenshot options (sink + budget) for a run, or return
 * null when screenshots are disabled or there's no output directory to write
 * them to (files on disk are the source of truth). The sink directory is
 * wiped + recreated so a re-scan never leaves orphaned images.
 *
 * Sink selection is env-gated (mirrors FEEDBACK_SINK): `local` today; a future
 * `gcs` value would swap in a GcsScreenshotSink behind the same interface.
 */
async function buildScreenshotScanOptions(
  opts: PipelineOptions,
): Promise<{ scanOpts: ScanOptions; budget: { taken: number; max: number } } | null> {
  if (!opts.screenshots || !opts.outputDir) {
    if (opts.screenshots && !opts.outputDir) {
      process.stderr.write('[pipeline] Screenshots need --output-dir; skipping capture.\n');
    }
    return null;
  }

  const sinkKind = (process.env.SCREENSHOT_SINK || 'local').toLowerCase();
  if (sinkKind !== 'local') {
    process.stderr.write(`[pipeline] SCREENSHOT_SINK=${sinkKind} not available; using local.\n`);
  }
  const sink = new LocalFileSink(opts.outputDir, opts.screenshotsDir);
  await sink.reset();

  const budget = { taken: 0, max: opts.maxScreenshots };
  const screenshots: ScreenshotScanOptions = {
    sink,
    budget,
    timeoutMs: opts.screenshotTimeout,
    format: 'webp',
    scanId: `scan_${randomUUID()}`,
    suppressOverlays: opts.suppressOverlays,
  };
  return { scanOpts: { screenshots }, budget };
}

/** The report-metadata descriptor for the screenshot artifacts. */
function screenshotsMetadata(
  opts: PipelineOptions,
  count: number,
): import('../../types/a11y').ScreenshotsMetadata {
  if (!opts.screenshots || !opts.outputDir) return { enabled: false };
  return {
    enabled: true,
    mode: opts.screenshotMode,
    jsonMode: opts.jsonScreenshots,
    format: 'webp',
    types: ['crop', 'context'],
    directory: opts.screenshotsDir,
    count,
    storage: 'local',
    overlaySuppression: opts.suppressOverlays,
  };
}

/**
 * JSON.stringify replacer that re-encodes `screenshot` blocks per
 * `--json-screenshots`: `paths` (default, no-op), `base64` (inline data URIs,
 * read from disk), or `none` (strip). Applied at serialization time so the
 * in-memory report (which the HTML step reads) keeps its relative paths.
 */
function makeScreenshotReplacer(
  opts: PipelineOptions,
): ((key: string, value: unknown) => unknown) | undefined {
  if (opts.jsonScreenshots === 'paths' || !opts.outputDir) return undefined;
  const outputDir = opts.outputDir;
  const conv = (p?: string): string | undefined => {
    if (!p || p.startsWith('data:')) return p;
    try {
      const buf = readFileSync(join(outputDir, p));
      const mime = p.toLowerCase().endsWith('.png') ? 'image/png' : 'image/webp';
      return `data:${mime};base64,${buf.toString('base64')}`;
    } catch {
      return p;
    }
  };
  return (key, value) => {
    if (
      key === 'screenshot' &&
      value &&
      typeof value === 'object' &&
      ('crop' in value || 'context' in value)
    ) {
      if (opts.jsonScreenshots === 'none') return undefined;
      const shot = value as { crop?: string; context?: string };
      return { ...shot, crop: conv(shot.crop), context: conv(shot.context) };
    }
    return value;
  };
}

/** Serialize a report to JSON honoring the active --json-screenshots mode. */
function stringifyReport(report: unknown, opts: PipelineOptions): string {
  return JSON.stringify(report, makeScreenshotReplacer(opts) as never, 2);
}

function buildBasicReport(violations: Violation[], url: string): ScanReport {
  const stats = calculateViolationStats(violations);

  return {
    metadata: {
      url,
      scanDate: new Date().toISOString(),
      pageScanned: url,
      standard: 'WCAG 2.1 AA',
    },
    statistics: stats,
    summary: stats.total === 0
      ? 'No accessibility violations found.'
      : `Found ${stats.total} accessibility violation(s).`,
    violations,
  };
}

// ============================================================================
// SPA Scan Branch
// ============================================================================

/**
 * Map an SPARouteResult → PageScanResult so the existing HTMLReporter can
 * render it without knowing anything about SPAs. Annotates the result with
 * `route`, `stateKey`, `stabilityStrategy`, and `discoveryMethod` for the
 * reporter to surface in Milestone 3.
 */
function spaRouteToPageScanResult(r: SPARouteResult): PageScanResult {
  return {
    url: r.url,
    violations: r.violations,
    scanDate: r.scanDate,
    success: r.success,
    ...(r.error && { error: r.error }),
    ...(r.insights && { insights: r.insights }),
    ...(r.viewportResults && { viewportResults: r.viewportResults }),
    ...(r.uiAutomationResults && { uiAutomationResults: r.uiAutomationResults }),
    route: r.route,
    stateKey: r.stateKey,
    stabilityStrategy: r.stabilityStrategy,
    discoveryMethod: r.discoveryMethod,
  };
}

async function runSPAScan(opts: PipelineOptions, startTime: number): Promise<void> {
  const configPath = opts.spaConfigPath!;
  process.stderr.write(`[pipeline] Mode: spa (config: ${configPath})\n`);

  // Load + validate the SPA config. Any validation error exits with code 2.
  let config;
  try {
    config = loadSPAConfig(configPath);
  } catch (err) {
    if (err instanceof SPAConfigError) {
      process.stderr.write(`[pipeline] ${err.message}\n`);
    } else {
      process.stderr.write(`[pipeline] Failed to load SPA config: ${(err as Error).message}\n`);
    }
    process.exit(2);
  }

  const discoveryLabel = config.discovery?.mode !== 'manual'
    ? ` | Discovery: ${config.discovery.mode}`
    : '';
  process.stderr.write(
    `[pipeline] Entry: ${config.entryUrl} | Framework: ${config.framework} | Routes: ${config.routes.length}${discoveryLabel}\n`,
  );
  process.stderr.write(`[pipeline] Policy: fail on ${opts.failOn}+, threshold=${opts.threshold}\n`);

  const scanner = new SPAScanner(config, opts.axeTags);

  try {
    await scanner.initialize();

    // Element screenshots (SME Issue 1) — desktop-only, per-route prefixed.
    const shotSetup = await buildScreenshotScanOptions(opts);
    if (shotSetup) {
      process.stderr.write(
        `[pipeline] Screenshots: on (max ${opts.maxScreenshots}, mode ${opts.screenshotMode})\n`,
      );
    }

    const spaReport: SPAScanReport = await scanner.scan(shotSetup?.scanOpts);

    // Optionally enrich successful route results with insights
    if (!opts.noInsights) {
      for (const route of spaReport.routeResults) {
        if (route.success && route.violations.length > 0) {
          try {
            const insightReport = await generateReport(route.violations, route.url);
            route.insights = insightReport.insights;
          } catch {
            // Insights are optional in CI mode
          }
        }
      }
    }

    const allViolations: Violation[] = spaReport.routeResults.flatMap(r => r.violations);
    const stats = calculateViolationStats(allViolations);
    const failingCount = countViolationsAtOrAbove(allViolations, opts.failOn);
    const passed = failingCount <= opts.threshold;
    const elapsed = Date.now() - startTime;

    spaReport.pipeline = {
      failOn: opts.failOn,
      threshold: opts.threshold,
      failingViolations: failingCount,
      passed,
      elapsedMs: elapsed,
      timestamp: new Date().toISOString(),
    };

    // Write JSON report
    if (opts.output) {
      writeFileSync(opts.output, stringifyReport(spaReport, opts));
      process.stderr.write(`[pipeline] Report written to ${opts.output}\n`);
    }

    // Write JSON + HTML to output directory
    if (opts.outputDir) {
      mkdirSync(opts.outputDir, { recursive: true });
      const jsonPath = `${opts.outputDir}/report.json`;
      writeFileSync(jsonPath, stringifyReport(spaReport, opts));
      process.stderr.write(`[pipeline] JSON report written to ${jsonPath}\n`);

      // Map SPA routes → ScanReport[] so HTMLReporter can render them
      try {
        const pageResults = spaReport.routeResults.map(spaRouteToPageScanResult);
        const successfulPages = pageResults.filter(p => p.success);
        const failedPages = pageResults.filter(p => !p.success);

        const scanReports: ScanReport[] = successfulPages.map(p => ({
          metadata: {
            url: p.url,
            scanDate: p.scanDate,
            pageScanned: p.url,
            standard: 'WCAG 2.1 AA',
          },
          statistics: calculateViolationStats(p.violations),
          summary: `Found ${p.violations.length} violation(s).`,
          violations: p.violations,
          insights: p.insights,
          viewportResults: p.viewportResults,
        }));

        const batchReport: BatchReport = {
          timestamp: new Date().toISOString(),
          totalUrls: pageResults.length,
          successful: successfulPages.length,
          failed: failedPages.length,
          results: pageResults.map(p => ({
            url: p.url,
            success: p.success,
            scanDate: p.scanDate,
            jsonFile: jsonPath,
            statistics: p.success ? calculateViolationStats(p.violations) : undefined,
            error: p.error,
          })),
        };

        const htmlPath = await HTMLReporter.generateReport(
          opts.outputDir, batchReport, scanReports, { mode: opts.screenshotMode },
        );
        process.stderr.write(`[pipeline] HTML report written to ${htmlPath}\n`);
      } catch (htmlErr) {
        process.stderr.write(
          `[pipeline] Warning: HTML report generation failed: ${(htmlErr as Error).message}\n`,
        );
      }

      // Per-route automation reports (one per route that had interactions)
      for (const route of spaReport.routeResults) {
        if (route.uiAutomationResults) {
          try {
            const safeRouteName = route.routeName.replace(/[^a-z0-9_-]+/gi, '-').toLowerCase();
            const automationPath = await AutomationReporter.generateReport(
              opts.outputDir,
              `${route.url} [${safeRouteName}]`,
              route.uiAutomationResults,
            );
            process.stderr.write(`[pipeline] Automation report written to ${automationPath}\n`);
          } catch (autoErr) {
            process.stderr.write(
              `[pipeline] Warning: Automation report generation failed: ${(autoErr as Error).message}\n`,
            );
          }
        }
      }
    }

    if (opts.format === 'json') {
      console.log(stringifyReport(spaReport, opts));
    } else {
      printSPASummary(spaReport, opts, failingCount, passed, elapsed);
    }

    await scanner.cleanup();
    process.exit(passed ? 0 : 1);
  } catch (err) {
    await scanner.cleanup();
    process.stderr.write(`[pipeline] ERROR: ${(err as Error).message}\n`);
    process.exit(2);
  }
}

function printSPASummary(
  report: SPAScanReport,
  opts: PipelineOptions,
  failingCount: number,
  passed: boolean,
  elapsed: number,
): void {
  const line = '─'.repeat(52);
  const stats = report.statistics;
  process.stderr.write(`\n${line}\n`);
  process.stderr.write(`  SPA ACCESSIBILITY SCAN REPORT\n`);
  process.stderr.write(`${line}\n`);
  process.stderr.write(`  Entry URL:  ${report.metadata.entryUrl}\n`);
  process.stderr.write(`  Framework:  ${report.metadata.framework}\n`);
  process.stderr.write(`  Routes:     ${report.metadata.routesScanned}\n`);
  process.stderr.write(`  Duration:   ${(elapsed / 1000).toFixed(1)}s\n`);
  process.stderr.write(`  Standard:   WCAG 2.1 AA\n`);
  process.stderr.write(`${line}\n`);
  process.stderr.write(`  VIOLATIONS\n`);
  process.stderr.write(`  Critical:   ${stats.critical}\n`);
  process.stderr.write(`  Serious:    ${stats.serious}\n`);
  process.stderr.write(`  Moderate:   ${stats.moderate}\n`);
  process.stderr.write(`  Minor:      ${stats.minor}\n`);
  process.stderr.write(`  Total:      ${stats.total}  (${stats.routesWithIssues} route(s) affected)\n`);
  process.stderr.write(`${line}\n`);
  process.stderr.write(`  STABILITY CASCADE\n`);
  for (const [strategy, count] of Object.entries(report.stabilityMetrics.winsByStrategy)) {
    if (count > 0) {
      process.stderr.write(`  ${strategy.padEnd(28)} ${count}\n`);
    }
  }
  process.stderr.write(`  avg duration:              ${report.stabilityMetrics.averageDurationMs}ms\n`);
  process.stderr.write(`${line}\n`);
  process.stderr.write(`  POLICY\n`);
  process.stderr.write(`  Fail on:    ${opts.failOn} and above\n`);
  process.stderr.write(`  Threshold:  ${opts.threshold} allowed\n`);
  process.stderr.write(`  Failing:    ${failingCount} violation(s)\n`);
  process.stderr.write(`${line}\n`);
  process.stderr.write(`  RESULT:     ${passed ? 'PASS' : 'FAIL'}\n`);
  process.stderr.write(`${line}\n\n`);
}

// ============================================================================
// Scheduled Scan Mode
// ============================================================================

async function runScheduled(opts: PipelineOptions, startTime: number): Promise<void> {
  const outputDir = opts.outputDir || './scan-results';
  mkdirSync(outputDir, { recursive: true });

  const scheduleConfig: ScheduleConfig = {
    schedule: opts.schedule || '* * * * *',
    urls: [opts.url],
    outputDir,
    failOn: opts.failOn,
    ...(opts.notifyWebhook && {
      notification: {
        type: 'webhook' as const,
        url: opts.notifyWebhook,
        onlyOnRegression: true,
      },
    }),
  };

  // Create a scan function that runs the actual pipeline
  const scanFn = async (url: string): Promise<Violation[]> => {
    const scanner = new ClusterScanner(1, opts.axeTags);
    try {
      await scanner.initialize();
      const result = await scanner.scanUrl(url);
      await scanner.cleanup();

      if (!result || !result.success) {
        process.stderr.write(`[schedule] Scan failed for ${url}: ${result?.error || 'unknown'}\n`);
        return [];
      }

      return result.violations;
    } catch (err) {
      await scanner.cleanup().catch(() => void 0);
      throw err;
    }
  };

  const scheduler = new ScanScheduler(scheduleConfig, scanFn);

  if (opts.scheduleOnce) {
    // One-shot: run, diff, report, exit
    process.stderr.write(`[schedule] Running one-shot scan for ${opts.url}\n`);
    const diffs = await scheduler.runNow();

    const elapsed = Date.now() - startTime;
    for (const diff of diffs) {
      process.stderr.write(`\n[schedule] ${diff.summary}\n`);
      if (diff.newViolations.length > 0) {
        process.stderr.write(`[schedule] New regressions:\n`);
        for (const v of diff.newViolations) {
          process.stderr.write(`  - ${v.ruleId} @ ${v.target}\n`);
        }
      }
      if (diff.fixedViolations.length > 0) {
        process.stderr.write(`[schedule] Fixed:\n`);
        for (const v of diff.fixedViolations) {
          process.stderr.write(`  - ${v.ruleId} @ ${v.target}\n`);
        }
      }
    }

    process.stderr.write(`[schedule] Elapsed: ${(elapsed / 1000).toFixed(1)}s\n`);

    const hasRegressions = diffs.some(d => d.hasRegressions);
    process.exit(hasRegressions ? 1 : 0);
  } else {
    // Cron loop: run indefinitely
    process.stderr.write(`[schedule] Starting cron schedule: ${opts.schedule}\n`);
    process.stderr.write(`[schedule] Press Ctrl+C to stop.\n`);

    scheduler.start();

    const shutdown = () => {
      process.stderr.write('\n[schedule] Shutting down...\n');
      scheduler.stop();
      process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);

    // Keep process alive
    await new Promise<never>(() => {});
  }
}

// Only run main() when this file is the entrypoint, not when imported for testing
const isDirectRun = process.argv[1]?.endsWith('pipeline-runner.ts')
  || process.argv[1]?.endsWith('pipeline-runner.js');
if (isDirectRun) {
  main();
}

/**
 * Scan Scheduler
 * ==============
 *
 * Cron-based scan scheduling with diff detection and webhook notifications.
 * Runs scans on a recurring schedule, compares results against the previous
 * run, and notifies via webhook when new violations (regressions) are found.
 *
 * Designed for client-side execution: runs on customer infra (Jenkins,
 * GitHub Actions, Docker, or standalone).
 *
 * Usage:
 *   const scheduler = new ScanScheduler(config);
 *   scheduler.start();    // begin cron schedule
 *   scheduler.stop();     // graceful shutdown
 *   await scheduler.runNow();  // manual trigger (for testing / --schedule-once)
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import type { Violation } from '../../types/a11y';

// ============================================================================
// Configuration
// ============================================================================

export interface ScheduleConfig {
  /** Cron expression (e.g., "0 2 * * *" for daily 2am) */
  schedule: string;
  /** URLs to scan */
  urls: string[];
  /** Base output directory for timestamped reports */
  outputDir: string;
  /** Optional SPA config path */
  spaConfig?: string;
  /** Severity level at which to flag regressions: "critical" | "serious" | "moderate" | "minor" */
  failOn?: string;
  /** Insights API endpoint */
  insightUrl?: string;
  /** Retries per URL on failure (default: 2) */
  maxRetries?: number;
  /** What to produce after each run (default: 'both') */
  onComplete?: 'report' | 'diff' | 'both';
  /** Webhook notification config */
  notification?: {
    type: 'webhook';
    url: string;
    onlyOnRegression?: boolean;
  };
}

// ============================================================================
// Diff Detection
// ============================================================================

export interface ViolationSnapshot {
  /** `${ruleId}::${target}` */
  key: string;
  ruleId: string;
  target: string;
  impact?: string;
}

export interface ScanDiff {
  /** Violations present in current run but not in previous */
  newViolations: ViolationSnapshot[];
  /** Violations present in previous run but not in current (fixed) */
  fixedViolations: ViolationSnapshot[];
  /** Violations present in both runs */
  unchangedViolations: ViolationSnapshot[];
  /** Whether new regressions were found */
  hasRegressions: boolean;
  /** Summary message */
  summary: string;
}

export interface ScanHistoryEntry {
  timestamp: string;
  url: string;
  violationSnapshots: ViolationSnapshot[];
  totalViolations: number;
}

export interface ScanHistory {
  lastRun?: ScanHistoryEntry;
  runs: ScanHistoryEntry[];
}

/**
 * Convert raw Violation[] to deduplicated ViolationSnapshot[] for diffing.
 */
export function snapshotViolations(violations: Violation[]): ViolationSnapshot[] {
  const seen = new Set<string>();
  const snapshots: ViolationSnapshot[] = [];

  for (const v of violations) {
    for (const node of v.nodes ?? []) {
      const target = Array.isArray(node.target) ? node.target.join(',') : String(node.target ?? '');
      const key = `${v.id}::${target}`;
      if (!seen.has(key)) {
        seen.add(key);
        snapshots.push({ key, ruleId: v.id, target, impact: v.impact });
      }
    }
    // If no nodes, snapshot the rule itself
    if (!v.nodes || v.nodes.length === 0) {
      const key = `${v.id}::`;
      if (!seen.has(key)) {
        seen.add(key);
        snapshots.push({ key, ruleId: v.id, target: '', impact: v.impact });
      }
    }
  }

  return snapshots;
}

/**
 * Compare two sets of violation snapshots to detect new, fixed, and
 * unchanged violations.
 */
export function diffSnapshots(
  previous: ViolationSnapshot[],
  current: ViolationSnapshot[],
): ScanDiff {
  const prevKeys = new Set(previous.map(s => s.key));
  const currKeys = new Set(current.map(s => s.key));

  const newViolations = current.filter(s => !prevKeys.has(s.key));
  const fixedViolations = previous.filter(s => !currKeys.has(s.key));
  const unchangedViolations = current.filter(s => prevKeys.has(s.key));

  const hasRegressions = newViolations.length > 0;

  let summary: string;
  if (newViolations.length === 0 && fixedViolations.length === 0) {
    summary = `No changes detected. ${unchangedViolations.length} violation(s) unchanged.`;
  } else {
    const parts: string[] = [];
    if (newViolations.length > 0) {
      parts.push(`${newViolations.length} new violation(s)`);
    }
    if (fixedViolations.length > 0) {
      parts.push(`${fixedViolations.length} fixed`);
    }
    parts.push(`${unchangedViolations.length} unchanged`);
    summary = parts.join(', ') + '.';
  }

  return { newViolations, fixedViolations, unchangedViolations, hasRegressions, summary };
}

// ============================================================================
// History persistence
// ============================================================================

const HISTORY_FILE = '.scan-history.json';

export function loadHistory(outputDir: string): ScanHistory {
  const historyPath = join(outputDir, HISTORY_FILE);
  if (!existsSync(historyPath)) {
    return { runs: [] };
  }
  try {
    const raw = readFileSync(historyPath, 'utf-8');
    return JSON.parse(raw) as ScanHistory;
  } catch {
    return { runs: [] };
  }
}

export function saveHistory(outputDir: string, history: ScanHistory): void {
  mkdirSync(outputDir, { recursive: true });
  const historyPath = join(outputDir, HISTORY_FILE);
  writeFileSync(historyPath, JSON.stringify(history, null, 2));
}

// ============================================================================
// Webhook notification
// ============================================================================

export interface WebhookPayload {
  scanner: string;
  timestamp: string;
  url: string;
  diff: ScanDiff;
  totalCurrent: number;
  totalPrevious: number;
}

export function buildWebhookPayload(
  url: string,
  diff: ScanDiff,
  totalCurrent: number,
  totalPrevious: number,
): WebhookPayload {
  return {
    scanner: 'allchemy-a11y',
    timestamp: new Date().toISOString(),
    url,
    diff,
    totalCurrent,
    totalPrevious,
  };
}

export async function sendWebhook(
  webhookUrl: string,
  payload: WebhookPayload,
): Promise<boolean> {
  try {
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    return response.ok;
  } catch {
    return false;
  }
}

// ============================================================================
// Config validation
// ============================================================================

export function validateScheduleConfig(config: ScheduleConfig): string[] {
  const errors: string[] = [];

  if (!config.schedule || typeof config.schedule !== 'string') {
    errors.push('"schedule" is required and must be a cron expression string');
  }
  if (!Array.isArray(config.urls) || config.urls.length === 0) {
    errors.push('"urls" is required and must be a non-empty array');
  }
  if (!config.outputDir || typeof config.outputDir !== 'string') {
    errors.push('"outputDir" is required and must be a string');
  }
  if (config.notification) {
    if (config.notification.type !== 'webhook') {
      errors.push('"notification.type" must be "webhook"');
    }
    if (!config.notification.url || typeof config.notification.url !== 'string') {
      errors.push('"notification.url" is required when notification is configured');
    }
  }

  return errors;
}

// ============================================================================
// ScanScheduler class
// ============================================================================

/** Callback that runs the actual scan and returns violations for a URL. */
export type ScanFunction = (url: string) => Promise<Violation[]>;

export class ScanScheduler {
  private readonly config: ScheduleConfig;
  private readonly scanFn: ScanFunction;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(config: ScheduleConfig, scanFn?: ScanFunction) {
    const errors = validateScheduleConfig(config);
    if (errors.length > 0) {
      throw new Error(`Invalid schedule config: ${errors.join('; ')}`);
    }
    this.config = config;
    this.scanFn = scanFn ?? (async () => []);
  }

  /**
   * Start the cron schedule. Uses a simple setInterval-based approach
   * that checks once per minute whether the cron expression matches.
   * For production use, customers should use OS cron / Jenkins / GitHub
   * Actions instead of long-running Node processes.
   */
  start(): void {
    if (this.timer) return;
    process.stderr.write(`[scheduler] Started with schedule: ${this.config.schedule}\n`);
    // Check every 60 seconds if the cron expression matches
    this.timer = setInterval(() => {
      if (this.shouldRun() && !this.running) {
        this.runNow().catch(err => {
          process.stderr.write(`[scheduler] Run failed: ${(err as Error).message}\n`);
        });
      }
    }, 60_000);
  }

  /** Graceful shutdown — stops the cron timer. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      process.stderr.write('[scheduler] Stopped.\n');
    }
  }

  /** Whether the scheduler has an active timer. */
  isRunning(): boolean {
    return this.timer !== null;
  }

  /**
   * Execute a scan run immediately (for testing or --schedule-once).
   * Returns the diff result for each URL.
   */
  async runNow(): Promise<ScanDiff[]> {
    this.running = true;
    const diffs: ScanDiff[] = [];

    try {
      const history = loadHistory(this.config.outputDir);

      for (const url of this.config.urls) {
        process.stderr.write(`[scheduler] Scanning ${url}...\n`);

        // Find previous snapshot for this URL
        const previousEntry = history.runs
          .filter(r => r.url === url)
          .sort((a, b) => b.timestamp.localeCompare(a.timestamp))[0];

        const previousSnapshots = previousEntry?.violationSnapshots ?? [];

        // Run the actual scan via the injected scanFn
        let violations: Violation[] = [];
        try {
          violations = await this.scanFn(url);
        } catch (err) {
          process.stderr.write(
            `[scheduler] Scan failed for ${url}: ${(err as Error).message}\n`,
          );
        }

        const currentSnapshots = snapshotViolations(violations);

        const diff = diffSnapshots(previousSnapshots, currentSnapshots);
        diffs.push(diff);

        // Save to history
        const entry: ScanHistoryEntry = {
          timestamp: new Date().toISOString(),
          url,
          violationSnapshots: currentSnapshots,
          totalViolations: currentSnapshots.length,
        };
        history.runs.push(entry);
        history.lastRun = entry;

        // Notify if configured
        if (this.config.notification && diff.hasRegressions) {
          const shouldNotify =
            !this.config.notification.onlyOnRegression || diff.hasRegressions;
          if (shouldNotify) {
            const payload = buildWebhookPayload(
              url,
              diff,
              currentSnapshots.length,
              previousSnapshots.length,
            );
            await sendWebhook(this.config.notification.url, payload);
          }
        }
      }

      saveHistory(this.config.outputDir, history);
    } finally {
      this.running = false;
    }

    return diffs;
  }

  /** Basic cron match — checks minute and hour fields against current time. */
  private shouldRun(): boolean {
    const now = new Date();
    const parts = this.config.schedule.split(/\s+/);
    if (parts.length < 5) return false;

    const [minute, hour] = parts;
    const matchesMinute = minute === '*' || parseInt(minute) === now.getMinutes();
    const matchesHour = hour === '*' || parseInt(hour) === now.getHours();

    return matchesMinute && matchesHour;
  }
}

/**
 * Scanner Manager — Lazy Chromium lifecycle for the MCP server.
 *
 * Launches Chromium on first scan request and shuts it down after 60s of
 * inactivity. This avoids burning memory when the developer isn't actively
 * scanning while keeping the browser warm for rapid re-scans.
 *
 * In-flight guard: the idle timer must never tear down the browser while a
 * scan is running. A single long scan (e.g. a slow site whose scan exceeds
 * IDLE_TIMEOUT_MS) previously let the timer fire mid-scan, close the browser,
 * and leave the next scan hitting a torn-down instance ("All viewport scans
 * failed"). We now track active scans; idle shutdown is deferred until the
 * last one completes, and every scan re-arms the idle timer when it finishes.
 */

import { ClusterScanner } from '../../concepts/a11y-scanner/cluster-scanner.ts';
import { logError } from './log.ts';

const IDLE_TIMEOUT_MS = 60_000;

let scanner: ClusterScanner | null = null;
let idleTimer: ReturnType<typeof setTimeout> | null = null;

// Number of scans currently executing against the shared scanner. Idle
// shutdown is a no-op while this is > 0; teardown happens when it returns to 0.
let activeScans = 0;
// Set when the idle timer fires (or an idle shutdown is requested) while scans
// are in flight, so the last scan to finish performs the deferred teardown.
let shutdownPending = false;

/**
 * Get (or lazily create) a ready-to-use ClusterScanner.
 * Resets the idle shutdown timer on every call.
 */
export async function getScanner(): Promise<ClusterScanner> {
  resetIdleTimer();

  if (scanner) return scanner;

  // uiAutomation:false — the MCP server must never pick up ui-steps/*.json
  // sequences (even if a repo .env sets UI_STEPS_DIR) and drive the browser.
  scanner = new ClusterScanner(/* maxConcurrency */ 5, undefined, { uiAutomation: false });
  try {
    await scanner.initialize();
  } catch (err) {
    // Browser launch failure (missing Chromium, sandbox denial, OOM) surfaces
    // downstream as "All viewport scans failed" — log the real cause here.
    logError('scanner-manager Chromium launch failed', err);
    scanner = null;
    throw err;
  }
  return scanner;
}

/**
 * Run scan work against the shared scanner while holding the in-flight guard.
 * Guarantees the browser is not reaped by the idle timer mid-scan: the active
 * count is incremented before the work runs and decremented in a `finally`,
 * which also re-arms the idle timer and performs any deferred shutdown.
 */
export async function withScanner<T>(
  fn: (scanner: ClusterScanner) => Promise<T>,
): Promise<T> {
  const s = await getScanner();
  activeScans++;
  try {
    return await fn(s);
  } finally {
    activeScans--;
    if (activeScans === 0 && shutdownPending) {
      // The idle timer fired while we were scanning — honor it now.
      shutdownPending = false;
      await teardown();
    } else {
      // Keep the browser warm for rapid re-scans; restart the idle countdown.
      resetIdleTimer();
    }
  }
}

/**
 * Shut down the browser immediately. Safe to call multiple times.
 * Used for graceful process exit (SIGINT/SIGTERM), so it forces teardown even
 * if scans are somehow still in flight.
 */
export async function shutdownScanner(): Promise<void> {
  clearIdleTimer();
  shutdownPending = false;
  await teardown();
}

/** Actually close the browser and clear the singleton. */
async function teardown(): Promise<void> {
  if (scanner) {
    try {
      await scanner.cleanup();
    } catch (err) {
      // Don't let a teardown failure mask the singleton reset — log and proceed.
      logError('scanner-manager teardown failed', err);
    }
    scanner = null;
  }
}

/**
 * Idle-timer shutdown: only tears down when no scans are running. If a scan is
 * in flight, marks shutdown pending so the last scan to finish does the
 * teardown (instead of closing the browser out from under it).
 */
async function idleShutdown(): Promise<void> {
  if (activeScans > 0) {
    shutdownPending = true;
    return;
  }
  await teardown();
}

function resetIdleTimer(): void {
  clearIdleTimer();
  idleTimer = setTimeout(() => {
    void idleShutdown();
  }, IDLE_TIMEOUT_MS);
}

function clearIdleTimer(): void {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
}

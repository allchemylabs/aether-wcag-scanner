/**
 * SPA Stability Cascade
 * =====================
 *
 * Waits for a Single-Page App to "settle" before running axe on it.
 *
 * Layered strategy — each page tries these in order, stopping at the first
 * strategy that succeeds. The cascade exists because no single "ready"
 * signal works for every SPA:
 *
 *   Layer 1: domcontentloaded            (prerequisite; always tried first)
 *   Layer 2: Angular Testability API     (native framework signal; has deadlock guard)
 *   Layer 3: hashchange listener         (for hash-routed apps transitioning fragments)
 *   Layer 4: MutationObserver            (universal fallback — DOM stops changing)
 *   Layer 5: waitForSelector             (customer-controlled escape hatch per route)
 *   ∞      : hard timeout                (guarantees termination)
 *
 * CRITICAL: This module NEVER uses `networkidle`. `networkidle` is
 * unreliable on modern SPAs (WebSockets, analytics beacons, long-polling)
 * and is the root cause of hangs in Pa11y, Lighthouse CI, and custom
 * scripts. Enforcing its absence is the #1 differentiator of this scanner.
 *
 * See docs/plan-spa-angular-scanning.md for background.
 */

import type { Page } from 'playwright';
import type {
  SPAFramework,
  SPAStabilityStrategy,
  SPAStabilityConfig,
  SPAStabilityOverrides,
} from '../../types/spa-config';

// ----------------------------------------------------------------------------
// Framework-specific default timings
// ----------------------------------------------------------------------------

const DEFAULT_MUTATION_DEBOUNCE_MS: Record<SPAFramework, number> = {
  angular: 500,
  react: 750,
  vue: 750,
  generic: 1500,
};

const DEFAULT_ANGULAR_TESTABILITY_TIMEOUT_MS = 5000;
const DEFAULT_MAX_TIMEOUT_MS = 15000;
const DEFAULT_DOMCONTENTLOADED_TIMEOUT_MS = 10000;

// ----------------------------------------------------------------------------
// Resolved timing config (global + per-route overrides merged)
// ----------------------------------------------------------------------------

export interface ResolvedStabilityTimings {
  mutationDebounceMs: number;
  angularTestabilityTimeoutMs: number;
  maxTimeoutMs: number;
}

export function resolveStabilityTimings(
  framework: SPAFramework,
  global?: SPAStabilityConfig,
  override?: SPAStabilityOverrides,
): ResolvedStabilityTimings {
  return {
    mutationDebounceMs:
      override?.mutationDebounceMs ??
      global?.mutationDebounceMs ??
      DEFAULT_MUTATION_DEBOUNCE_MS[framework],
    angularTestabilityTimeoutMs:
      override?.angularTestabilityTimeoutMs ??
      global?.angularTestabilityTimeoutMs ??
      DEFAULT_ANGULAR_TESTABILITY_TIMEOUT_MS,
    maxTimeoutMs:
      override?.maxTimeoutMs ??
      global?.maxTimeoutMs ??
      DEFAULT_MAX_TIMEOUT_MS,
  };
}

// ----------------------------------------------------------------------------
// Public API
// ----------------------------------------------------------------------------

export interface WaitForSPAStableOptions {
  framework: SPAFramework;
  timings: ResolvedStabilityTimings;
  /** Optional per-route selector for Layer 5 */
  waitForSelector?: string;
  /** Current URL — used to detect hash routing for Layer 3 applicability */
  currentUrl: string;
}

export interface StabilityResult {
  strategy: SPAStabilityStrategy;
  durationMs: number;
}

/**
 * Run the stability cascade against `page`. Returns which strategy resolved
 * first and how long it took. Always terminates within `timings.maxTimeoutMs`
 * (plus Layer 1's domcontentloaded timeout).
 */
export async function waitForSPAStable(
  page: Page,
  opts: WaitForSPAStableOptions,
): Promise<StabilityResult> {
  const start = Date.now();

  // ---- Layer 1: domcontentloaded (prerequisite) ----
  try {
    await page.waitForLoadState('domcontentloaded', {
      timeout: DEFAULT_DOMCONTENTLOADED_TIMEOUT_MS,
    });
  } catch {
    // Already past DOMContentLoaded, or the page navigated again — fall through
  }

  // Layers 2-5 race against the hard timeout. Whichever wins first, wins.
  const deadline = start + opts.timings.maxTimeoutMs;

  // ---- Layer 2: Angular Testability API (with deadlock guard) ----
  if (opts.framework === 'angular') {
    const layer2 = await tryAngularTestability(
      page,
      opts.timings.angularTestabilityTimeoutMs,
    );
    if (layer2 === 'resolved') {
      return { strategy: 'angular-testability', durationMs: Date.now() - start };
    }
    if (layer2 === 'timeout') {
      // Deadlock guard fired — fall through to subsequent layers
      // (note which strategy ultimately wins; we don't early-return here)
    }
  }

  // ---- Layer 3: hashchange listener (only for hash-routed apps) ----
  // We only install this listener when the current URL contains a `#/` fragment,
  // because `hashchange` never fires on initial load and would otherwise block
  // forever on non-hash routes.
  const isHashRouted = /#\/?/.test(opts.currentUrl);

  // ---- Layer 4: MutationObserver quiet period ----
  // ---- Layer 5: waitForSelector (customer escape hatch) ----
  //
  // Layers 3-5 are raced against each other — whichever resolves first wins.
  // The hard timeout also races so we always terminate.

  const remaining = Math.max(1, deadline - Date.now());

  const racers: Promise<SPAStabilityStrategy>[] = [];

  if (isHashRouted) {
    racers.push(
      waitForHashChange(page, remaining).then(
        () => 'hashchange' as SPAStabilityStrategy,
      ),
    );
  }

  racers.push(
    waitForMutationQuiet(page, opts.timings.mutationDebounceMs, remaining).then(
      () => 'mutation-observer' as SPAStabilityStrategy,
    ),
  );

  if (opts.waitForSelector) {
    racers.push(
      page
        .waitForSelector(opts.waitForSelector, { timeout: remaining, state: 'visible' })
        .then(() => 'wait-for-selector' as SPAStabilityStrategy)
        .catch(() => 'hard-timeout' as SPAStabilityStrategy),
    );
  }

  // Always include a hard-timeout racer so we never wait longer than maxTimeoutMs
  racers.push(
    new Promise<SPAStabilityStrategy>(resolve =>
      setTimeout(() => resolve('hard-timeout'), remaining),
    ),
  );

  const winner = await Promise.race(racers);
  return { strategy: winner, durationMs: Date.now() - start };
}

// ----------------------------------------------------------------------------
// Layer 2: Angular Testability API
// ----------------------------------------------------------------------------
//
// Returns:
//   'resolved' — Angular reported stable
//   'timeout'  — deadlock guard fired (setInterval-in-NgZone case)
//   'absent'   — page has no Angular Testability (not an Angular app)
//
// Uses page.evaluate with an inline promise instead of `whenStable(cb)`
// callback style so the deadlock guard can reliably race against it.

async function tryAngularTestability(
  page: Page,
  timeoutMs: number,
): Promise<'resolved' | 'timeout' | 'absent'> {
  // First, sniff whether Angular Testability exists at all. If not, skip.
  let present = false;
  try {
    present = await page.evaluate(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      () => typeof (window as any).getAllAngularTestabilities === 'function',
    );
  } catch {
    return 'absent';
  }
  if (!present) return 'absent';

  // Race Angular's whenStable callback against a bounded timeout.
  //
  // The inner promise is inside the browser context, so we can't use
  // AbortController. Instead we install our own setTimeout inside the
  // evaluated function. The outer page.evaluate is itself wrapped in
  // Promise.race against a Node-side timeout to catch the truly-stuck case
  // where the browser's setTimeout also gets blocked by a Zone.js polyfill.
  const GUARD_PADDING_MS = 500;
  const browserResult = page.evaluate((browserTimeoutMs) => {
    return new Promise<'resolved' | 'timeout'>((resolve) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const testabilities: any[] = (window as any).getAllAngularTestabilities?.() ?? [];
      if (testabilities.length === 0) {
        resolve('resolved'); // nothing to wait on
        return;
      }

      let remaining = testabilities.length;
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        resolve('timeout');
      }, browserTimeoutMs);

      for (const t of testabilities) {
        try {
          t.whenStable(() => {
            remaining -= 1;
            if (remaining === 0 && !settled) {
              settled = true;
              clearTimeout(timer);
              resolve('resolved');
            }
          });
        } catch {
          // Testability instance threw — count it as resolved so we don't hang
          remaining -= 1;
          if (remaining === 0 && !settled) {
            settled = true;
            clearTimeout(timer);
            resolve('resolved');
          }
        }
      }
    });
  }, timeoutMs);

  const nodeGuard = new Promise<'timeout'>(resolve =>
    setTimeout(() => resolve('timeout'), timeoutMs + GUARD_PADDING_MS),
  );

  try {
    return (await Promise.race([browserResult, nodeGuard])) as
      | 'resolved'
      | 'timeout';
  } catch {
    return 'timeout';
  }
}

// ----------------------------------------------------------------------------
// Layer 3: hashchange listener
// ----------------------------------------------------------------------------
//
// Resolves when the window fires a `hashchange` event, capped at `timeoutMs`.
// Only meaningful when called after a navigation that is expected to transition
// between hash routes — the caller is responsible for gating this on hash-routed apps.

async function waitForHashChange(page: Page, timeoutMs: number): Promise<void> {
  try {
    await page.evaluate((browserTimeoutMs) => {
      return new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          window.removeEventListener('hashchange', onHash);
          resolve();
        }, browserTimeoutMs);
        function onHash() {
          clearTimeout(timer);
          window.removeEventListener('hashchange', onHash);
          resolve();
        }
        window.addEventListener('hashchange', onHash);
      });
    }, timeoutMs);
  } catch {
    // Context destroyed — page navigated, that's fine
  }
}

// ----------------------------------------------------------------------------
// Layer 4: MutationObserver quiet period
// ----------------------------------------------------------------------------
//
// Resolves once no DOM mutations have occurred for `debounceMs`, or when
// `maxWait` is reached. Universal fallback for any framework.
//
// Ported directly from ClusterScanner.waitForDomStable() so behaviour is
// consistent with the existing scanner.

async function waitForMutationQuiet(
  page: Page,
  debounceMs: number,
  maxWait: number,
): Promise<void> {
  try {
    await page.evaluate(
      ({ debounce, max }) => {
        return new Promise<void>((resolve) => {
          let timer: ReturnType<typeof setTimeout>;
          const target = document.body || document.documentElement;
          const observer = new MutationObserver(() => {
            clearTimeout(timer);
            timer = setTimeout(done, debounce);
          });
          function done() {
            observer.disconnect();
            resolve();
          }
          observer.observe(target, {
            childList: true,
            subtree: true,
            attributes: true,
            characterData: true,
          });
          timer = setTimeout(done, debounce);
          setTimeout(done, max);
        });
      },
      { debounce: debounceMs, max: maxWait },
    );
  } catch {
    // Context destroyed — page navigated, that's fine
  }
}

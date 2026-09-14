/**
 * SPA Framework Auto-Detection
 * ============================
 *
 * Detects which SPA framework (if any) is running on the current page by
 * probing for well-known global objects and DOM attributes.
 *
 * Used by Milestone 2 auto-discovery to select framework-specific stability
 * timings and route extraction heuristics.
 */

import type { Page } from 'playwright';
import type { SPAFramework } from '../../types/spa-config';

/**
 * Probe the page for framework-specific globals and return the detected
 * framework. Falls back to `'generic'` if no framework is identified.
 *
 * Detection order is intentional — Angular is checked first because its
 * Testability API is the most reliable signal, followed by React and Vue.
 */
export async function detectFramework(page: Page): Promise<SPAFramework> {
  try {
    return await page.evaluate(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const win = window as any;

      // Angular: Testability API (Ivy+) or legacy `ng` global (ViewEngine)
      if (
        typeof win.getAllAngularTestabilities === 'function' ||
        typeof win.ng !== 'undefined'
      ) {
        return 'angular' as const;
      }

      // React: DevTools global hook (injected by React 16+, present even
      // without the browser extension when React is on the page)
      if (typeof win.__REACT_DEVTOOLS_GLOBAL_HOOK__ !== 'undefined') {
        return 'react' as const;
      }

      // Vue: __VUE__ global (Vue 3) or data-v- scoped style attributes (Vue 2/3)
      if (
        typeof win.__VUE__ !== 'undefined' ||
        document.querySelector('[data-v-]') !== null
      ) {
        return 'vue' as const;
      }

      return 'generic' as const;
    });
  } catch {
    // Page context destroyed (navigation in progress) — safe fallback
    return 'generic';
  }
}

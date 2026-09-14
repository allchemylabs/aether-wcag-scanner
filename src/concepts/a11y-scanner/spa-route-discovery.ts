/**
 * SPA Route Auto-Discovery
 * ========================
 *
 * BFS-crawls a Single-Page App to discover client-side routes. Extracts
 * links from `<a href>`, `<a routerLink>`, and `[routerLink]` attributes,
 * navigates to each discovered route using client-side navigation, then
 * repeats the process until `maxRoutes` is reached or no new routes are
 * found.
 *
 * Key design decisions:
 *   - Client-side navigation between hops (preserves SPA state)
 *   - Calls waitForSPAStable() after each navigation
 *   - Skips external links (different origin)
 *   - Deduplicates by normalized path
 *   - Respects excludePatterns and maxRoutes
 *   - Detects hash routing vs pushState automatically
 */

import type { Page } from 'playwright';
import { waitForSPAStable, resolveStabilityTimings } from './spa-stability.ts';
import { isScannableUrl } from './url-guard.ts';
import type { SPAFramework } from '../../types/spa-config';

export interface DiscoveredRoute {
  path: string;
  discoveryMethod: 'crawled';
  linkText?: string;
}

export interface DiscoveryOptions {
  maxRoutes?: number;
  excludePatterns?: RegExp[];
  framework?: SPAFramework;
  /** Link CSS selectors to extract routes from. Default covers standard + Angular. */
  linkSelectors?: string[];
}

const DEFAULT_MAX_ROUTES = 50;
const DEFAULT_LINK_SELECTORS = ['a[href]', '[routerLink]'];

/**
 * BFS-crawl from the current page to discover client-side routes.
 * The page should already be at the entry URL when this is called.
 */
export async function discoverRoutes(
  page: Page,
  entryUrl: string,
  options: DiscoveryOptions = {},
): Promise<DiscoveredRoute[]> {
  const maxRoutes = options.maxRoutes ?? DEFAULT_MAX_ROUTES;
  const excludePatterns = options.excludePatterns ?? [];
  const framework = options.framework ?? 'generic';
  const linkSelectors = options.linkSelectors ?? DEFAULT_LINK_SELECTORS;

  const origin = new URL(entryUrl).origin;
  const visited = new Set<string>();
  const discovered: DiscoveredRoute[] = [];
  const queue: string[] = [];

  // Seed the queue with the entry page's path
  const entryPath = normalizePath(new URL(entryUrl).pathname + new URL(entryUrl).hash);
  visited.add(entryPath);

  // The entry page is itself a route to scan. Seed it into `discovered` so a
  // link-sparse entry (few/no in-app links, deep path, generic framework) still
  // yields at least one scannable route instead of routesScanned: 0.
  discovered.push({ path: entryPath, discoveryMethod: 'crawled' });

  // Extract links from current page
  const initialLinks = await extractLinks(page, linkSelectors, origin);
  for (const link of initialLinks) {
    const path = normalizePath(link.path);
    if (!visited.has(path) && !isExcluded(path, excludePatterns)) {
      queue.push(path);
      visited.add(path);
    }
  }

  // BFS
  while (queue.length > 0 && discovered.length < maxRoutes) {
    const path = queue.shift()!;

    // Navigate client-side. A pathname like `//evil.example/x` resolves to a
    // different origin via `new URL(path, origin)` — refuse to leave the entry
    // origin, and never hop to a metadata/link-local host.
    const targetUrl = new URL(path, origin).toString();
    if (new URL(targetUrl).origin !== origin || !isScannableUrl(targetUrl)) {
      continue;
    }
    try {
      await navigateAndWait(page, targetUrl, framework);
    } catch {
      // Navigation failed — skip this route, continue with next
      continue;
    }

    // Find the link text from the initial extraction if available
    const linkInfo = initialLinks.find(l => normalizePath(l.path) === path);
    discovered.push({
      path,
      discoveryMethod: 'crawled',
      linkText: linkInfo?.text,
    });

    if (discovered.length >= maxRoutes) break;

    // Extract more links from this page
    const newLinks = await extractLinks(page, linkSelectors, origin);
    for (const link of newLinks) {
      const normalized = normalizePath(link.path);
      if (!visited.has(normalized) && !isExcluded(normalized, excludePatterns)) {
        queue.push(normalized);
        visited.add(normalized);
      }
    }
  }

  return discovered;
}

// ---------------------------------------------------------------------------
// Link extraction
// ---------------------------------------------------------------------------

interface ExtractedLink {
  path: string;
  text?: string;
}

async function extractLinks(
  page: Page,
  selectors: string[],
  origin: string,
): Promise<ExtractedLink[]> {
  try {
    const links: ExtractedLink[] = await page.evaluate(
      ({ selectors: sels, origin: orig }) => {
        const results: Array<{ path: string; text?: string }> = [];
        const seen = new Set<string>();

        for (const selector of sels) {
          const elements = document.querySelectorAll(selector);
          for (const el of elements) {
            // Extract the href or routerLink value
            const href =
              el.getAttribute('href') ||
              el.getAttribute('routerLink') ||
              el.getAttribute('routerlink');
            if (!href) continue;

            // Skip javascript:, mailto:, tel: etc
            if (/^(javascript|mailto|tel|data):/i.test(href)) continue;

            // Resolve relative URLs
            let fullUrl: string;
            try {
              fullUrl = new URL(href, window.location.href).toString();
            } catch {
              continue;
            }

            // Skip external links — compare origins exactly; a prefix test
            // lets `https://app.example.com.evil.net` through.
            const parsed = new URL(fullUrl);
            if (parsed.origin !== orig) continue;

            const path = parsed.pathname + parsed.hash;

            if (!seen.has(path)) {
              seen.add(path);
              results.push({
                path,
                text: (el.textContent || '').trim().slice(0, 100) || undefined,
              });
            }
          }
        }
        return results;
      },
      { selectors, origin },
    );
    return links;
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Navigation helper
// ---------------------------------------------------------------------------

async function navigateAndWait(
  page: Page,
  targetUrl: string,
  framework: SPAFramework,
): Promise<void> {
  const currentUrl = page.url();
  if (currentUrl === targetUrl) return;

  // Client-side navigation
  await page.evaluate((url) => {
    if (url.includes('#')) {
      window.location.href = url;
    } else {
      try {
        const parsed = new URL(url, window.location.href);
        window.history.pushState({}, '', parsed.pathname + parsed.search);
        window.dispatchEvent(new PopStateEvent('popstate'));
      } catch {
        window.location.href = url;
      }
    }
  }, targetUrl);

  // Wait for stability
  const timings = resolveStabilityTimings(framework);
  await waitForSPAStable(page, {
    framework,
    timings,
    currentUrl: targetUrl,
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function normalizePath(path: string): string {
  // Remove trailing slash for consistency (except root "/")
  const trimmed = path.length > 1 ? path.replace(/\/$/, '') : path;
  return trimmed || '/';
}

function isExcluded(path: string, patterns: RegExp[]): boolean {
  return patterns.some(p => p.test(path));
}

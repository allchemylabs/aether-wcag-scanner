/**
 * Live-DOM geometry + hidden-state capture (SME Issue 5) — Tier 1.
 *
 * axe reports a violation's selector and html but NONE of the runtime facts you
 * need to tell a genuine defect from an off-tree/zero-area tracking pixel: where
 * the element actually sits, whether an ancestor hides it, whether it's a 1px
 * beacon at the end of <body>. This module reads that straight off the live
 * Playwright page in a single `page.evaluate` and attaches it to `node.layout`.
 *
 * It powers tracking-pixel SUPPRESSION in `finding.ts` (a `frame-title` /
 * `image-alt` violation on a zero-area analytics beacon is noise, not a defect a
 * developer should chase). Small metadata (numbers/booleans) — so unlike the
 * heavy screenshot images it flows to BOTH the CLI report and the MCP plugin.
 *
 * Everything is best-effort: a bad selector, a detached node, or a cross-origin
 * frame degrades to "no layout for that node" and NEVER throws. Desktop-only,
 * captured once (mergeViolations keeps the first-seen desktop node).
 */

import type { Page } from 'playwright';
import type { NodeLayout, Violation, ViolationNode } from '../../types/a11y';

/**
 * Cap the number of elements we probe per page so a pathological page (thousands
 * of nodes) can't blow up the single evaluate. 200 covers every real report.
 */
const MAX_LAYOUT_NODES = 200;

/** Resolve an axe target (array or string) to its element selector (index 0). */
function selectorOf(target: string | string[] | undefined): string | undefined {
  const sel = Array.isArray(target) ? target[0] : target;
  return sel || undefined;
}

/**
 * Compute geometry + hidden-state + tracking-pixel flags for a batch of
 * selectors in one browser round-trip. Returns a parallel array (same length /
 * order as `selectors`); a null entry means the selector didn't resolve.
 *
 * The evaluate body is self-contained (runs in the page, no closure over Node
 * types) and swallows per-element errors so one bad selector never voids the
 * batch.
 */
async function computeLayouts(
  page: Page,
  selectors: string[],
): Promise<(NodeLayout | null)[]> {
  return page.evaluate((sels: string[]) => {
    // Regex for known beacon/analytics endpoints — a named 1x1 that fails
    // frame-title/image-alt is near-certainly a tracker, not page content.
    // NOTE: everything below is inlined (no nested named functions). Under
    // tsx/esbuild `keepNames`, a `function foo(){}` inside page.evaluate is
    // serialized with a `__name(foo,"foo")` call that is undefined in the page
    // context (ReferenceError → whole batch skipped). Anonymous inline logic
    // avoids the helper entirely.
    const BEACON = /beacon|pixel|\/p\.gif|\/collect|analytics|doubleclick|googletagmanager|facebook\.com\/tr|scorecardresearch|quantserve|track(?:ing)?/i;

    return sels.map((sel): NodeLayout | null => {
      try {
        const el = document.querySelector(sel);
        if (!el) return null;

        const rect = el.getBoundingClientRect();
        const cs = window.getComputedStyle(el);
        const boundingBox = {
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
        };
        const opacity = Number.parseFloat(cs.opacity);

        // hiddenByAncestor — walk up for aria-hidden / inert / display:none /
        // visibility:hidden on any ancestor below <html>.
        let hiddenByAncestor = false;
        for (let cur = el.parentElement; cur && cur.tagName !== 'HTML'; cur = cur.parentElement) {
          if (cur.getAttribute('aria-hidden') === 'true' || cur.hasAttribute('inert')) {
            hiddenByAncestor = true;
            break;
          }
          const acs = window.getComputedStyle(cur);
          if (acs.display === 'none' || acs.visibility === 'hidden') {
            hiddenByAncestor = true;
            break;
          }
        }

        // atEndOfBody — is the element inside one of the last 3 top-level
        // <body> children (where injected beacons live)?
        let end = false;
        const body = document.body;
        if (body) {
          let top: Element = el;
          while (top.parentElement && top.parentElement !== body) {
            top = top.parentElement;
          }
          if (top.parentElement === body) {
            const kids = Array.from(body.children);
            const idx = kids.indexOf(top);
            end = idx >= 0 && idx >= kids.length - 3;
          }
        }

        // Tracking pixel: near-zero rendered area, OR a beacon/analytics src on
        // an <img>/<iframe>. Either signal alone is weak; finding.ts only
        // suppresses when this pairs with hiddenByAncestor / atEndOfBody.
        const zeroArea = rect.width <= 2 && rect.height <= 2;
        const src =
          el.getAttribute('src') ||
          el.getAttribute('data-src') ||
          '';
        const beaconSrc = !!src && BEACON.test(src);
        const isTrackingPixel = zeroArea || beaconSrc;

        return {
          boundingBox,
          display: cs.display,
          visibility: cs.visibility,
          opacity: Number.isFinite(opacity) ? opacity : undefined,
          hiddenByAncestor,
          atEndOfBody: end,
          isTrackingPixel,
        };
      } catch {
        return null;
      }
    });
  }, selectors);
}

/**
 * Attach `node.layout` to the first node of each violation (the node the fix
 * path consumes and the one mergeViolations keeps). Mutates in place; bounded by
 * MAX_LAYOUT_NODES; best-effort — a failed evaluate leaves every layout unset
 * rather than throwing. Call desktop-only, after runAxe, before page.close().
 */
export async function captureNodeLayouts(page: Page, violations: Violation[]): Promise<void> {
  // Build a flat batch of (node → selector) pairs, capped for safety.
  const targets: { nodeRef: ViolationNode; sel: string }[] = [];

  for (const v of violations) {
    for (const node of v.nodes ?? []) {
      const sel = selectorOf(node.target);
      if (!sel) continue;
      targets.push({ nodeRef: node, sel });
      if (targets.length >= MAX_LAYOUT_NODES) break;
    }
    if (targets.length >= MAX_LAYOUT_NODES) break;
  }

  if (targets.length === 0) return;

  try {
    const layouts = await computeLayouts(page, targets.map(t => t.sel));
    layouts.forEach((layout, i) => {
      if (layout) targets[i].nodeRef.layout = layout;
    });
  } catch (err) {
    // One failed evaluate must never fail the scan — Tier 1 is enrichment.
    process.stderr.write(`[node-layout] capture skipped: ${(err as Error).message}\n`);
  }
}

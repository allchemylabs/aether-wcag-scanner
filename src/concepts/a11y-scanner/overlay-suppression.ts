/**
 * Consent/overlay suppression for element screenshots (CLI/pipeline reports).
 *
 * Consent platforms (OneTrust/Cookiebot/Osano) paint a full-viewport scrim +
 * modal on load. Left in place, the crop and context screenshots in
 * `screenshot.ts` capture that gray backdrop instead of the violating element.
 *
 * This module temporarily hides occluding overlays *for the shot only* — the
 * scrim/dialog is set to `visibility:hidden !important` right before capture and
 * restored right after. `visibility:hidden` (NOT `display:none`) means no reflow,
 * so the crop `clip` box — measured while the overlay was present — stays valid.
 *
 * The axe scan is unaffected: screenshots run after axe, so suppression never
 * changes reported violations. MCP never captures screenshots, so this never
 * runs for the plugin.
 */

import type { Page } from 'playwright';

/** Curated, high-signal consent-container selectors (kept generic). */
const CONSENT_SELECTOR = [
  '#onetrust-banner-sdk',
  '#CybotCookiebotDialog',
  '.cc-window',
  '.osano-cm-window',
  '[id*="cookie" i]',
  '[class*="consent" i]',
  '[id*="consent" i]',
].join(',');

/** Elements that carry an explicit modal/dialog role. */
const DIALOG_SELECTOR = '[aria-modal="true"],[role="dialog"],dialog[open]';

/** Inputs to the pure overlay classifier. */
export interface OverlayInput {
  /** CSS `position` of the element. */
  position: string;
  /** Resolved `z-index` (0 when `auto`/unset). */
  zIndex: number;
  /** Element bounding rect in viewport coordinates. */
  rect: { x: number; y: number; width: number; height: number };
  /** Viewport size. */
  viewport: { width: number; height: number };
  /** Alpha channel of the background color (0 = transparent, 1 = opaque). */
  bgAlpha: number;
  /** Matches `[aria-modal="true"]` / `[role="dialog"]` / `dialog[open]`. */
  isDialogRole: boolean;
  /** Matches a curated consent-container selector. */
  matchesConsentSelector: boolean;
  /** The element is the target, an ancestor of it, or a descendant of it. */
  relatedToTarget: boolean;
}

/**
 * Decide whether an element is an occluding overlay we should hide for the shot.
 *
 * Pure + exported for unit tests. The in-browser `hideOccludingOverlays`
 * `evaluate` applies these SAME thresholds inline (keep the two in sync).
 *
 * Hide when the element is NOT related to the target AND either:
 *  1. **Scrim:** positioned (`fixed|absolute`), covers ≥90% of the viewport from
 *     ~origin, AND (`zIndex ≥ 1000` OR semi-transparent bg `0.05 < alpha < 0.98`
 *     OR it matches a consent selector).
 *  2. **Modal/consent:** it has a dialog role OR matches a consent selector.
 */
export function classifyOverlay(input: OverlayInput): boolean {
  // Target's own subtree is never hidden — an overlay containing the target
  // would hide it; an element inside the target is part of what we're shooting.
  if (input.relatedToTarget) return false;

  const { position, zIndex, rect, viewport, bgAlpha } = input;

  const positioned = position === 'fixed' || position === 'absolute';
  const coversViewport =
    rect.width >= 0.9 * viewport.width &&
    rect.height >= 0.9 * viewport.height &&
    rect.x <= 0.1 * viewport.width &&
    rect.y <= 0.1 * viewport.height;
  const semiTransparent = bgAlpha > 0.05 && bgAlpha < 0.98;

  const isScrim =
    positioned &&
    coversViewport &&
    (zIndex >= 1000 || semiTransparent || input.matchesConsentSelector);

  const isModalConsent = input.isDialogRole || input.matchesConsentSelector;

  return isScrim || isModalConsent;
}

/**
 * Hide occluding overlays (scrim + modal/consent containers) so the next
 * screenshot shows the real element, not a gray backdrop. Each hidden element is
 * marked with `data-aether-overlay-hidden` (+ its prior inline `visibility` so
 * restore is exact). Returns the number of elements hidden.
 *
 * Best-effort: any failure resolves to 0 (the caller `.catch(() => 0)`s anyway).
 */
export async function hideOccludingOverlays(page: Page, targetSel: string): Promise<number> {
  return page.evaluate(
    ({ targetSel, consentSelector, dialogSelector }) => {
      const target = document.querySelector(targetSel);

      // Inline mirror of classifyOverlay() thresholds — keep in sync.
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      let hidden = 0;

      for (const el of Array.from(document.querySelectorAll('body *'))) {
        const html = el as HTMLElement;

        // Target exclusion: skip the target, its ancestors, and its descendants.
        const relatedToTarget = !!target && (
          el === target || el.contains(target) || target.contains(el)
        );
        if (relatedToTarget) continue;

        const cs = window.getComputedStyle(html);
        const position = cs.position;
        const positioned = position === 'fixed' || position === 'absolute';

        const isDialogRole = html.matches(dialogSelector);
        const matchesConsent = html.matches(consentSelector);

        // Cheap early-out: only positioned elements can be scrims; dialogs /
        // consent containers are handled regardless of position.
        if (!positioned && !isDialogRole && !matchesConsent) continue;

        const rect = html.getBoundingClientRect();

        const zRaw = parseInt(cs.zIndex, 10);
        const zIndex = Number.isNaN(zRaw) ? 0 : zRaw;

        // Parse background alpha from computed rgba()/rgb().
        let bgAlpha = 1;
        const bg = cs.backgroundColor;
        if (bg === 'transparent') {
          bgAlpha = 0;
        } else {
          const m = bg.match(/rgba?\(([^)]+)\)/);
          if (m) {
            const parts = m[1].split(',').map((p) => p.trim());
            bgAlpha = parts.length >= 4 ? parseFloat(parts[3]) : 1;
          }
        }

        const coversViewport =
          rect.width >= 0.9 * vw &&
          rect.height >= 0.9 * vh &&
          rect.x <= 0.1 * vw &&
          rect.y <= 0.1 * vh;
        const semiTransparent = bgAlpha > 0.05 && bgAlpha < 0.98;

        const isScrim =
          positioned &&
          coversViewport &&
          (zIndex >= 1000 || semiTransparent || matchesConsent);
        const isModalConsent = isDialogRole || matchesConsent;

        if (!(isScrim || isModalConsent)) continue;

        // Hide with no reflow; remember prior inline visibility for restore.
        html.setAttribute('data-aether-prev-visibility', html.style.visibility);
        html.setAttribute('data-aether-overlay-hidden', '1');
        html.style.setProperty('visibility', 'hidden', 'important');
        hidden++;
      }

      return hidden;
    },
    { targetSel, consentSelector: CONSENT_SELECTOR, dialogSelector: DIALOG_SELECTOR },
  );
}

/**
 * Restore every element hidden by `hideOccludingOverlays`, returning its prior
 * inline `visibility` and clearing the markers. Best-effort; never throws.
 */
export async function restoreHiddenOverlays(page: Page): Promise<void> {
  await page.evaluate(() => {
    for (const el of Array.from(document.querySelectorAll('[data-aether-overlay-hidden]'))) {
      const html = el as HTMLElement;
      const prev = html.getAttribute('data-aether-prev-visibility') ?? '';
      if (prev) {
        html.style.visibility = prev;
      } else {
        html.style.removeProperty('visibility');
      }
      html.removeAttribute('data-aether-overlay-hidden');
      html.removeAttribute('data-aether-prev-visibility');
    }
  });
}

/**
 * Element screenshot capture (SME Issue 1) — CLI/pipeline report only.
 *
 * For a violating element we capture two shots so a reviewer can see exactly
 * what's in violation without a browser devtools extension:
 *
 *   - **crop:**    a tight, padded crop of the element itself ("what's broken?").
 *   - **context:** the element highlighted in place on the full viewport
 *                  ("where does it sit?").
 *
 * Everything is best-effort: any failure (hidden/detached element, timeout,
 * unqueryable selector, sharp/WebP unavailable) degrades gracefully and NEVER
 * throws — warnings go to stderr only so the MCP stdout stays JSON-RPC clean.
 *
 * Images are written through a `ScreenshotSink` (never `fs` directly), which is
 * the Phase-1→Phase-2 swap point (local disk → GCS). Playwright emits PNG
 * natively; we transcode to WebP via `sharp` when available and fall back to
 * PNG otherwise.
 */

import type { Page } from 'playwright';
import type { ArtifactVersions, Violation } from '../../types/a11y';
import type { ScreenshotSink, ShotFormat, ShotMeta, ShotRef } from './screenshot-sink.ts';
import { hideOccludingOverlays, restoreHiddenOverlays } from './overlay-suppression.ts';

/** Base identity for a violation's shots (kind/format/box filled per shot). */
export type ShotMetaBase = Omit<ShotMeta, 'kind' | 'format' | 'boundingBox'>;

/**
 * Per-scan screenshot options threaded into the scanners. The `sink` is passed
 * in (the scanner never touches `fs`), and `budget` is shared/mutable so a whole
 * run honors `--max-screenshots`.
 */
export interface ScreenshotScanOptions {
  sink: ScreenshotSink;
  budget: { taken: number; max: number };
  timeoutMs: number;
  format: ShotFormat;
  scanId?: string;
  url?: string;
  versions?: ArtifactVersions;
  /** Route-safe filename prefix (SPA) to avoid cross-route collisions. */
  namePrefix?: string;
  /** Suppress occluding consent/overlay scrims for the shot (default ON). */
  suppressOverlays?: boolean;
}

export interface ScreenshotCaptureOptions {
  /** Deterministic filename stem, e.g. `image-alt-001` (route-prefixed for SPA). */
  baseName: string;
  /** Per-shot timeout in ms. */
  timeoutMs: number;
  /** Preferred format; `webp` tries sharp and falls back to `png`. */
  format: ShotFormat;
  /** Shared, mutable budget so a run never exceeds `--max-screenshots`. */
  budget: { taken: number; max: number };
  /** Padding grown around the element for the crop (px). */
  padding?: number;
  /** Suppress occluding consent/overlay scrims for the shot (default ON). */
  suppressOverlays?: boolean;
}

export interface CapturedShots {
  crop?: ShotRef;
  context?: ShotRef;
  /** Caption explaining a skipped/partial capture (rendered by the reporter). */
  note?: string;
}

/**
 * Tags that never render a box we can screenshot. A violation on one of these
 * (e.g. `meta-viewport`, `document-title`, `html-has-lang`) gets a caption
 * instead of a silent blank — there is genuinely nothing visual to show.
 */
const NON_RENDERED_TAGS = new Set([
  'meta',
  'title',
  'head',
  'base',
  'link',
  'script',
  'style',
  'param',
  'source',
  'track',
]);

/** Sanitize an axe rule id (or route name) to a filesystem-safe token. */
export function sanitizeName(raw: string): string {
  return raw.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'x';
}

/**
 * Merge/dedup key for a violation's first node — MUST mirror
 * `ClusterScanner.nodeKey()` so the shared `captured` set aligns with
 * `mergeViolations()` first-seen semantics.
 */
function nodeKey(ruleId: string, node: { target?: string | string[]; html?: string }): string {
  const target = Array.isArray(node.target) ? node.target.join(',') : String(node.target ?? '');
  return `${ruleId}::${target}::${node.html ?? ''}`;
}

/**
 * Capture crop+context shots for the first node of each violation at the given
 * viewport, mutating `node.screenshot` in place. Best-effort, bounded by the
 * shared budget; never throws. Shared by both scanners.
 *
 * Runs at every viewport (desktop → tablet → mobile). The shared `captured` set
 * (keyed like `mergeViolations()`) skips any node already shot at an earlier
 * viewport, so each violation is captured exactly once — at the first viewport
 * it appears in. This gives responsive/mobile-only violations a real shot from
 * where they actually render, instead of a silent blank.
 */
export async function captureViolationScreenshots(
  page: Page,
  violations: Violation[],
  opts: ScreenshotScanOptions,
  viewport: 'desktop' | 'tablet' | 'mobile',
  captured: Set<string>,
): Promise<void> {
  const perRule = new Map<string, number>();
  for (const v of violations) {
    if (opts.budget.taken >= opts.budget.max) {
      process.stderr.write(
        `[screenshot] max (${opts.budget.max}) reached; skipping remaining violations\n`,
      );
      break;
    }
    const node = v.nodes?.[0];
    if (!node) continue;

    // Skip if this exact node was already captured at an earlier viewport.
    const key = nodeKey(v.id, node);
    if (captured.has(key)) continue;
    captured.add(key);

    const n = (perRule.get(v.id) ?? 0) + 1;
    perRule.set(v.id, n);
    const prefix = opts.namePrefix ? `${sanitizeName(opts.namePrefix)}-` : '';
    const baseName = `${prefix}${viewport}-${sanitizeName(v.id)}-${String(n).padStart(3, '0')}`;

    const metaBase: ShotMetaBase = {
      findingId: null,
      axeRule: v.id,
      wcagCriteria: [],
      elementTarget: Array.isArray(node.target) ? node.target.join(' ') : String(node.target ?? ''),
      viewport,
      scanId: opts.scanId,
      url: opts.url,
      capturedAt: new Date().toISOString(),
      versions: opts.versions,
    };

    const shots = await captureViolationShots(page, node.target, metaBase, opts.sink, {
      baseName,
      timeoutMs: opts.timeoutMs,
      format: opts.format,
      budget: opts.budget,
      suppressOverlays: opts.suppressOverlays,
    });

    if (shots.crop || shots.context || shots.note) {
      node.screenshot = {
        ...(shots.crop && { crop: shots.crop.path }),
        ...(shots.context && { context: shots.context.path }),
        ...(shots.note && { note: shots.note }),
        boundingBox: shots.crop?.boundingBox ?? shots.context?.boundingBox,
        viewport,
      };
    }
  }
}

/**
 * Transcode a Playwright PNG buffer to the requested format. WebP via `sharp`
 * (optionally downscaled); falls back to the original PNG when sharp/WebP is
 * unavailable. Returns the buffer + the format actually produced.
 */
async function transcode(
  png: Buffer,
  format: ShotFormat,
  opts: { quality: number; maxWidth?: number },
): Promise<{ buffer: Buffer; format: ShotFormat }> {
  if (format !== 'webp') return { buffer: png, format: 'png' };
  try {
    const sharpMod = await import('sharp');
    const sharp = sharpMod.default;
    let pipeline = sharp(png);
    if (opts.maxWidth) {
      pipeline = pipeline.resize({ width: opts.maxWidth, withoutEnlargement: true });
    }
    const buffer = await pipeline.webp({ quality: opts.quality }).toBuffer();
    return { buffer, format: 'webp' };
  } catch {
    // sharp not installed / native binary missing / WebP unsupported → PNG.
    return { buffer: png, format: 'png' };
  }
}

/**
 * Capture the crop + context shots for one violating element. Each shot is
 * independent: a failure in one never aborts the other, and the whole function
 * never throws. Respects the shared `budget` counter.
 */
export async function captureViolationShots(
  page: Page,
  target: string | string[] | undefined,
  metaBase: ShotMetaBase,
  sink: ScreenshotSink,
  opts: ScreenshotCaptureOptions,
): Promise<CapturedShots> {
  const out: CapturedShots = {};
  if (opts.budget.taken >= opts.budget.max) return out;

  // Mirror axe.ts:39 — axe targets are arrays; the element selector is [0].
  const sel = Array.isArray(target) ? target[0] : target;
  if (!sel) return out;

  try {
    const loc = page.locator(sel).first();

    // Non-rendered metadata elements (meta/title/link/…) have no box to shoot —
    // caption it rather than emitting a silent blank.
    const tag = await loc.evaluate((el: Element) => el.tagName.toLowerCase()).catch(() => '');
    if (NON_RENDERED_TAGS.has(tag)) {
      out.note = 'No visual preview — applies to document metadata (not a rendered element).';
      return out;
    }

    await loc.scrollIntoViewIfNeeded({ timeout: opts.timeoutMs }).catch(() => {});

    // Not visible at capture time (e.g. visibility:hidden, off-screen, or
    // collapsed behind an overlay) — nothing meaningful to shoot.
    const visible = await loc.isVisible().catch(() => false);
    if (!visible) {
      out.note = 'Element not visible at capture time (hidden, off-screen, or behind an overlay).';
      return out;
    }
    // Zero-area / 1px tracking pixel — nothing meaningful to show.
    const box = await loc.boundingBox().catch(() => null);
    if (!box || box.width < 2 || box.height < 2) {
      out.note = 'Not previewable — element has no visible area (e.g. tracking pixel).';
      return out;
    }

    const viewport = page.viewportSize() ?? { width: 1920, height: 1080 };
    const boundingBox = { x: box.x, y: box.y, width: box.width, height: box.height };

    // A crop of a page-spanning element (html/body, or a box covering ~the whole
    // viewport) is byte-for-eye identical to the full-page context shot. Skip the
    // redundant crop and keep a single full-page shot with an explanatory caption.
    const viewportArea = viewport.width * viewport.height;
    const boxArea = Math.min(box.width, viewport.width) * Math.min(box.height, viewport.height);
    const pageSpanning = tag === 'html' || tag === 'body' || boxArea >= 0.9 * viewportArea;

    // Suppress occluding consent/overlay scrims so the shots show the real
    // element, not a gray backdrop. Done AFTER the box is measured (geometry must
    // reflect the overlay-present layout) and restored in `finally`. Uses
    // `visibility:hidden` — no reflow — so the crop `clip` box stays valid.
    let hidden = 0;
    if (opts.suppressOverlays !== false) {
      hidden = await hideOccludingOverlays(page, sel).catch(() => 0);
    }

    try {
      // ---- Crop: padded element box, clamped to the viewport ----
      if (!pageSpanning && opts.budget.taken < opts.budget.max) {
        try {
          const pad = opts.padding ?? 10;
          const x = Math.max(0, box.x - pad);
          const y = Math.max(0, box.y - pad);
          const clip = {
            x,
            y,
            width: Math.min(box.width + pad * 2, viewport.width - x),
            height: Math.min(box.height + pad * 2, viewport.height - y),
          };
          if (clip.width >= 2 && clip.height >= 2) {
            const png = await page.screenshot({ clip, timeout: opts.timeoutMs, animations: 'disabled' });
            const { buffer, format } = await transcode(Buffer.from(png), opts.format, { quality: 80 });
            out.crop = await sink.put({
              kind: 'crop',
              buffer,
              format,
              baseName: `${opts.baseName}-crop`,
              meta: { ...metaBase, kind: 'crop', format, boundingBox },
            });
            opts.budget.taken++;
          }
        } catch (err) {
          process.stderr.write(`[screenshot] crop failed for ${sel}: ${(err as Error).message}\n`);
        }
      }

      // ---- Context: highlight the element in place, full-viewport shot ----
      if (opts.budget.taken < opts.budget.max) {
        let reverted = false;
        try {
          // Inject a temporary highlight (outline + light fill), remember prior inline styles.
          await loc.evaluate((el: Element) => {
            const s = (el as HTMLElement).style;
            (el as HTMLElement).dataset.aetherPrevOutline = s.outline;
            (el as HTMLElement).dataset.aetherPrevBox = s.boxShadow;
            (el as HTMLElement).dataset.aetherPrevBg = s.backgroundColor;
            s.outline = '3px solid #ef4444';
            s.boxShadow = '0 0 0 3px rgba(239,68,68,0.35)';
            s.backgroundColor = 'rgba(239,68,68,0.12)';
          });

          const png = await page.screenshot({ timeout: opts.timeoutMs, animations: 'disabled' });
          // Context is lower priority / larger → downscale + slightly lower quality.
          const { buffer, format } = await transcode(Buffer.from(png), opts.format, {
            quality: 70,
            maxWidth: 1280,
          });
          out.context = await sink.put({
            kind: 'context',
            buffer,
            format,
            baseName: `${opts.baseName}-context`,
            meta: { ...metaBase, kind: 'context', format, boundingBox },
          });
          opts.budget.taken++;

          // Revert the injected style.
          await loc.evaluate((el: Element) => {
            const s = (el as HTMLElement).style;
            const d = (el as HTMLElement).dataset;
            s.outline = d.aetherPrevOutline ?? '';
            s.boxShadow = d.aetherPrevBox ?? '';
            s.backgroundColor = d.aetherPrevBg ?? '';
            delete d.aetherPrevOutline;
            delete d.aetherPrevBox;
            delete d.aetherPrevBg;
          });
          reverted = true;
        } catch (err) {
          process.stderr.write(`[screenshot] context failed for ${sel}: ${(err as Error).message}\n`);
          if (!reverted) {
            // Best-effort revert so we don't leave the page visually mutated.
            await loc
              .evaluate((el: Element) => {
                const s = (el as HTMLElement).style;
                const d = (el as HTMLElement).dataset;
                s.outline = d.aetherPrevOutline ?? '';
                s.boxShadow = d.aetherPrevBox ?? '';
                s.backgroundColor = d.aetherPrevBg ?? '';
              })
              .catch(() => {});
          }
        }
      }
    } finally {
      if (hidden) await restoreHiddenOverlays(page).catch(() => {});
    }

    // Caption the single full-page shot so the reviewer knows why there's no
    // tighter crop for a page-level (html/body/full-viewport) violation.
    if (pageSpanning && (out.context || out.crop)) {
      out.note = 'Page-level issue — the whole document is shown (no tighter crop applies).';
    }
  } catch (err) {
    // Non-queryable / frame selector / detached — skip silently (stderr note).
    process.stderr.write(`[screenshot] capture skipped for ${sel}: ${(err as Error).message}\n`);
  }

  return out;
}

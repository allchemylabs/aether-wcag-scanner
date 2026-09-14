/**
 * Screenshot storage sink — the swap point between local (Phase 1) and cloud
 * (Phase 2) storage for violation screenshots.
 *
 * Everything upstream (the capture module + the scanners) only ever sees the
 * `ScreenshotSink` interface, so the scanner never touches `fs` or knows whether
 * an image lands on local disk or in a GCS bucket. Phase 2 adds a
 * `GcsScreenshotSink` behind the same interface — no scanner/reporter change.
 *
 * Each stored image is accompanied by a sidecar `<name>.json` carrying its
 * `ShotMeta` (annotation-ready identity: stable keys, bounding box, DOM target,
 * viewport, rule/SC, versions). The sidecar is exactly what a Phase-2 GCS
 * uploader / SME annotation ingester reads, and it reuses the same identity keys
 * (`findingId`, `versions`) the `/feedback` loop already echoes.
 */

import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ArtifactVersions } from '../../types/a11y';

/** Which of the two shots this is. */
export type ShotKind = 'crop' | 'context';

/** Encoded image format actually written (WebP when sharp is available). */
export type ShotFormat = 'webp' | 'png';

/**
 * Annotation-ready identity attached to every stored image + its sidecar.
 *
 * Deliberately keyed on the same identity the fix/feedback loop uses
 * (`findingId`, `versions`) so a Phase-2 annotation binds to the same Grounded
 * Artifact. At capture time `findingId` may be null (findings are collapsed
 * later in `buildFindings()`); `axeRule` + `elementTarget` + `scanId`
 * deterministically map an image back to its Finding for reconciliation.
 */
export interface ShotMeta {
  /** Stable finding id, back-filled when findings are built (null at capture). */
  findingId: string | null;
  axeRule: string;
  wcagCriteria: string[];
  /** The axe CSS/XPath selector for the offending element. */
  elementTarget: string;
  boundingBox?: { x: number; y: number; width: number; height: number };
  viewport: 'desktop' | 'tablet' | 'mobile';
  kind: ShotKind;
  format: ShotFormat;
  scanId?: string;
  url?: string;
  capturedAt: string;
  versions?: ArtifactVersions;
}

/** Reference returned by a sink after storing one image. */
export interface ShotRef {
  /** Relative report path (Phase 1) or `gs://…` URI (Phase 2). */
  path: string;
  boundingBox?: { x: number; y: number; width: number; height: number };
}

/** Item handed to a sink for storage. */
export interface ScreenshotSinkItem {
  kind: ShotKind;
  buffer: Buffer;
  format: ShotFormat;
  meta: ShotMeta;
  /** Deterministic base filename (without extension), e.g. `image-alt-001-crop`. */
  baseName: string;
}

/** Storage abstraction — local disk (Phase 1) or GCS bucket (Phase 2). */
export interface ScreenshotSink {
  /** Store one image (+ sidecar) and return a reference. */
  put(item: ScreenshotSinkItem): Promise<ShotRef>;
  /** Prepare storage for a fresh run (Phase 1: wipe + recreate the directory). */
  reset(): Promise<void>;
}

/**
 * Phase-1 sink: writes images + `<name>.json` sidecars under
 * `<outputDir>/<subdir>/`. `reset()` wipes + recreates the directory so a
 * re-scan never leaves orphaned images from now-fixed violations.
 */
export class LocalFileSink implements ScreenshotSink {
  private readonly dir: string;
  private ready = false;

  /**
   * @param outputDir  the report output directory.
   * @param subdir     screenshots subdirectory name (relative to the report).
   */
  constructor(
    private readonly outputDir: string,
    private readonly subdir: string = 'screenshots',
  ) {
    this.dir = join(outputDir, subdir);
  }

  async reset(): Promise<void> {
    await rm(this.dir, { recursive: true, force: true });
    await mkdir(this.dir, { recursive: true });
    this.ready = true;
  }

  async put(item: ScreenshotSinkItem): Promise<ShotRef> {
    if (!this.ready) {
      await mkdir(this.dir, { recursive: true });
      this.ready = true;
    }

    const fileName = `${item.baseName}.${item.format}`;
    await writeFile(join(this.dir, fileName), item.buffer);

    // Sidecar: self-describing metadata on disk (Phase-2 ingestion reads this).
    await writeFile(
      join(this.dir, `${item.baseName}.json`),
      JSON.stringify(item.meta, null, 2),
    );

    return {
      // Relative to the report (report.html / report.json live in outputDir).
      path: `${this.subdir}/${fileName}`,
      boundingBox: item.meta.boundingBox,
    };
  }

  /** Absolute path of the screenshots directory (for reading files back to inline). */
  get directory(): string {
    return this.dir;
  }
}

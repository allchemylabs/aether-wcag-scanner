import { Writable } from 'stream';
import type { PageScanResult } from '../../types/a11y';

/**
 * NDJSON Stream Output
 * Outputs accessibility scan results as newline-delimited JSON
 * Enables real-time processing by insight engines and data pipelines
 */

export interface NDJSONRecord {
  type: 'discovery' | 'scan' | 'complete' | 'error';
  timestamp: string;
  data: any;
}

export class NDJSONStream {
  private output: Writable;

  constructor(output: Writable = process.stdout) {
    this.output = output;
  }

  /**
   * Write a record as NDJSON
   */
  private write(record: NDJSONRecord): void {
    this.output.write(JSON.stringify(record) + '\n');
  }

  /**
   * Emit discovery event (when URL map is complete)
   */
  emitDiscovery(urls: string[], totalFound: number, afterFilter: number): void {
    this.write({
      type: 'discovery',
      timestamp: new Date().toISOString(),
      data: {
        totalDiscovered: totalFound,
        afterFiltering: afterFilter,
        urls: urls.slice(0, 10), // Show first 10 URLs as sample
        sample: true,
      },
    });
  }

  /**
   * Emit scan result for a single page
   */
  emitScanResult(result: PageScanResult): void {
    this.write({
      type: 'scan',
      timestamp: new Date().toISOString(),
      data: {
        url: result.url,
        success: result.success,
        error: result.error,
        violationCount: result.violations.length,
        violations: result.violations.map(v => ({
          id: v.id,
          impact: v.impact,
          description: v.description,
        })),
      },
    });
  }

  /**
   * Emit progress update
   */
  emitProgress(scanned: number, total: number, elapsed: number): void {
    this.write({
      type: 'scan',
      timestamp: new Date().toISOString(),
      data: {
        progress: {
          scanned,
          total,
          percent: Math.round((scanned / total) * 100),
          elapsedSeconds: Math.round(elapsed / 1000),
          estimatedSecondsRemaining: Math.round((elapsed / scanned) * (total - scanned) / 1000),
        },
      },
    });
  }

  /**
   * Emit completion with aggregated stats
   */
  emitComplete(stats: {
    domain: string;
    pagesScanned: number;
    totalViolations: number;
    byImpact: Record<string, number>;
    elapsedSeconds: number;
  }): void {
    this.write({
      type: 'complete',
      timestamp: new Date().toISOString(),
      data: stats,
    });
  }

  /**
   * Emit error event
   */
  emitError(message: string, error?: Error): void {
    this.write({
      type: 'error',
      timestamp: new Date().toISOString(),
      data: {
        message,
        errorMessage: error?.message,
        stack: error?.stack,
      },
    });
  }
}

/**
 * Parse NDJSON stream (for consuming)
 */
export async function* parseNDJSON(input: string): AsyncGenerator<NDJSONRecord> {
  const lines = input.trim().split('\n');
  for (const line of lines) {
    if (line.trim()) {
      try {
        yield JSON.parse(line);
      } catch (err) {
        console.error('Failed to parse NDJSON line:', line);
      }
    }
  }
}

import 'dotenv/config.js';
import fs from 'fs/promises';
import path from 'path';
import { ClusterScanner } from '../concepts/a11y-scanner/cluster-scanner.ts';
import { generateReport } from '../concepts/a11y-scanner/report.ts';
import { calculateViolationStats } from '../concepts/a11y-scanner/stats.ts';
import { AutomationReporter } from './automation-reporter.ts';
import type { BatchScanConfig, BatchScanResult, BatchReport } from './types.ts';
import type { ScanReport } from '../types/a11y.d.ts';
import colors from 'picocolors';

export class BatchScanner {
  private config: BatchScanConfig;

  constructor(config: BatchScanConfig) {
    this.config = config;
  }

  /**
   * Clean up scan results older than 7 days
   */
  static async cleanupOldScans(baseDir: string, daysToKeep: number = 7): Promise<void> {
    try {
      const entries = await fs.readdir(baseDir, { withFileTypes: true });
      const now = Date.now();
      const maxAge = daysToKeep * 24 * 60 * 60 * 1000; // Convert days to milliseconds

      for (const entry of entries) {
        if (!entry.isDirectory() || !entry.name.startsWith('scan-')) {
          continue;
        }

        const dirPath = path.join(baseDir, entry.name);
        const stats = await fs.stat(dirPath);
        const age = now - stats.mtime.getTime();

        if (age > maxAge) {
          console.log(colors.gray(`  🗑️  Cleaning up old scan: ${entry.name} (${Math.floor(age / (24 * 60 * 60 * 1000))} days old)`));
          await fs.rm(dirPath, { recursive: true, force: true });
        }
      }
    } catch (error) {
      // If directory doesn't exist or other error, just continue
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.warn(colors.yellow(`Warning: Could not clean old scans: ${(error as Error).message}`));
      }
    }
  }

  /**
   * Read URLs from a text file (one per line, # for comments)
   */
  static async readUrlsFromFile(filePath: string): Promise<string[]> {
    const content = await fs.readFile(filePath, 'utf-8');
    const lines = content.split('\n');

    return lines
      .map(line => line.trim())
      .filter(line => line && !line.startsWith('#') && line.startsWith('http'));
  }

  /**
   * Scan all URLs and save results
   */
  async scanAll(): Promise<BatchReport> {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').split('T')[0];
    const outputDir = path.join(this.config.outputDir, `scan-${timestamp}`);

    // Create output directory
    await fs.mkdir(outputDir, { recursive: true });

    console.log(colors.cyan(`\n🧪 Batch Scanner Starting`));
    console.log(colors.gray(`Output directory: ${outputDir}`));
    console.log(colors.gray(`URLs to scan: ${this.config.urls.length}\n`));

    const results: BatchScanResult[] = [];
    const concurrency = this.config.concurrency || 1;
    const scanner = new ClusterScanner(concurrency);

    try {
      await scanner.initialize();

      let completed = 0;
      for (const url of this.config.urls) {
        completed++;
        console.log(colors.cyan(`\n[${completed}/${this.config.urls.length}] Scanning: ${url}`));

        try {
          const scanResult = await scanner.scanUrl(url);

          if (!scanResult || !scanResult.success) {
            throw new Error(scanResult?.error || 'Scan failed');
          }

          // Generate full report with insights (insight failures are non-fatal)
          // Include uiAutomationResults to ensure all violations found during automation are captured
          let report: ScanReport;
          try {
            report = await generateReport(scanResult.violations, url, scanResult.viewportResults, scanResult.uiAutomationResults);
          } catch (insightErr) {
            console.log(colors.yellow(`  ⚠ Insights unavailable: ${(insightErr as Error).message}`));
            // Use automation violations if available, otherwise use initial scan violations
            const reportViolations = scanResult.uiAutomationResults?.allViolationsFound || scanResult.violations;
            report = {
              metadata: { url, scanDate: new Date().toISOString(), pageScanned: url, standard: 'WCAG 2.1 AA' },
              statistics: { critical: 0, serious: 0, moderate: 0, minor: 0, total: 0 },
              summary: '',
              violations: reportViolations,
              insightsError: (insightErr as Error).message,
              viewportResults: scanResult.viewportResults,
              ...(scanResult.uiAutomationResults && { uiAutomationResults: scanResult.uiAutomationResults }),
            };
            const stats = calculateViolationStats(reportViolations);
            report.statistics = stats;
            report.summary = stats.total === 0
              ? 'No accessibility violations found.'
              : `Found ${stats.total} accessibility violation(s).`;
          }

          // Save JSON file
          const sanitizedUrl = url.replace(/[^a-z0-9]/gi, '_').substring(0, 50);
          const jsonFile = path.join(outputDir, `${sanitizedUrl}.json`);
          await fs.writeFile(jsonFile, JSON.stringify(report, null, 2));

          // Generate automation-report.html if UI automation was performed
          if (scanResult.uiAutomationResults) {
            const automationHtmlFile = path.join(outputDir, `${sanitizedUrl}-automation-report.html`);
            await AutomationReporter.generateReport(outputDir, url, scanResult.uiAutomationResults);
            console.log(colors.gray(`  ✓ Generated automation report: ${sanitizedUrl}-automation-report.html`));
          }

          results.push({
            url,
            success: true,
            scanDate: report.metadata.scanDate,
            jsonFile: path.basename(jsonFile),
            statistics: report.statistics,
          });

          // Print quick summary
          if (report.statistics.total > 0) {
            console.log(colors.yellow(`  ⚠ Found ${report.statistics.total} violations`));
            if (report.statistics.critical > 0) {
              console.log(colors.red(`    • ${report.statistics.critical} critical`));
            }
            if (report.statistics.serious > 0) {
              console.log(colors.red(`    • ${report.statistics.serious} serious`));
            }
            if (report.statistics.moderate > 0) {
              console.log(colors.yellow(`    • ${report.statistics.moderate} moderate`));
            }
            if (report.statistics.minor > 0) {
              console.log(colors.gray(`    • ${report.statistics.minor} minor`));
            }
          } else {
            console.log(colors.green(`  ✓ No violations found`));
          }

        } catch (error) {
          const errorMsg = (error as Error).message;
          console.log(colors.red(`  ✗ Error: ${errorMsg}`));

          results.push({
            url,
            success: false,
            scanDate: new Date().toISOString(),
            jsonFile: '',
            error: errorMsg,
          });
        }
      }

    } finally {
      await scanner.cleanup();
    }

    // Create batch report
    const batchReport: BatchReport = {
      timestamp: new Date().toISOString(),
      totalUrls: this.config.urls.length,
      successful: results.filter(r => r.success).length,
      failed: results.filter(r => !r.success).length,
      results,
    };

    // Save batch report JSON
    const reportFile = path.join(outputDir, 'batch-report.json');
    await fs.writeFile(reportFile, JSON.stringify(batchReport, null, 2));

    console.log(colors.cyan(`\n\n📊 Batch Scan Complete`));
    console.log(colors.green(`  ✓ Successful: ${batchReport.successful}`));
    if (batchReport.failed > 0) {
      console.log(colors.red(`  ✗ Failed: ${batchReport.failed}`));
    }
    console.log(colors.gray(`\nResults saved to: ${outputDir}\n`));

    return batchReport;
  }

  /**
   * Load scan results from JSON files for HTML report generation
   */
  static async loadScanResults(outputDir: string, batchReport: BatchReport): Promise<ScanReport[]> {
    const reports: ScanReport[] = [];

    for (const result of batchReport.results) {
      if (!result.success || !result.jsonFile) continue;

      try {
        const jsonPath = path.join(outputDir, result.jsonFile);
        const content = await fs.readFile(jsonPath, 'utf-8');
        reports.push(JSON.parse(content) as ScanReport);
      } catch (error) {
        console.error(colors.red(`Failed to load ${result.jsonFile}: ${(error as Error).message}`));
      }
    }

    return reports;
  }
}

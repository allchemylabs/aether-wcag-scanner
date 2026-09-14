#!/usr/bin/env node
import 'dotenv/config.js';
import path from 'path';
import { BatchScanner } from './batch-scanner.ts';
import { HTMLReporter } from './html-reporter.ts';
import colors from 'picocolors';

const DEFAULT_URL_FILE = 'test-urls.txt';
const DEFAULT_OUTPUT_DIR = 'test-results';

async function main() {
  const urlFile = process.argv[2] || DEFAULT_URL_FILE;
  const outputDir = process.argv[3] || DEFAULT_OUTPUT_DIR;

  console.log(colors.cyan('\n🧪 Accessibility Testing Agent\n'));
  console.log(colors.gray(`Reading URLs from: ${urlFile}`));

  try {
    // Clean up old scans (older than 7 days)
    await BatchScanner.cleanupOldScans(outputDir, 7);

    // Read URLs from file
    const urls = await BatchScanner.readUrlsFromFile(urlFile);

    if (urls.length === 0) {
      console.error(colors.red('\n❌ No valid URLs found in file'));
      console.error(colors.gray('\nMake sure your file contains URLs, one per line:'));
      console.error(colors.gray('  https://example.com'));
      console.error(colors.gray('  https://another-site.com\n'));
      process.exit(1);
    }

    // Create batch scanner
    const scanner = new BatchScanner({
      urls,
      outputDir,
      concurrency: parseInt(process.env.SCAN_CONCURRENCY || '3'),
    });

    // Run batch scan
    const batchReport = await scanner.scanAll();

    // Get the actual output directory (with timestamp)
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').split('T')[0];
    const actualOutputDir = path.join(outputDir, `scan-${timestamp}`);

    // Load scan results for HTML generation
    console.log(colors.cyan('\n📄 Generating HTML report...'));
    const scanReports = await BatchScanner.loadScanResults(actualOutputDir, batchReport);

    // Generate HTML report
    const htmlPath = await HTMLReporter.generateReport(actualOutputDir, batchReport, scanReports);
    console.log(colors.green(`✓ HTML report saved: ${htmlPath}`));

    // Final summary
    console.log(colors.cyan('\n✨ Testing Complete!\n'));
    console.log(colors.gray('View your results:'));
    console.log(colors.white(`  HTML: ${htmlPath}`));
    console.log(colors.white(`  JSON: ${actualOutputDir}/batch-report.json\n`));

    if (batchReport.failed > 0) {
      console.log(colors.yellow(`⚠️  Note: ${batchReport.failed} scan(s) failed. Check the HTML report for details.\n`));
    }

  } catch (error) {
    console.error(colors.red('\n❌ Error:'), (error as Error).message);
    process.exit(1);
  }
}

main();

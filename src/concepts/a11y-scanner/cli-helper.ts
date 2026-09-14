#!/usr/bin/env node
/**
 * CLI Helper - Provides formatted output options for a11y scanner results
 * Usage: tsx cli-helper.ts <format> <url> [options]
 *
 * Formats:
 *   - json      : Full JSON output
 *   - stats     : Statistics only
 *   - summary   : Metadata, statistics, and summary
 *   - violations: Violation summary
 *   - worst     : Worst pages
 *   - all       : All details (default)
 */

import { execFileSync } from 'node:child_process';

const format = process.argv[2] || 'all';
const url = process.argv[3];
const extraArgs = process.argv.slice(4);

if (!url) {
  console.error('Usage: tsx cli-helper.ts <format> <url> [options]');
  console.error('Formats: json, stats, summary, violations, worst, all');
  process.exit(1);
}

try {
  // Spawn the scanner directly (no shell) so URL/options are passed as argv
  // and can never be interpreted as shell metacharacters. stderr is discarded
  // (equivalent of the former `2>/dev/null`) so only the JSON report is parsed.
  const output = execFileSync(
    process.execPath,
    ['--import', 'tsx', 'src/concepts/a11y-scanner/index.ts', url, ...extraArgs],
    { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'ignore'] },
  );

  try {
    const report = JSON.parse(output);

    switch (format) {
      case 'json':
        console.log(JSON.stringify(report, null, 2));
        break;
      case 'stats':
        console.log(JSON.stringify(report.statistics, null, 2));
        break;
      case 'summary':
        console.log(JSON.stringify({
          metadata: report.metadata,
          statistics: report.statistics,
          summary: report.summary,
        }, null, 2));
        break;
      case 'violations':
        console.log(JSON.stringify(report.advancedStats?.violationSummary || report.violations, null, 2));
        break;
      case 'worst':
        console.log(JSON.stringify(report.advancedStats?.worstPages || [], null, 2));
        break;
      case 'all':
      default:
        console.log(JSON.stringify(report, null, 2));
        break;
    }
  } catch (e) {
    // Invalid JSON, output as-is
    console.log(output);
  }
} catch (error: any) {
  console.error('Error running scan:', error.message);
  process.exit(1);
}

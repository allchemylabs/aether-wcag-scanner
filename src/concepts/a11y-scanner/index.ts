#!/usr/bin/env node
import 'dotenv/config.js';
import { generateReport, outputReport } from './report.ts';
import { getCrawlMap, extractDomain, filterDomainUrls, deduplicateUrls } from './firecrawl.ts';
import { ClusterScanner } from './cluster-scanner.ts';
import { filterUrls, limitUrls } from './url-filter.ts';
import { aggregateResults, getViolationSummary, getWorstPages, getFailedScans } from './aggregator.ts';
import { NDJSONStream } from './ndjson-stream.ts';
import type { MultiPageScanReport } from '../../types/a11y';
import colors from 'picocolors';

const url = process.argv[2];
const multiPage = process.argv[3] === '--multi' || process.env.MULTI_PAGE === 'true';
const useNDJSON = process.env.NDJSON === 'true';

// Parse Axe tags from environment variable (comma-separated)
// Examples: AXE_TAGS="wcag2a,wcag2aa" or AXE_TAGS="wcag21aa,best-practice"
// If not set, all rules will run
const axeTags = process.env.AXE_TAGS
  ? process.env.AXE_TAGS.split(',').map(tag => tag.trim()).filter(Boolean)
  : undefined;

if (!url || !url.startsWith('http')) {
  console.error(colors.red('\nUsage:\n'));
  console.error(colors.gray('  Single page:    npm run a11y <url>'));
  console.error(colors.gray('  Multiple pages: npm run a11y <url> --multi\n'));
  console.error(colors.gray('Example:\n'));
  console.error(colors.gray('  npm run a11y https://news.ycombinator.com'));
  console.error(colors.gray('  npm run a11y https://yuktiq.io --multi\n'));
  process.exit(1);
}

(async () => {
  try {
    if (multiPage) {
      // === Multi-Page Scan (Optimized) ===
      const ndjson = useNDJSON ? new NDJSONStream() : null;

      if (!useNDJSON) {
        process.stderr.write(colors.cyan(`\nScanning all pages on ${url}\n\n`));
      }

      // Get crawl map from Firecrawl
      if (!useNDJSON) {
        process.stderr.write(colors.gray('Discovering pages with Firecrawl MAP API...\n'));
      }
      const crawlMap = await getCrawlMap(url);
      const crawlDegraded = crawlMap.degraded ? crawlMap.degradedReason : undefined;
      const domain = extractDomain(url);
      let urls = filterDomainUrls(crawlMap.urls, domain);
      urls = deduplicateUrls(urls);

      // Filter and limit URLs
      urls = filterUrls(urls, domain);
      urls = limitUrls(urls, parseInt(process.env.FIRECRAWL_PAGE_LIMIT || '50'));

      if (ndjson) {
        ndjson.emitDiscovery(crawlMap.urls, crawlMap.urls.length, urls.length);
      } else {
        process.stderr.write(colors.gray(`Found ${urls.length} pages to scan (filtered from ${crawlMap.totalPages})\n\n`));
      }

      // Initialize cluster scanner with higher concurrency
      const maxConcurrency = parseInt(process.env.SCAN_CONCURRENCY || '20');
      const scanner = new ClusterScanner(maxConcurrency, axeTags);

      if (!useNDJSON) {
        process.stderr.write(colors.gray(`Launching scanner cluster (${maxConcurrency} concurrent)...\n\n`));
      }

      const startTime = Date.now();
      await scanner.initialize();

      try {
        // Scan all URLs with automatic concurrency management
        const pageResults = await scanner.scanUrls(urls);
        let scannedCount = 0;

        // Add RAG insights to each page result
        for (const result of pageResults) {
          scannedCount++;

          if (result.success && result.violations.length > 0) {
            try {
              const report = await generateReport(result.violations, result.url);
              result.insights = report.insights;
              if (report.insightsError) {
                result.insightsError = report.insightsError;
                console.error(`Warning: ${report.insightsError} for ${result.url}`);
              }
            } catch (error) {
              const message = (error as Error).message;
              result.insightsError = `RAG insights failed: ${message}`;
              console.error(`Warning: Could not fetch insights for ${result.url}: ${message}`);
            }
          }

          if (ndjson) {
            ndjson.emitScanResult(result);
          }
        }

        // Emit final progress
        if (ndjson) {
          ndjson.emitProgress(scannedCount, urls.length, Date.now() - startTime);
        }

        if (!useNDJSON) {
          // Generate aggregated report
          const report = aggregateResults(pageResults, domain);
          const violationSummary = getViolationSummary(pageResults);
          const worstPages = getWorstPages(pageResults, 5);
          const failedScans = getFailedScans(pageResults);

          const enhancedReport = {
            ...report,
            ...(crawlDegraded && {
              warnings: [crawlDegraded],
            }),
            advancedStats: {
              violationSummary,
              worstPages: worstPages.map(p => ({
                url: p.url,
                violationCount: p.violations.length,
              })),
              failedScans: failedScans.map(p => ({
                url: p.url,
                error: p.error,
              })),
            },
          } as MultiPageScanReport & { warnings?: string[]; advancedStats: unknown };

          outputReport(enhancedReport);
        } else {
          // Emit completion with stats
          const stats = {
            critical: 0,
            serious: 0,
            moderate: 0,
            minor: 0,
          };

          for (const result of pageResults) {
            for (const violation of result.violations) {
              switch (violation.impact) {
                case 'critical':
                  stats.critical++;
                  break;
                case 'serious':
                  stats.serious++;
                  break;
                case 'moderate':
                  stats.moderate++;
                  break;
                case 'minor':
                  stats.minor++;
                  break;
              }
            }
          }

          ndjson!.emitComplete({
            domain,
            pagesScanned: pageResults.length,
            totalViolations: pageResults.reduce((sum, r) => sum + r.violations.length, 0),
            byImpact: stats,
            elapsedSeconds: Math.round((Date.now() - startTime) / 1000),
          });
        }
      } finally {
        await scanner.cleanup();
      }
    } else {
      // === Single-Page Scan ===
      process.stderr.write(colors.cyan(`\nScanning for accessibility issues → ${url}\n\n`));

      const scanner = new ClusterScanner(1, axeTags);
      process.stderr.write(colors.gray('Running Axe Core scan...\n\n'));

      await scanner.initialize();

      try {
        const result = await scanner.scanUrl(url);

        if (!result || !result.success) {
          throw new Error(result?.error || 'Scan failed');
        }

        process.stderr.write(colors.gray('Generating report with AI-powered insights...\n\n'));
        const report = await generateReport(result.violations, url);
        outputReport(report);
      } finally {
        await scanner.cleanup();
      }
    }
  } catch (err) {
    console.error(colors.red('Scan failed:'), (err as Error).message);
    process.exit(1);
  }
})();
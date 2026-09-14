import type { PageScanResult, MultiPageScanReport, Violation } from '../../types/a11y';

export function aggregateResults(
  pageResults: PageScanResult[],
  domain: string
): MultiPageScanReport {
  // Calculate statistics across all pages
  const stats = {
    critical: 0,
    serious: 0,
    moderate: 0,
    minor: 0,
    total: 0,
    pagesWithIssues: 0,
  };

  for (const result of pageResults) {
    if (result.success && result.violations.length > 0) {
      stats.pagesWithIssues++;

      for (const violation of result.violations) {
        stats.total++;

        const impact = violation.impact || 'unknown';
        switch (impact) {
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
  }

  const summary = generateMultiPageSummary(stats, pageResults.length, domain);

  return {
    metadata: {
      domain,
      scanDate: new Date().toISOString(),
      pagesScanned: pageResults.length,
      standard: 'WCAG 2.1 AA',
    },
    statistics: stats,
    summary,
    pageResults,
  };
}

function generateMultiPageSummary(
  stats: MultiPageScanReport['statistics'],
  totalPages: number,
  domain: string
): string {
  if (stats.total === 0) {
    return `Excellent news! All ${totalPages} pages on ${domain} passed accessibility checks. No violations found against WCAG 2.1 AA standards.`;
  }

  const pagesWithIssuesPercent = ((stats.pagesWithIssues / totalPages) * 100).toFixed(1);
  const issues = [];

  if (stats.critical > 0) {
    issues.push(`${stats.critical} critical issue${stats.critical > 1 ? 's' : ''}`);
  }
  if (stats.serious > 0) {
    issues.push(`${stats.serious} serious issue${stats.serious > 1 ? 's' : ''}`);
  }
  if (stats.moderate > 0) {
    issues.push(`${stats.moderate} moderate issue${stats.moderate > 1 ? 's' : ''}`);
  }
  if (stats.minor > 0) {
    issues.push(`${stats.minor} minor issue${stats.minor > 1 ? 's' : ''}`);
  }

  return (
    `Accessibility scan of ${domain} across ${totalPages} pages identified ` +
    `${stats.total} violation${stats.total > 1 ? 's' : ''} ` +
    `(${pagesWithIssuesPercent}% of pages affected): ${issues.join(', ')}. ` +
    `Immediate attention should be given to critical and serious violations ` +
    `to ensure WCAG 2.1 AA compliance.`
  );
}

/**
 * Get summary statistics for each violation rule across all pages
 */
export function getViolationSummary(pageResults: PageScanResult[]): ViolationRuleSummary[] {
  const violationMap = new Map<string, ViolationRuleAccumulator>();

  for (const result of pageResults) {
    for (const violation of result.violations) {
      const existing = violationMap.get(violation.id);

      if (existing) {
        existing.occurrences++;
        existing.affectedPages.add(result.url);
      } else {
        violationMap.set(violation.id, {
          id: violation.id,
          description: violation.description,
          impact: violation.impact,
          help: violation.help,
          helpUrl: violation.helpUrl,
          occurrences: 1,
          affectedPages: new Set([result.url]),
        });
      }
    }
  }

  // Convert Sets to arrays and sort by occurrences
  const summary = Array.from(violationMap.values()).map(item => ({
    ...item,
    affectedPages: Array.from(item.affectedPages),
  }));

  return summary.sort((a, b) => b.occurrences - a.occurrences);
}

export interface ViolationRuleSummary {
  id: string;
  description: string;
  impact?: string;
  help?: string;
  helpUrl?: string;
  occurrences: number;
  affectedPages: string[];
}

/** Internal working type that uses Set for deduplication during aggregation */
interface ViolationRuleAccumulator extends Omit<ViolationRuleSummary, 'affectedPages'> {
  affectedPages: Set<string>;
}

/**
 * Get top N worst pages by violation count
 */
export function getWorstPages(pageResults: PageScanResult[], limit: number = 10): PageScanResult[] {
  return pageResults
    .filter(r => r.success)
    .sort((a, b) => b.violations.length - a.violations.length)
    .slice(0, limit);
}

/**
 * Get failed scan pages
 */
export function getFailedScans(pageResults: PageScanResult[]): PageScanResult[] {
  return pageResults.filter(r => !r.success);
}

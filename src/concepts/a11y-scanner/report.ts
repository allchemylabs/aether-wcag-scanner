import { randomUUID } from 'node:crypto';
import type { Violation, ScanReport, MultiPageScanReport, InsightsResult, ViewportResult } from '../../types/a11y';
import type { UIAutomationSequenceResult } from '../../types/ui-automation';
import { getInsights } from './insight-client.ts';
import { calculateViolationStats } from './stats.ts';
import { buildFindings } from './finding.ts';

export async function generateReport(violations: Violation[], url: string, viewportResults?: ViewportResult[], uiAutomationResults?: UIAutomationSequenceResult): Promise<ScanReport> {
  // If automation was performed, use allViolationsFound to capture violations across all tabs/states
  const reportViolations = uiAutomationResults?.allViolationsFound || violations;
  const stats = calculateViolationStats(reportViolations);

  // Generate summary
  const summary = generateSummary(stats);

  // Get AI-powered insights if there are violations and API is available
  let insights: InsightsResult | undefined;
  let insightsError: string | undefined;
  if (reportViolations.length > 0) {
    try {
      insights = await getInsights(
        {
          axeResults: { violations: reportViolations },
          url,
          businessContext: {
            industry: 'Technology',
            personas: ['Screen reader users', 'Keyboard-only users', 'Low vision users'],
          },
          // CI/Jenkins report is a deterministic surface (docs §8) — ontology
          // guidance + grounded fixes, no Path-A LLM narrative.
          mode: 'deterministic',
        },
        {
          onProgress: (event) => {
            switch (event.event) {
              case 'violations_extracted':
                console.error(`[insight] Found ${event.data.count} violations`);
                break;
              case 'analysis_start':
                console.error(
                  `[insight] Analyzing violation ${event.data.index}/${event.data.total}: ${event.data.violation_id}`,
                );
                break;
              case 'complete':
                console.error('[insight] Insights complete');
                break;
              case 'async_job_created':
                console.error(`[insight] Large scan — async job created: ${event.data.jobId}`);
                break;
              case 'job_progress':
                console.error(
                  `[insight] Job progress: ${event.data.progress}/${event.data.total}`,
                );
                break;
            }
          },
        },
      );
    } catch (error) {
      const message = (error as Error).message;
      insightsError = `RAG insights unavailable: ${message}`;
      console.error(`Warning: Could not fetch RAG insights: ${message}`);
    }
  }

  // Collapse violations + grounded guidance into the enriched Finding view
  // (stable fingerprint, within-scan dedup, shared-remediation links). The
  // Jenkins/CI report is a deterministic surface (§5.3).
  const scanId = `scan_${randomUUID()}`;
  const findings = buildFindings(reportViolations, insights?.violationGuidance, {
    scanId,
    versions: insights?.versions,
    renderMode: 'deterministic',
  });

  const report: ScanReport = {
    metadata: {
      url,
      scanDate: new Date().toISOString(),
      pageScanned: url,
      standard: 'WCAG 2.1 AA',
    },
    statistics: stats,
    summary,
    violations: reportViolations,
    insights,
    ...(insightsError && { insightsError }),
    ...(findings.length > 0 && { findings }),
    ...(viewportResults && { viewportResults }),
    ...(uiAutomationResults && { uiAutomationResults }),
  };

  return report;
}

export function generateSummary(stats: ScanReport['statistics']): string {
  if (stats.total === 0) {
    return 'No accessibility violations found. The page appears to meet WCAG 2.1 AA standards.';
  }

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

  return `This accessibility scan identified ${stats.total} violation${stats.total > 1 ? 's' : ''}: ${issues.join(', ')}. Immediate attention should be given to the critical and serious violations to ensure compliance with WCAG 2.1 AA standards.`;
}

export function outputReport(report: ScanReport | MultiPageScanReport): void {
  console.log(JSON.stringify(report, null, 2));
}

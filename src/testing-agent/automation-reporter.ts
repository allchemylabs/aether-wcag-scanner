import fs from 'fs/promises';
import path from 'path';
import type { UIAutomationSequenceResult } from '../types/ui-automation';

export class AutomationReporter {
  static async generateReport(
    outputDir: string,
    url: string,
    automationResults: UIAutomationSequenceResult,
  ): Promise<string> {
    const htmlPath = path.join(outputDir, 'automation-report.html');
    const html = this.buildHTML(url, automationResults);
    await fs.writeFile(htmlPath, html);
    return htmlPath;
  }

  private static buildHTML(url: string, results: UIAutomationSequenceResult): string {
    const totalSteps = results.stepExecutions.length;
    const passedSteps = results.stepExecutions.filter(s => s.success).length;
    const failedSteps = totalSteps - passedSteps;
    const allPassed = failedSteps === 0;
    const totalDuration = results.stepExecutions.reduce((s, e) => s + e.stepDurationMs, 0);

    const initialViolationCount = results.initialViolations.reduce(
      (s, v) => s + (v.nodes?.length || 1), 0
    );
    const lastStep = results.stepExecutions[results.stepExecutions.length - 1];
    const finalViolationCount = lastStep?.violationsAfterStep
      ? lastStep.violationsAfterStep.reduce((s, v) => s + (v.nodes?.length || 1), 0)
      : initialViolationCount;

    // Use allViolationsFound if available, otherwise fall back to final violations
    const allViolations = results.allViolationsFound || results.stepExecutions.flatMap(s => s.violationsAfterStep || []);
    const totalViolationsCount = allViolations.reduce((s, v) => s + (v.nodes?.length || 1), 0);

    const violationDelta = finalViolationCount - initialViolationCount;
    const deltaLabel = violationDelta === 0
      ? 'No change'
      : violationDelta > 0
        ? `+${violationDelta} new`
        : `${violationDelta} resolved`;

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>UI Automation Report</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      line-height: 1.6;
      color: #1a1a1a;
      background: #f5f5f5;
      padding: 2rem;
      max-width: 960px;
      margin: 0 auto;
    }
    .container {
      background: #fff;
      border-radius: 8px;
      box-shadow: 0 1px 3px rgba(0,0,0,0.1);
      padding: 2rem;
    }
    h1 {
      font-size: 1.5rem;
      font-weight: 700;
      margin-bottom: 0.25rem;
    }
    .meta {
      color: #666;
      font-size: 0.9rem;
      margin-bottom: 1.5rem;
    }
    .summary-grid {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 1rem;
      margin-bottom: 2rem;
    }
    .summary-card {
      border: 1px solid #e0e0e0;
      border-radius: 6px;
      padding: 1rem;
      text-align: center;
    }
    .summary-card .value {
      font-size: 1.75rem;
      font-weight: 700;
    }
    .summary-card .label {
      font-size: 0.8rem;
      color: #666;
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }
    .pass { color: #16a34a; }
    .fail { color: #dc2626; }
    .neutral { color: #2563eb; }
    .badge {
      display: inline-block;
      padding: 0.15rem 0.6rem;
      border-radius: 4px;
      font-size: 0.75rem;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.03em;
    }
    .badge-pass { background: #dcfce7; color: #16a34a; }
    .badge-fail { background: #fee2e2; color: #dc2626; }
    h2 {
      font-size: 1.15rem;
      font-weight: 600;
      margin-bottom: 1rem;
      padding-bottom: 0.5rem;
      border-bottom: 1px solid #e0e0e0;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      margin-bottom: 2rem;
    }
    th {
      text-align: left;
      font-size: 0.75rem;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: #666;
      padding: 0.6rem 0.75rem;
      border-bottom: 2px solid #e0e0e0;
    }
    td {
      padding: 0.6rem 0.75rem;
      border-bottom: 1px solid #f0f0f0;
      font-size: 0.9rem;
    }
    tr:hover { background: #fafafa; }
    .step-num {
      font-weight: 600;
      color: #666;
      width: 3rem;
    }
    .action-tag {
      display: inline-block;
      background: #f0f0f0;
      padding: 0.1rem 0.5rem;
      border-radius: 3px;
      font-family: monospace;
      font-size: 0.8rem;
    }
    .selector {
      font-family: monospace;
      font-size: 0.8rem;
      color: #666;
    }
    .duration {
      text-align: right;
      color: #666;
      font-size: 0.85rem;
    }
    .violations-col {
      text-align: right;
    }
    .delta-positive { color: #dc2626; }
    .delta-negative { color: #16a34a; }
    .delta-zero { color: #666; }
    .footer {
      margin-top: 2rem;
      padding-top: 1rem;
      border-top: 1px solid #e0e0e0;
      font-size: 0.8rem;
      color: #999;
      text-align: center;
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>UI Automation Report</h1>
    <div class="meta">
      ${this.escapeHtml(url)} &mdash; ${new Date().toLocaleString()}
    </div>

    <div class="summary-grid">
      <div class="summary-card">
        <div class="value ${allPassed ? 'pass' : 'fail'}">${allPassed ? 'PASS' : 'FAIL'}</div>
        <div class="label">Status</div>
      </div>
      <div class="summary-card">
        <div class="value">${passedSteps}/${totalSteps}</div>
        <div class="label">Steps Passed</div>
      </div>
      <div class="summary-card">
        <div class="value">${(totalDuration / 1000).toFixed(1)}s</div>
        <div class="label">Duration</div>
      </div>
      <div class="summary-card">
        <div class="value ${violationDelta > 0 ? 'fail' : violationDelta < 0 ? 'pass' : 'neutral'}">${deltaLabel}</div>
        <div class="label">Violations Delta</div>
      </div>
    </div>

    <h2>Step Execution</h2>
    <table>
      <thead>
        <tr>
          <th>#</th>
          <th>Status</th>
          <th>Action</th>
          <th>Name</th>
          <th>Selector / Value</th>
          <th>Duration</th>
          <th class="violations-col">Violations</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td class="step-num">0</td>
          <td><span class="badge badge-pass">INIT</span></td>
          <td><span class="action-tag">page load</span></td>
          <td>Initial scan</td>
          <td class="selector">&mdash;</td>
          <td class="duration">&mdash;</td>
          <td class="violations-col">${initialViolationCount}</td>
        </tr>
${results.stepExecutions.map((exec, i) => {
  const afterCount = exec.violationsAfterStep
    ? exec.violationsAfterStep.reduce((s, v) => s + (v.nodes?.length || 1), 0)
    : '&mdash;';
  const beforeCount = exec.violationsBeforeStep.reduce((s, v) => s + (v.nodes?.length || 1), 0);
  const delta = typeof afterCount === 'number' ? afterCount - beforeCount : 0;
  const deltaStr = typeof afterCount === 'number'
    ? (delta === 0 ? '' : delta > 0 ? ` <span class="delta-positive">(+${delta})</span>` : ` <span class="delta-negative">(${delta})</span>`)
    : '';
  const selectorOrValue = exec.step.selector || exec.step.value || '&mdash;';
  return `        <tr>
          <td class="step-num">${i + 1}</td>
          <td><span class="badge ${exec.success ? 'badge-pass' : 'badge-fail'}">${exec.success ? 'PASS' : 'FAIL'}</span></td>
          <td><span class="action-tag">${this.escapeHtml(exec.step.action)}</span></td>
          <td>${this.escapeHtml(exec.step.name)}${exec.error ? `<br><small style="color:#dc2626">${this.escapeHtml(exec.error)}</small>` : ''}</td>
          <td class="selector">${this.escapeHtml(String(selectorOrValue))}</td>
          <td class="duration">${exec.stepDurationMs}ms</td>
          <td class="violations-col">${afterCount}${deltaStr}</td>
        </tr>`;
}).join('\n')}
      </tbody>
    </table>

    <h2>All Violations Found</h2>
    ${allViolations.length === 0
      ? '<p style="color: #666; padding: 1rem;">No violations were found during this automation sequence.</p>'
      : `<p>Total violations discovered: <strong>${allViolations.length}</strong> violation types with <strong>${totalViolationsCount}</strong> instances</p>
    <div style="margin-top: 1rem;">
      ${allViolations.map((violation) => `
        <div style="margin-bottom: 1.5rem; padding: 1rem; background: #f9f9f9; border-left: 4px solid #dc2626;">
          <div style="font-weight: 600; margin-bottom: 0.5rem;">${this.escapeHtml(violation.id)}: ${this.escapeHtml(violation.description || 'No description')}</div>
          <div style="font-size: 0.9rem; color: #666; margin-bottom: 0.5rem;">
            <strong>Impact:</strong> ${this.escapeHtml(violation.impact || 'unknown')} | 
            <strong>Instances:</strong> ${violation.nodes?.length || 1}
          </div>
          ${violation.nodes && violation.nodes.length > 0 ? `
            <div style="font-size: 0.85rem; color: #999; word-break: break-all;">
              ${violation.nodes.slice(0, 3).map((node) => `
                <div style="margin-top: 0.5rem; padding: 0.5rem; background: #fff; border: 1px solid #e0e0e0; border-radius: 3px;">
                  <strong>Selector:</strong> ${this.escapeHtml((Array.isArray(node.target) ? node.target.join(' > ') : node.target) || 'N/A')}<br>
                  ${node.html ? `<strong>HTML:</strong> <code>${this.escapeHtml(node.html.substring(0, 200))}</code>` : ''}
                </div>
              `).join('')}
              ${violation.nodes.length > 3 ? `<div style="margin-top: 0.5rem; color: #999;">... and ${violation.nodes.length - 3} more instances</div>` : ''}
            </div>
          ` : ''}
        </div>
      `).join('')}
    </div>`
    }

    <div class="footer">
      Generated by ALLchemy WCAG Scanner &mdash; UI Automation Module
    </div>
  </div>
</body>
</html>`;
  }

  private static escapeHtml(str: string): string {
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
}

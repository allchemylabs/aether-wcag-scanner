import fs from 'fs/promises';
import path from 'path';
import type { BatchReport } from './types.ts';
import type { ScanReport, Violation, CorpusInsight, ViewportResult, ViolationGuidance, Confidence } from '../types/a11y.d.ts';

/** How the HTML report should encode element screenshots. */
export interface ScreenshotRenderOptions {
  /** inline base64 (default) / relative file src / both. */
  mode: 'inline' | 'files' | 'both';
}

export class HTMLReporter {
  /**
   * Element-screenshot render config for the current report build. Set at the
   * start of `generateReport` and cleared after, so the synchronous card
   * builders can read it without threading a param through every method.
   */
  private static shotMode: 'inline' | 'files' | 'both' = 'inline';
  /** Relative screenshot path → base64 data URI (preloaded for inline modes). */
  private static shotInline: Map<string, string> = new Map();

  /**
   * Generate an HTML report from batch scan results
   */
  static async generateReport(
    outputDir: string,
    batchReport: BatchReport,
    scanReports: ScanReport[],
    screenshotOptions?: ScreenshotRenderOptions
  ): Promise<string> {
    const htmlPath = path.join(outputDir, 'report.html');

    // Preload screenshot files as base64 data URIs for inline/both modes so the
    // report is a self-contained, forwardable file.
    this.shotMode = screenshotOptions?.mode ?? 'inline';
    this.shotInline = new Map();
    if (this.shotMode !== 'files') {
      await this.preloadScreenshots(outputDir, scanReports);
    }

    try {
      const html = this.buildHTML(batchReport, scanReports);
      await fs.writeFile(htmlPath, html);
      return htmlPath;
    } finally {
      // Clear transient state so a later report build starts clean.
      this.shotInline = new Map();
    }
  }

  /** MIME type for a screenshot file extension. */
  private static shotMime(relPath: string): string {
    return relPath.toLowerCase().endsWith('.png') ? 'image/png' : 'image/webp';
  }

  /**
   * Read every referenced screenshot file once and cache it as a base64 data
   * URI keyed by its relative report path. Failures are skipped silently (the
   * card falls back to a relative src / omits the image).
   */
  private static async preloadScreenshots(outputDir: string, scanReports: ScanReport[]): Promise<void> {
    const paths = new Set<string>();
    const collect = (v: Violation): void => {
      for (const node of v.nodes ?? []) {
        const shot = node.screenshot;
        if (!shot) continue;
        for (const p of [shot.crop, shot.context]) {
          if (p && !p.startsWith('data:')) paths.add(p);
        }
      }
    };
    for (const report of scanReports) {
      for (const v of report.violations) collect(v);
      for (const vr of report.viewportResults ?? []) {
        for (const v of vr.violations) collect(v);
      }
    }
    for (const rel of paths) {
      try {
        const buf = await fs.readFile(path.join(outputDir, rel));
        this.shotInline.set(rel, `data:${this.shotMime(rel)};base64,${buf.toString('base64')}`);
      } catch {
        // File missing / unreadable — the card will fall back gracefully.
      }
    }
  }

  /** Resolve the `src` for a screenshot ref given the active render mode. */
  private static resolveShotSrc(ref?: string): string {
    if (!ref) return '';
    if (ref.startsWith('data:')) return ref;              // already inline
    if (this.shotMode === 'files') return ref;            // relative file src
    return this.shotInline.get(ref) ?? ref;               // inline, fall back to path
  }

  private static extractCompanyName(batchReport: BatchReport): string {
    const firstUrl = batchReport.results?.[0]?.url;
    if (!firstUrl) return '';
    try {
      const hostname = new URL(firstUrl).hostname;
      // Strip www. prefix, then take the main domain name (before the TLD)
      const clean = hostname.replace(/^www\./, '');
      const parts = clean.split('.');
      // For subdomains like app.infilla.com, use the second-to-last part
      const name = parts.length >= 2 ? parts[parts.length - 2] : parts[0];
      // Known acronym brands that should be all-caps
      const upperCaseBrands = ['usps', 'ibm', 'nasa', 'irs', 'fbi', 'cia', 'nps', 'ssa', 'hhs', 'dhs'];
      if (upperCaseBrands.includes(name.toLowerCase())) {
        return name.toUpperCase();
      }
      // Capitalize first letter
      return name.charAt(0).toUpperCase() + name.slice(1);
    } catch {
      return '';
    }
  }

  private static buildHTML(batchReport: BatchReport, scanReports: ScanReport[]): string {
    // Instance counts (nodes) — used in severity breakdown
    const totalInstances = scanReports.reduce((sum, r) => sum + r.statistics.total, 0);
    const criticalTotal = scanReports.reduce((sum, r) => sum + r.statistics.critical, 0);
    const seriousTotal = scanReports.reduce((sum, r) => sum + r.statistics.serious, 0);
    const moderateTotal = scanReports.reduce((sum, r) => sum + r.statistics.moderate, 0);
    const minorTotal = scanReports.reduce((sum, r) => sum + r.statistics.minor, 0);
    // Rule counts — used in headers/badges (matches rendered violation cards)
    const totalRules = scanReports.reduce((sum, r) => sum + r.violations.length, 0);
    const companyName = this.extractCompanyName(batchReport);
    const reportTitle = companyName ? `${companyName} Accessibility Test Report` : 'Accessibility Test Report';

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${reportTitle}</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Lexend:wght@300;400;600;700&display=swap" rel="stylesheet">
  <style>
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }

    body {
      font-family: 'Lexend', sans-serif;
      font-weight: 400;
      line-height: 1.6;
      color: #444444;
      background: #F0E8E4;
      padding: 2rem;
      max-width: 1100px;
      margin: 0 auto;
    }

    .container {
      background: transparent;
      padding: 0;
    }

    h1 {
      color: #4C3832;
      margin-bottom: 0.5rem;
      font-size: 2rem;
      font-weight: 400;
      letter-spacing: 0.5px;
      padding-bottom: 1rem;
    }

    h2 {
      color: #4C3832;
      margin-top: 2rem;
      margin-bottom: 1rem;
      font-size: 1.5rem;
      font-weight: 400;
      padding-bottom: 0.5rem;
    }

    h3 {
      color: #4C3832;
      margin-top: 1.5rem;
      margin-bottom: 1rem;
      font-size: 1.25rem;
      font-weight: 400;
    }

    h4 {
      color: #4C3832;
      margin-top: 1.5rem;
      margin-bottom: 0.5rem;
      font-size: 1rem;
      font-weight: 700;
    }

    .meta {
      color: #444444;
      font-size: 0.95rem;
      margin-bottom: 2rem;
    }

    .summary {
      margin: 1.5rem 0;
      background: #FFFFFF;
      border-radius: 8px;
      padding: 24px;
    }

    .summary table {
      width: 100%;
      border-collapse: collapse;
    }

    .summary td {
      padding: 0.5rem 0;
      border-bottom: 1px solid #F0E8E4;
      font-size: 1rem;
    }

    .summary td:first-child {
      font-weight: 700;
      width: 60%;
      color: #444444;
    }

    .summary td:last-child {
      text-align: right;
      font-weight: 700;
      color: #4C3832;
    }

    .summary tr:last-child td {
      border-bottom: none;
    }

    .page-result {
      background: #FFFFFF;
      border-radius: 8px;
      padding: 24px;
      margin-bottom: 1.5rem;
      page-break-inside: avoid;
    }

    .page-header {
      margin-bottom: 1.5rem;
      padding-bottom: 1rem;
      border-bottom: 1px solid #F0E8E4;
    }

    .page-url {
      color: #4C3832;
      font-weight: 600;
      font-size: 1.1rem;
      word-break: break-all;
      display: block;
      margin-bottom: 0.5rem;
    }

    .status-badge {
      display: inline-block;
      padding: 0.25rem 0.75rem;
      font-size: 0.85rem;
      font-weight: 700;
      border-radius: 4px;
    }

    .status-badge.warning {
      background: #C00F0C;
      color: #FFFFFF;
    }

    .status-badge.success {
      background: #117671;
      color: #FFFFFF;
    }

    .status-badge.error {
      background: #4C3832;
      color: #FFFFFF;
    }

    .violation-stats {
      margin: 1rem 0;
      padding: 1rem;
      background: #F0E8E4;
      border-radius: 8px;
    }

    .violation-stats table {
      width: 100%;
      border-collapse: collapse;
    }

    .violation-stats td {
      padding: 0.4rem 0;
      font-size: 1rem;
    }

    .violation-stats td:first-child {
      font-weight: 700;
      color: #444444;
    }

    .violation-stats td:last-child {
      text-align: right;
      font-weight: 700;
      color: #4C3832;
    }

    .violations-list {
      margin-top: 1.5rem;
    }

    .violation-item {
      background: #FFFFFF;
      border: 1px solid #F0E8E4;
      border-radius: 8px;
      padding: 1.5rem;
      margin-bottom: 1rem;
      page-break-inside: avoid;
    }

    .violation-item::before {
      content: attr(data-severity);
      display: inline-block;
      font-weight: 700;
      text-transform: uppercase;
      font-size: 0.7rem;
      padding: 0.2rem 0.6rem;
      border-radius: 4px;
      margin-bottom: 0.75rem;
      letter-spacing: 0.5px;
      background: #F0E8E4;
      color: #4C3832;
    }

    .violation-item[data-severity="CRITICAL"]::before {
      background: #C00F0C;
      color: #FFFFFF;
    }

    .violation-item[data-severity="SERIOUS"]::before {
      background: #AB406C;
      color: #FFFFFF;
    }

    .violation-title {
      font-weight: 700;
      color: #4C3832;
      margin-bottom: 0.5rem;
      font-size: 1.1rem;
    }

    .violation-description {
      color: #444444;
      font-size: 0.95rem;
      margin-bottom: 0.75rem;
      line-height: 1.6;
    }

    .section-label {
      font-weight: 700;
      font-size: 0.85rem;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      margin-top: 1rem;
      margin-bottom: 0.25rem;
      color: #4C3832;
    }

    .code-snippet {
      background: #F0E8E4;
      border: none;
      border-radius: 6px;
      padding: 0.75rem 1rem;
      font-family: 'Courier New', Courier, monospace;
      font-size: 0.85rem;
      line-height: 1.6;
      overflow-x: auto;
      white-space: pre-wrap;
      word-break: break-all;
      margin: 0.5rem 0;
      color: #4C3832;
    }

    .css-selector {
      font-family: 'Courier New', Courier, monospace;
      font-size: 0.8rem;
      color: #444444;
      margin-top: 0.25rem;
    }

    .violation-screenshot {
      display: block;
      margin: 0.6rem 0 0.25rem 0;
      max-width: 480px;
      max-height: 320px;
      border: 1px solid #D8C7BF;
      border-radius: 6px;
      background: #fff;
    }

    .screenshot-context {
      margin: 0.25rem 0 0.5rem 0;
      font-size: 0.8rem;
    }

    .screenshot-context > summary {
      cursor: pointer;
      color: #4C3832;
      font-weight: 600;
    }

    .violation-screenshot-context {
      display: block;
      margin-top: 0.5rem;
      max-width: 640px;
      max-height: 420px;
      border: 1px solid #D8C7BF;
      border-radius: 6px;
      background: #fff;
    }

    .screenshot-note {
      margin: 0.4rem 0 0.5rem 0;
      font-size: 0.78rem;
      font-style: italic;
      color: #8A7A72;
    }

    .instance-count {
      font-size: 0.95rem;
      margin: 0.25rem 0;
      color: #444444;
    }

    .instance-count strong {
      font-size: 1.1rem;
      color: #4C3832;
    }

    .fix-guidance {
      margin-top: 0.5rem;
    }

    .fix-guidance p {
      font-size: 0.95rem;
      line-height: 1.6;
      margin-bottom: 0.5rem;
      color: #444444;
    }

    .error-line {
      display: flex;
      align-items: baseline;
      gap: 0.75rem;
      margin-bottom: 0.75rem;
      flex-wrap: wrap;
    }

    .error-line .error-text {
      font-weight: 700;
      color: #4C3832;
      font-size: 1rem;
      line-height: 1.6;
    }

    .count-badge {
      display: inline-block;
      background: #4C3832;
      color: #FFFFFF;
      font-size: 0.7rem;
      font-weight: 700;
      padding: 0.15rem 0.6rem;
      border-radius: 4px;
      white-space: nowrap;
    }

    .code-block-label {
      font-weight: 700;
      font-size: 0.8rem;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      margin-top: 1rem;
      margin-bottom: 0.25rem;
    }

    .code-block-label.error-label {
      color: #C00F0C;
    }

    .code-block-label.fix-label {
      color: #117671;
    }

    .code-snippet.error-code {
      border-left: 3px solid #C00F0C;
    }

    .code-snippet.fix-code {
      border-left: 3px solid #117671;
    }

    .fix-explanation {
      font-size: 0.9rem;
      color: #444444;
      margin-top: 0.5rem;
      line-height: 1.6;
      font-style: italic;
    }

    .wcag-badge {
      display: inline-block;
      background: #F0E8E4;
      color: #4C3832;
      padding: 0.2rem 0.5rem;
      border-radius: 4px;
      font-size: 0.8rem;
      font-weight: 700;
      margin-right: 0.5rem;
      margin-bottom: 0.25rem;
    }

    .technique-item {
      border-left: 3px solid #117671;
      padding: 0.5rem 0.75rem;
      margin: 0.5rem 0;
      font-size: 0.9rem;
      line-height: 1.6;
    }

    .technique-id {
      font-weight: 700;
      font-family: 'Courier New', Courier, monospace;
      font-size: 0.85rem;
      color: #4C3832;
    }

    .error-message {
      background: #F0E8E4;
      border-left: 3px solid #C00F0C;
      border-radius: 6px;
      color: #4C3832;
      padding: 1rem;
      margin-top: 1rem;
      font-weight: 700;
    }

    .no-violations {
      text-align: center;
      padding: 2rem;
      color: #117671;
      font-size: 1.1rem;
      font-weight: 600;
      background: #F0E8E4;
      border-radius: 8px;
    }

    .viewport-tabs {
      display: flex;
      gap: 0;
      margin-bottom: 1.5rem;
      border-bottom: 2px solid #F0E8E4;
    }

    .viewport-tab {
      padding: 0.5rem 1.25rem;
      font-family: 'Lexend', sans-serif;
      font-size: 0.85rem;
      font-weight: 600;
      color: #4C3832;
      background: transparent;
      border: none;
      border-bottom: 2px solid transparent;
      margin-bottom: -2px;
      cursor: pointer;
      transition: all 0.15s ease;
    }

    .viewport-tab:hover {
      color: #117671;
    }

    .viewport-tab.active {
      color: #117671;
      border-bottom-color: #117671;
    }

    .viewport-tab .tab-count {
      display: inline-block;
      background: #F0E8E4;
      color: #4C3832;
      font-size: 0.7rem;
      font-weight: 700;
      padding: 0.1rem 0.45rem;
      border-radius: 4px;
      margin-left: 0.4rem;
    }

    .viewport-tab.active .tab-count {
      background: #117671;
      color: #FFFFFF;
    }

    .viewport-panel {
      display: none;
    }

    .viewport-panel.active {
      display: block;
    }

    .insight-label {
      font-weight: 700;
      font-size: 0.8rem;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: #4C3832;
      margin-bottom: 0.25rem;
    }

    .technique-item {
      border-left: 3px solid #117671;
      padding: 0.5rem 0.75rem;
      margin: 0.5rem 0;
      font-size: 0.9rem;
      line-height: 1.6;
    }

    .failure-item {
      border-left: 3px solid #C00F0C;
      padding: 0.5rem 0.75rem;
      margin: 0.5rem 0;
      font-size: 0.9rem;
      line-height: 1.6;
    }

    .technique-id {
      font-weight: 700;
      font-family: 'Courier New', Courier, monospace;
      font-size: 0.85rem;
      color: #117671;
    }

    .failure-id {
      font-weight: 700;
      font-family: 'Courier New', Courier, monospace;
      font-size: 0.85rem;
      color: #C00F0C;
    }

    .corpus-code {
      background: #F0E8E4;
      border-radius: 6px;
      padding: 0.5rem 0.75rem;
      font-family: 'Courier New', Courier, monospace;
      font-size: 0.8rem;
      line-height: 1.5;
      overflow-x: auto;
      white-space: pre-wrap;
      word-break: break-all;
      margin-top: 0.5rem;
      color: #4C3832;
    }

    .see-above-ref {
      font-size: 0.9rem;
      color: #117671;
      font-style: italic;
    }

    .see-above-ref a {
      color: #117671;
      text-decoration: underline;
      text-decoration-style: dotted;
    }

    .violation-num {
      font-weight: 700;
      font-size: 0.85rem;
      color: #4C3832;
      margin-right: 0.25rem;
    }

    @media print {
      body {
        background: white;
        padding: 0;
        max-width: 100%;
      }

      .container {
        padding: 1rem;
      }

      .page-result {
        page-break-after: always;
      }
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>${reportTitle}</h1>
    <div class="meta">
      Generated: ${new Date(batchReport.timestamp).toLocaleString()}<br>
      Total URLs Tested: ${batchReport.totalUrls}
    </div>

    <div class="summary">
      <table>
        <tr>
          <td>Total URLs Tested</td>
          <td>${batchReport.totalUrls}</td>
        </tr>
        <tr>
          <td>Successful Scans</td>
          <td>${batchReport.successful}</td>
        </tr>
        ${batchReport.failed > 0 ? `
        <tr>
          <td>Failed Scans</td>
          <td>${batchReport.failed}</td>
        </tr>
        ` : ''}
        <tr>
          <td>Total Violations Found</td>
          <td>${totalRules}</td>
        </tr>
        <tr>
          <td>Total Instances</td>
          <td>${totalInstances}</td>
        </tr>
      </table>
    </div>

    ${totalInstances > 0 ? `
    <h2>Overall Statistics by Severity</h2>
    <div class="violation-stats">
      <table>
        ${criticalTotal > 0 ? `
        <tr>
          <td>Critical</td>
          <td>${criticalTotal}</td>
        </tr>
        ` : ''}
        ${seriousTotal > 0 ? `
        <tr>
          <td>Serious</td>
          <td>${seriousTotal}</td>
        </tr>
        ` : ''}
        ${moderateTotal > 0 ? `
        <tr>
          <td>Moderate</td>
          <td>${moderateTotal}</td>
        </tr>
        ` : ''}
        ${minorTotal > 0 ? `
        <tr>
          <td>Minor</td>
          <td>${minorTotal}</td>
        </tr>
        ` : ''}
      </table>
    </div>
    ` : ''}

    <h2>Individual Page Results</h2>

    ${scanReports.map((report, i) => this.buildPageSection(report, i)).join('\n')}

    ${batchReport.results.filter(r => !r.success).map(result => `
    <div class="page-result">
      <div class="page-header">
        <div class="page-url">${result.url}</div>
        <div class="status-badge error">Failed</div>
      </div>
      <div class="error-message">
        <strong>Error:</strong> ${result.error || 'Unknown error'}
      </div>
    </div>
    `).join('\n')}
  </div>
  <script>
    document.addEventListener('click', function(e) {
      var btn = e.target.closest('.viewport-tab');
      if (!btn) return;
      var pageId = btn.getAttribute('data-page');
      var viewport = btn.getAttribute('data-viewport');
      if (!pageId || !viewport) return;
      var container = document.getElementById(pageId);
      if (!container) return;
      container.querySelectorAll('.viewport-panel').forEach(function(p) { p.classList.remove('active'); });
      container.querySelectorAll('.viewport-tab').forEach(function(t) { t.classList.remove('active'); });
      var panel = document.getElementById(pageId + '-' + viewport);
      if (panel) panel.classList.add('active');
      btn.classList.add('active');
    });
  </script>
</body>
</html>`;
  }

  private static buildPageSection(report: ScanReport, index?: number): string {
    const hasViolations = report.statistics.total > 0;
    const ruleCount = report.violations.length;
    const status = hasViolations ? 'warning' : 'success';
    const pageId = `page-${index ?? 0}`;

    // Track which violation IDs have had full guidance rendered (for cross-viewport dedup)
    const guidanceRendered = new Set<string>();

    // Number violations: collect unique IDs across viewports in order of first appearance
    const violationIndex = new Map<string, number>();
    let vNum = 1;
    if (report.viewportResults && report.viewportResults.length > 0) {
      for (const vr of report.viewportResults) {
        for (const v of vr.violations) {
          if (!violationIndex.has(v.id)) {
            violationIndex.set(v.id, vNum++);
          }
        }
      }
    } else if (report.violations) {
      for (const v of report.violations) {
        if (!violationIndex.has(v.id)) {
          violationIndex.set(v.id, vNum++);
        }
      }
    }

    // If we have per-viewport data, render tabs
    if (report.viewportResults && report.viewportResults.length > 0) {
      return `
    <div id="${pageId}" class="page-result">
      <div class="page-header">
        <div class="page-url">${report.metadata.url}</div>
        <div class="status-badge ${status}">
          ${hasViolations ? `${ruleCount} Violations &middot; ${report.statistics.total} Instances` : 'Passed'}
        </div>
      </div>

      ${hasViolations ? `
      <div class="viewport-tabs">
        ${report.viewportResults.map((vr, i) => `
          <button type="button" id="${pageId}-tab-${vr.viewport}" class="viewport-tab${i === 0 ? ' active' : ''}" data-page="${pageId}" data-viewport="${vr.viewport}">
            ${vr.viewport.charAt(0).toUpperCase() + vr.viewport.slice(1)}
            <span class="tab-count">${vr.statistics.total}</span>
          </button>
        `).join('')}
      </div>

      ${report.viewportResults.map((vr, i) => `
        <div id="${pageId}-${vr.viewport}" class="viewport-panel${i === 0 ? ' active' : ''}">
          ${vr.statistics.total > 0 ? `
          <div class="violation-stats">
            <table>
              ${vr.statistics.critical > 0 ? `<tr><td>Critical Instances</td><td>${vr.statistics.critical}</td></tr>` : ''}
              ${vr.statistics.serious > 0 ? `<tr><td>Serious Instances</td><td>${vr.statistics.serious}</td></tr>` : ''}
              ${vr.statistics.moderate > 0 ? `<tr><td>Moderate Instances</td><td>${vr.statistics.moderate}</td></tr>` : ''}
              ${vr.statistics.minor > 0 ? `<tr><td>Minor Instances</td><td>${vr.statistics.minor}</td></tr>` : ''}
            </table>
          </div>

          <div class="violations-list">
            ${vr.violations.map(v => this.buildViolationCard(v, violationIndex, guidanceRendered, report.insights?.violationGuidance, pageId, vr.viewport)).join('')}
          </div>
          ` : `
          <div class="no-violations">
            No violations at ${vr.width}x${vr.height}.
          </div>
          `}
        </div>
      `).join('')}
      ` : `
      <div class="no-violations">
        No accessibility violations found.
      </div>
      `}
    </div>
    `;
    }

    // Fallback: no viewport data (old scan format)
    return `
    <div class="page-result">
      <div class="page-header">
        <div class="page-url">${report.metadata.url}</div>
        <div class="status-badge ${status}">
          ${hasViolations ? `${ruleCount} Violations &middot; ${report.statistics.total} Instances` : 'Passed'}
        </div>
      </div>

      ${hasViolations ? `
      <div class="violation-stats">
        <table>
          ${report.statistics.critical > 0 ? `<tr><td>Critical Instances</td><td>${report.statistics.critical}</td></tr>` : ''}
          ${report.statistics.serious > 0 ? `<tr><td>Serious Instances</td><td>${report.statistics.serious}</td></tr>` : ''}
          ${report.statistics.moderate > 0 ? `<tr><td>Moderate Instances</td><td>${report.statistics.moderate}</td></tr>` : ''}
          ${report.statistics.minor > 0 ? `<tr><td>Minor Instances</td><td>${report.statistics.minor}</td></tr>` : ''}
        </table>
      </div>

      <div class="violations-list">
        ${report.violations.map(v => this.buildViolationCard(v, violationIndex, guidanceRendered, report.insights?.violationGuidance, pageId)).join('')}
      </div>
      ` : `
      <div class="no-violations">
        No accessibility violations found.
      </div>
      `}
    </div>
    `;
  }

  /**
   * Build a violation card with inline HOW TO FIX per the PRD.
   *
   * First viewport to render a given violation ID gets full guidance.
   * Subsequent viewports get a compact "See Violation N in {first} tab" reference.
   */
  private static buildViolationCard(
    violation: Violation,
    violationIndex: Map<string, number>,
    guidanceRendered: Set<string>,
    violationGuidance?: ViolationGuidance[],
    pageId?: string,
    viewport?: string
  ): string {
    const nodeCount = violation.nodes?.length || 0;
    const firstNode = violation.nodes?.[0];
    const htmlSnippet = firstNode?.html || '';
    const cssSelector = firstNode?.target
      ? (Array.isArray(firstNode.target) ? firstNode.target.join(' > ') : String(firstNode.target))
      : '';

    const errorText = violation.description || violation.help || violation.id;
    const vNum = violationIndex.get(violation.id) ?? 0;
    const pid = pageId || 'page-0';
    const anchorId = `${pid}-v-${violation.id}`;

    // Element screenshots (SME Issue 1). Desktop-only capture means repeat
    // (non-first) viewport branches have no node.screenshot → this is empty and
    // naturally omitted there. Crop answers "what's broken?" up top; the context
    // shot sits behind a <details> so first open stays light.
    const shot = firstNode?.screenshot;
    let screenshotHtml = '';
    if (shot && (shot.crop || shot.context || shot.note)) {
      const alt = this.escapeHtml(`Element in violation: ${firstNode?.failureSummary || errorText}`);
      // Main image: prefer the tight crop, fall back to the context shot so a
      // page-level issue (single full-page shot, no crop) still renders an image.
      const mainSrc = this.resolveShotSrc(shot.crop ?? shot.context);
      // Only offer the "page context" expander when a distinct context shot
      // exists alongside the crop (else it would just duplicate the main image).
      const contextSrc = shot.crop && shot.context ? this.resolveShotSrc(shot.context) : '';
      // Caption: explains a missing/partial capture (metadata element, hidden at
      // desktop, tracking pixel, page-level) so a blank is never ambiguous.
      const note = shot.note ? `<div class="screenshot-note">${this.escapeHtml(shot.note)}</div>` : '';
      screenshotHtml = `
          ${mainSrc ? `<img class="violation-screenshot" src="${mainSrc}" alt="${alt}" loading="lazy">` : ''}
          ${contextSrc ? `<details class="screenshot-context">
            <summary>Show page context</summary>
            <img class="violation-screenshot-context" src="${contextSrc}" alt="${alt} (in page context)" loading="lazy">
          </details>` : ''}
          ${note}
      `;
    }

    // Cross-viewport dedup: if already rendered, show compact reference
    const alreadyRendered = guidanceRendered.has(violation.id);
    if (!alreadyRendered) {
      guidanceRendered.add(violation.id);
    }

    return `
        <div id="${alreadyRendered ? '' : anchorId}" class="violation-item" data-severity="${(violation.impact || 'minor').toUpperCase()}">

          <div class="error-line">
            <span class="violation-num">Violation ${vNum}:</span>
            <span class="error-text">${this.escapeHtml(errorText)}</span>
            <span class="count-badge">${nodeCount} instance${nodeCount !== 1 ? 's' : ''}</span>
          </div>

          ${htmlSnippet ? `
          <div class="code-block-label error-label">Error Snippet</div>
          <pre class="code-snippet error-code"><code>${this.escapeHtml(htmlSnippet)}</code></pre>
          ` : ''}
          ${cssSelector ? `<div class="css-selector">Selector: ${this.escapeHtml(cssSelector)}</div>` : ''}
          ${screenshotHtml}

          ${alreadyRendered
            ? `<div class="section-label">How to Fix</div>
               <div class="fix-guidance">
                 <div class="see-above-ref">Same as <a href="#${anchorId}">Violation ${vNum}</a> in the first viewport tab above.</div>
               </div>`
            : `<div class="section-label">How to Fix</div>
               <div class="fix-guidance">
                 ${this.buildInlineGuidance(violation, violationGuidance)}
               </div>`
          }
        </div>
    `;
  }

  /**
   * Build inline HOW TO FIX content for a violation card.
   *
   * Per the PRD:
   * - Start with primary WCAG criterion badge
   * - 1-2 relevant techniques with brief descriptions
   * - 1 concise code example per technique
   * - No off-topic techniques
   */
  private static buildInlineGuidance(
    violation: Violation,
    violationGuidance?: ViolationGuidance[],
    _corpusInsights?: CorpusInsight[]
  ): string {
    const parts: string[] = [];

    // Use targeted per-violation guidance (deterministic, from axe_mapper + wcag_index)
    if (violationGuidance && violationGuidance.length > 0) {
      const guidance = violationGuidance.find(vg => vg.violationId === violation.id);
      if (guidance) {
        // Fix-first ordering (SME Issue 2): lead with what's wrong → the fix,
        // and keep the educational "why" available below for those who want it.

        // 1. Suggested fix (AI-generated) — the actionable answer, on top.
        //    Explained by the templated why_fix_works rationale, falling back to
        //    fixExplanation only when no rationale exists. The `if (fixHtml)`
        //    guard means an abstain (no fix) renders nothing here.
        if (guidance.fixHtml) {
          const fixExplain = guidance.rationale?.why_fix_works?.text || guidance.fixExplanation;
          parts.push(`
              <div class="suggested-fix" style="margin-top:0.75rem;padding:0.75rem;background:#f0fdf4;border:1px solid #86efac;border-radius:6px">
                <h4 style="margin:0 0 0.5rem 0;color:#166534;font-size:0.85rem">SUGGESTED FIX</h4>
                <pre class="corpus-code" style="background:#fff;border:1px solid #d1d5db"><code>${this.escapeHtml(guidance.fixHtml)}</code></pre>
                ${fixExplain ? `<p style="margin:0.5rem 0 0 0;font-size:0.8rem;color:#4b5563">${this.escapeHtml(fixExplain)}</p>` : ''}
              </div>
          `);
        }

        // 2. Confidence badge (grounded / best-effort / abstain) — directly
        //    under the fix. Grounded fixes came off a curated edge + templated
        //    rationale; best-effort/abstain signal review before shipping.
        if (guidance.confidence) {
          parts.push(this.buildConfidenceBadge(guidance.confidence));
        }

        // 3. WCAG criterion badges
        for (const sc of guidance.criteria) {
          parts.push(`<span class="wcag-badge">WCAG ${this.escapeHtml(sc.sc_num)}: ${this.escapeHtml(sc.title)}${sc.level ? ` (Level ${this.escapeHtml(sc.level)})` : ''}</span>`);
        }

        // 4. WHY IT FAILS — templated/synthesized rationale (never raw chunk text).
        if (guidance.rationale?.why_it_fails?.text) {
          parts.push(`
              <div class="rationale-why" style="margin-top:0.5rem;font-size:0.85rem;color:#374151">
                <strong style="color:#991b1b">Why it fails:</strong> ${this.escapeHtml(guidance.rationale.why_it_fails.text)}
              </div>
          `);
        }

        // 5. Technique references — id/title + code example only. The raw chunk
        //    description is intentionally NOT rendered as prose (that dump is the
        //    exact defect the rationale ladder replaces); code snippets are kept
        //    as actionable reference patterns.
        for (const technique of guidance.techniques.slice(0, 2)) {
          parts.push(`
              <div class="technique-item">
                ${technique.technique_id ? `<span class="technique-id">${this.escapeHtml(technique.technique_id)}</span>` : ''}${technique.title ? `: ${this.escapeHtml(technique.title)}` : ''}
                ${technique.code_snippet ? `<pre class="corpus-code"><code>${this.escapeHtml(technique.code_snippet)}</code></pre>` : ''}
              </div>
          `);
        }

        // 6. Failure references — id/title only. Like techniques, the raw chunk
        //    description is not surfaced as prose.
        for (const failure of guidance.failures.slice(0, 1)) {
          parts.push(`
              <div class="failure-item">
                ${failure.failure_id ? `<span class="failure-id">${this.escapeHtml(failure.failure_id)}</span>` : ''}${failure.title ? `: ${this.escapeHtml(failure.title)}` : ''}
              </div>
          `);
        }
      }
    }

    // Fallback: violation's own help text (always concise)
    if (parts.length === 0 && violation.help) {
      parts.push(`<p>${this.escapeHtml(violation.help)}</p>`);
    }

    return parts.length > 0 ? parts.join('\n') : '<p>Review this violation against the relevant WCAG success criteria.</p>';
  }

  /**
   * Render the confidence tier as a colored badge. Grounded = green (trusted
   * curated edge), best-effort = amber (review before shipping), abstain = grey
   * (no grounded fix — manual review required).
   */
  private static buildConfidenceBadge(confidence: Confidence): string {
    const styles: Record<string, { bg: string; fg: string; label: string }> = {
      grounded: { bg: '#dcfce7', fg: '#166534', label: 'High' },
      best_effort: { bg: '#fef3c7', fg: '#92400e', label: 'Medium' },
      abstain: { bg: '#e5e7eb', fg: '#374151', label: 'Needs Review' },
    };
    const s = styles[confidence.tier] ?? styles.abstain;
    // "Confidence Score:" prefixes the scored tiers; abstain's "Needs Review"
    // is a status, so it stands alone (and skips the redundant review suffix).
    const isScored = confidence.tier !== 'abstain';
    const prefix = isScored ? 'Confidence Score: ' : '';
    const review = confidence.review_recommended && isScored ? ' · review recommended' : '';
    return `<span class="confidence-badge" style="display:inline-block;margin:0.25rem 0;padding:0.15rem 0.5rem;border-radius:4px;font-size:0.75rem;font-weight:600;background:${s.bg};color:${s.fg}">${prefix}${s.label}${this.escapeHtml(review)}</span>`;
  }

  private static escapeHtml(text: string): string {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }
}

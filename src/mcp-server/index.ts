#!/usr/bin/env node

/**
 * Aether WCAG Scanner — MCP Server
 *
 * Exposes accessibility scanning, fix generation, and static analysis tools
 * to Claude Code via the Model Context Protocol (stdio transport).
 *
 * Start: node --loader tsx src/mcp-server/index.ts
 */

// Auto-load a gitignored .env so testers set ALLCHEMY_INSIGHT_URL /
// GOOGLE_APPLICATION_CREDENTIALS / ALLCHEMY_API_KEY once in a file instead of
// exporting every shell session. Must run before anything reads env.
//
// Precedence (highest first):
//   1. variables already exported in the shell / by the MCP host
//   2. <package root>/.env  — the plugin's own config, two levels up from
//      src/mcp-server (same depth under dist/)
//   3. <cwd>/.env          — the repository the developer is scanning
// dotenv never overrides an already-set variable, so loading the package-root
// file first means a scanned repo's .env can fill gaps but can NOT redirect the
// insights URL or swap the credentials/API key.
import { config as loadDotenv } from 'dotenv';
import { dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGE_ROOT = resolvePath(dirname(fileURLToPath(import.meta.url)), '..', '..');
// Claude Code substitutes an UNSET plugin userConfig value as an empty string, so
// the plugin's .mcp.json hands us ALLCHEMY_API_KEY="" when the user skipped the
// prompt. dotenv treats any present key as "already set" and would then never
// read the project's .env. Treat empty as unset so the documented .env fallback works.
for (const name of ['ALLCHEMY_API_KEY', 'ALLCHEMY_INSIGHT_URL']) {
  if (process.env[name] !== undefined && process.env[name].trim() === '') delete process.env[name];
}
// Remember where ALLCHEMY_API_KEY came from so the startup line below can say so —
// the single most common support question is "which key is the plugin using?".
const apiKeySource: string = process.env.ALLCHEMY_API_KEY ? 'shell environment' : '';
const PACKAGE_ENV = resolvePath(PACKAGE_ROOT, '.env');
const CWD_ENV = resolvePath(process.env.AETHER_PROJECT_CWD || process.cwd(), '.env');
const beforePackage = process.env.ALLCHEMY_API_KEY;
loadDotenv({ path: PACKAGE_ENV, override: false, quiet: true });
const beforeCwd = process.env.ALLCHEMY_API_KEY;
loadDotenv({ path: CWD_ENV, override: false, quiet: true });
const API_KEY_SOURCE =
  apiKeySource ||
  (process.env.ALLCHEMY_API_KEY && !beforePackage && beforeCwd ? PACKAGE_ENV : '') ||
  (process.env.ALLCHEMY_API_KEY && !beforeCwd ? CWD_ENV : '') ||
  'not set';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerGetFix } from './tools/get-fix.ts';
import { registerScanAndFix } from './tools/scan-and-fix.ts';
import { registerCheckHtml } from './tools/check-html.ts';
import { registerVerifyFix } from './tools/verify-fix.ts';
import { registerSubmitFeedback } from './tools/submit-feedback.ts';
import { shutdownScanner } from './services/scanner-manager.ts';
import { getInsightApiUrl, isLoopbackUrl } from '../concepts/a11y-scanner/insight-client.ts';

/**
 * Server instructions, delivered to every MCP client in the `initialize` result.
 * Claude Code additionally ships the /wcag-scan skill; other clients (Codex, Cursor,
 * Windsurf, Gemini CLI …) only see this text and the tool descriptions, so the
 * workflow rules the skill enforces are restated here. Keep in sync with
 * skills/wcag-scan/SKILL.md and docs/marketplace-draft/AGENTS.md.
 */
export const SERVER_INSTRUCTIONS = [
  'Aether scans web pages for WCAG 2.1 AA violations with a real browser (Playwright + axe-core) and returns grounded, browser-verified fix suggestions.',
  '',
  'WHEN TO USE: for any question about the accessibility, a11y or WCAG conformance of a URL, call aether_scan_and_fix FIRST. Do not fetch the page HTML yourself and reason about it; fetched HTML misses rendered state, contrast, keyboard behaviour and SPA routes.',
  '',
  'WORKFLOW: (1) aether_scan_and_fix with the URL (default maxFixes:10 also generates fixes; use maxFixes:0 only when the user explicitly wants a scan with no fixes). For an HTML snippet use aether_check_html. For a single-page app pass the `spa` block. (2) Present violations grouped by severity: critical, serious, moderate, minor. (3) fixHtml is a SUGGESTION; the tools never modify files. If you can edit the source, apply the fix and then verify; if the URL is a remote site you do not own, present fixHtml as a recommendation and say the developer must apply it. (4) Verify with the `verification` block already attached to each fix, or call aether_verify_fix; report targetCleared, newViolations, resolvedViolations and complianceDelta verbatim. (5) Never say something is "fixed" unless you changed source AND verification shows targetCleared:true.',
  '',
  'REPORT: the fixes are the deliverable, not the counts. Include every severity (critical, serious, moderate, minor). For EACH generated fix show: the target element, the change in one line (e.g. "background #00a2c7 → #00819f" or "add aria-label"), source (rag/template), confidence.tier, and the verification fields (targetCleared, newViolations, complianceDelta) or the verification note. Group fixes that share one root cause (e.g. one colour token) and say so.',
  '',
  'HONESTY: relay tool output as-is. Do not invent quality or confidence claims. Each fix carries source (rag = cloud engine, template = local fallback), fixTier, confidence.tier (grounded | best_effort | abstain) and rationale; show them. An abstain means no grounded fix exists; say so rather than inventing one. A `note` on a verification (e.g. contrast cannot be measured on an isolated snippet) must be relayed.',
  '',
  'KEY: ALLCHEMY_API_KEY enables cloud fixes (source:rag). Without it the scanner still runs and returns template fixes. Keys: https://beta.allchemylabs.ai',
].join('\n');

const server = new McpServer(
  {
    name: 'aether-wcag-scanner',
    version: '1.0.2',
    description:
      'WCAG 2.1 AA accessibility scanner with RAG-powered fix generation. ' +
      'Scans live URLs via Playwright + axe-core across viewports, returns ' +
      'violations paired with corpus-backed fixes and WCAG technique references.',
  },
  { instructions: SERVER_INSTRUCTIONS },
);

// Hero tool — scan (single page or SPA) + RAG-powered fixes
registerScanAndFix(server);

// RAG-powered fix / explanation for a single violation
registerGetFix(server);

// Static HTML analysis (no browser)
registerCheckHtml(server);

// Deterministic fix verification (real browser + axe)
registerVerifyFix(server);

// Developer feedback on a Grounded Artifact (learning loop, docs §6)
registerSubmitFeedback(server);

// Graceful shutdown
async function shutdown(): Promise<void> {
  await shutdownScanner();
  await server.close();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// Fail loudly (to stderr — stdout must stay clean for JSON-RPC) on a cleartext
// non-loopback insights URL: insight-client refuses to send the API key there,
// so every RAG call would fall back to templates. Also warn when the cloud URL
// is configured but no API key is present (RAG calls will 401 → templates).
try {
  const insightUrl = getInsightApiUrl();
  // One startup line for support/debugging: which endpoint, which key (prefix
  // only — the server logs the same 8 chars), and where the key was read from.
  const keyPrefix = process.env.ALLCHEMY_API_KEY ? process.env.ALLCHEMY_API_KEY.slice(0, 8) + '…' : 'none';
  console.error(
    `[aether] insights endpoint=${insightUrl} apiKey=${keyPrefix} source=${API_KEY_SOURCE} ` +
      `iamToken=${process.env.GOOGLE_APPLICATION_CREDENTIALS ? 'service-account key' : 'off'}`,
  );
  if (!isLoopbackUrl(insightUrl) && !process.env.ALLCHEMY_API_KEY) {
    console.error(
      '[aether] ALLCHEMY_INSIGHT_URL points at cloud but ALLCHEMY_API_KEY is unset — ' +
        'RAG fixes will 401 and fall back to templates. ' +
        'Get a key at https://beta.allchemylabs.ai and set ALLCHEMY_API_KEY (see README).',
    );
  }
} catch (err) {
  console.error(`[aether] ${(err as Error).message} RAG fixes are disabled until this is corrected.`);
}

// Start
const transport = new StdioServerTransport();
await server.connect(transport);

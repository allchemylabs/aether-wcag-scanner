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

const server = new McpServer({
  name: 'aether-wcag-scanner',
  version: '1.0.0',
  description:
    'WCAG 2.1 AA accessibility scanner with RAG-powered fix generation. ' +
    'Scans live URLs via Playwright + axe-core across viewports, returns ' +
    'violations paired with corpus-backed fixes and WCAG technique references.',
});

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

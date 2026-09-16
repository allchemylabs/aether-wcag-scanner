#!/usr/bin/env node
/**
 * MCP server launcher for the aether-wcag-scanner plugin (what .mcp.json runs).
 *
 * 1. Makes sure node_modules is installed (see ensure-deps.js). Chromium is NOT
 *    downloaded here — Claude Code gives the server ~60 s to answer the MCP
 *    handshake, so the browser is fetched lazily on the first scan (and pre-warmed
 *    by the SessionStart hook).
 * 2. Starts the TypeScript MCP server via tsx with the plugin directory as cwd so
 *    `--import tsx` and every package import resolve from the plugin's node_modules.
 *
 * The user's project directory (Claude Code's cwd) is passed through as
 * AETHER_PROJECT_CWD so the server can read that project's .env for ALLCHEMY_API_KEY,
 * exactly as the docs promise. stdout is left untouched: it is the JSON-RPC channel.
 */
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { ensureNodeModules, PLUGIN_ROOT } from './ensure-deps.js';

try {
  ensureNodeModules();
} catch (err) {
  process.stderr.write(`[aether-wcag-scanner] cannot start: ${err?.message ?? err}\n`);
  process.exit(1);
}

const child = spawn(
  process.execPath,
  ['--import', 'tsx', join(PLUGIN_ROOT, 'src', 'mcp-server', 'index.ts')],
  {
    cwd: PLUGIN_ROOT,
    stdio: 'inherit',
    env: { ...process.env, AETHER_PROJECT_CWD: process.env.AETHER_PROJECT_CWD || process.cwd() },
  },
);
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => child.kill(sig));
}
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));

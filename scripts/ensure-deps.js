#!/usr/bin/env node
/**
 * SessionStart hook: install the plugin's runtime dependencies into the
 * plugin's persistent data dir (CLAUDE_PLUGIN_DATA) the first time the plugin
 * runs, then no-op on subsequent sessions.
 *
 * Why CLAUDE_PLUGIN_DATA and not CLAUDE_PLUGIN_ROOT:
 *   - CLAUDE_PLUGIN_ROOT is the (read-only) installed plugin tree.
 *   - CLAUDE_PLUGIN_DATA is the writable per-plugin data dir; .mcp.json points
 *     NODE_PATH there so the MCP server resolves these deps.
 *
 * Idempotent: skips install when node_modules already contains a sentinel for
 * the current package version, so it does not re-run npm install every session.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const root = process.env.CLAUDE_PLUGIN_ROOT;
const dataDir = process.env.CLAUDE_PLUGIN_DATA;

if (!root || !dataDir) {
  // Not running inside the plugin runtime (e.g. local dev). Nothing to do.
  process.exit(0);
}

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const sentinel = join(dataDir, 'node_modules', `.aether-${pkg.version}.installed`);

if (existsSync(sentinel)) {
  process.exit(0);
}

mkdirSync(dataDir, { recursive: true });

try {
  // Install production deps from the plugin root's package.json into dataDir.
  execFileSync(
    'npm',
    ['install', '--omit=dev', '--prefix', dataDir, root],
    { stdio: 'inherit' },
  );
  // postinstall in package.json runs `playwright install chromium`.
  execFileSync('touch', [sentinel], { stdio: 'ignore' });
} catch (err) {
  console.error('[aether-wcag-scanner] dependency install failed:', err?.message ?? err);
  // Do not hard-fail the session; the MCP server will surface a clearer error.
  process.exit(0);
}

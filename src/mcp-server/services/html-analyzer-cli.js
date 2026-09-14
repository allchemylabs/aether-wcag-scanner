#!/usr/bin/env node

/**
 * HTML Analyzer CLI — Hook wrapper for post-edit accessibility checks.
 *
 * Called by the PostToolUse hook after Edit/Write operations. Claude Code hooks
 * receive a JSON payload on stdin; for Edit/Write the edited file lives at
 * `tool_input.file_path`. For manual use, a path may be passed as argv[2].
 *
 * Runs static heuristic checks on the file and, when issues are found, emits a
 * PostToolUse `additionalContext` JSON payload so the warnings reach Claude.
 *
 * Only checks files that look like HTML/JSX/TSX/Vue/Svelte templates.
 * This script is deliberately non-fatal: ANY failure exits 0 so the hook can
 * never block an edit, and a watchdog guarantees it finishes well inside the
 * hook's 10 s timeout.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, extname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Hard ceiling — exit quietly if anything (import, stdin) hangs.
setTimeout(() => process.exit(0), 8000).unref();

const TEMPLATE_EXTENSIONS = new Set([
  '.html', '.htm', '.jsx', '.tsx', '.vue', '.svelte', '.astro',
  '.hbs', '.handlebars', '.ejs', '.pug',
]);

/** Read the hook payload from stdin (JSON). Returns null if none / not JSON. */
function readStdinJson() {
  if (process.stdin.isTTY) return Promise.resolve(null);
  return new Promise((done) => {
    let data = '';
    const timer = setTimeout(() => done(null), 2000);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('error', () => { clearTimeout(timer); done(null); });
    process.stdin.on('end', () => {
      clearTimeout(timer);
      try { done(data.trim() ? JSON.parse(data) : null); } catch { done(null); }
    });
  });
}

/**
 * Load analyzeHtml. Prefer the compiled JS in dist/ (plain `node` can load it);
 * otherwise register tsx at runtime and import the TypeScript source. Returns
 * null when neither is available.
 */
async function loadAnalyzer() {
  const here = dirname(fileURLToPath(import.meta.url));
  const compiled = resolve(here, '../../../dist/mcp-server/services/html-analyzer.js');
  if (existsSync(compiled)) {
    try {
      const mod = await import(pathToFileURL(compiled).href);
      if (typeof mod.analyzeHtml === 'function') return mod.analyzeHtml;
    } catch { /* fall through */ }
  }
  try {
    const { register } = await import('tsx/esm/api');
    register();
    const mod = await import('./html-analyzer.ts');
    if (typeof mod.analyzeHtml === 'function') return mod.analyzeHtml;
  } catch { /* fall through */ }
  return null;
}

async function main() {
  // Manual invocation (argv) takes precedence; otherwise use the hook payload.
  let filePath = process.argv[2];
  if (!filePath) {
    const payload = await readStdinJson();
    const input = payload && typeof payload === 'object' ? payload.tool_input : null;
    filePath = input && typeof input.file_path === 'string' ? input.file_path : undefined;
  }
  if (!filePath) return;

  const ext = extname(filePath).toLowerCase();
  if (!TEMPLATE_EXTENSIONS.has(ext)) return;

  let content;
  try {
    content = readFileSync(filePath, 'utf-8');
  } catch {
    return; // File doesn't exist or can't be read — skip
  }

  const analyzeHtml = await loadAnalyzer();
  if (!analyzeHtml) return;

  const issues = analyzeHtml(content);
  if (!Array.isArray(issues) || issues.length === 0) return;

  const lines = ['Accessibility issues detected in the file you just edited:', ''];
  for (const issue of issues) {
    lines.push(`  [${String(issue.impact).toUpperCase()}] ${issue.ruleId}: ${issue.description}`);
    lines.push(`    HTML: ${String(issue.html).slice(0, 120)}`);
    lines.push(`    Fix:  ${issue.suggestion}`);
    lines.push('');
  }
  lines.push(`Found ${issues.length} issue(s). Please fix these before continuing.`);

  // PostToolUse: plain stdout on exit 0 is NOT fed back to Claude; use the
  // structured hook output so the warnings land in Claude's context without
  // blocking the edit.
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PostToolUse',
      additionalContext: lines.join('\n'),
    },
  }) + '\n');
}

main().catch(() => { /* never fail the hook */ }).finally(() => process.exit(0));

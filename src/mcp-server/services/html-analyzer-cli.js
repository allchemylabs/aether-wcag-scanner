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
 * Only checks files that look like HTML/JSX/TSX/Vue/Svelte templates; anything
 * but .html/.htm is analysed in framework mode (components skipped, htmlFor,
 * {expressions} understood). For an Edit, only issues inside the inserted text
 * are reported, so untouched parts of a file don't re-surface on every edit
 * (#22); a Write reports the whole file.
 * This script is deliberately non-fatal: ANY failure exits 0 so the hook can
 * never block an edit, and a watchdog guarantees it finishes well inside the
 * hook's 10 s timeout.
 *
 * Opt-out (#23), checked first:
 *   1. AETHER_POSTEDIT_HOOK, when set, wins: 0 / off / false / no turns the check
 *      off, anything else turns it on. Settings-file "env" blocks reach hook
 *      processes, so a project's .claude/settings.local.json can switch the hook
 *      off (or back on) for one repo.
 *   2. Otherwise the plugin's post_edit_hook option: Claude Code exports it to
 *      hooks as CLAUDE_PLUGIN_OPTION_POST_EDIT_HOOK="true"/"false" (absent when
 *      never set, which means on). Set it with /plugin configure.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Hard ceiling — exit quietly if anything (import, stdin) hangs.
setTimeout(() => process.exit(0), 8000).unref();

const TEMPLATE_EXTENSIONS = new Set([
  '.html', '.htm', '.jsx', '.tsx', '.vue', '.svelte', '.astro',
  '.hbs', '.handlebars', '.ejs', '.pug',
]);
const PLAIN_HTML_EXTENSIONS = new Set(['.html', '.htm']);

/**
 * Character ranges of the file that this tool call wrote. Edit → every
 * occurrence of new_string; MultiEdit → each edit's new_string; Write (or a
 * manual run) → null, meaning the whole file.
 */
function editedRanges(payload, content) {
  const input = payload && typeof payload === 'object' ? payload.tool_input : null;
  if (!input || typeof input !== 'object') return null;
  const inserted = [];
  if (typeof input.new_string === 'string') inserted.push(input.new_string);
  if (Array.isArray(input.edits)) {
    for (const e of input.edits) if (e && typeof e.new_string === 'string') inserted.push(e.new_string);
  }
  if (inserted.length === 0) return null;
  const ranges = [];
  for (const text of inserted) {
    if (!text) continue;
    for (let at = content.indexOf(text); at !== -1; at = content.indexOf(text, at + 1)) {
      ranges.push([at, at + text.length]);
    }
  }
  return ranges; // [] when the inserted text can't be found (e.g. reformatted): report nothing
}

function overlaps(issue, ranges) {
  if (ranges === null) return true;
  if (typeof issue.index !== 'number') return false;
  const start = issue.index;
  const end = start + Math.max(1, String(issue.html ?? '').length);
  return ranges.some(([a, b]) => start < b && end > a);
}

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
  const source = resolve(here, 'html-analyzer.ts');
  // A dev checkout can carry a dist/ build older than the source; prefer the
  // source then, or the hook silently runs stale rules.
  const compiledIsCurrent = existsSync(compiled) &&
    (!existsSync(source) || statSync(compiled).mtimeMs >= statSync(source).mtimeMs);
  if (compiledIsCurrent) {
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

const OFF_VALUES = new Set(['0', 'off', 'false', 'no']);

/** True when the user has switched the post-edit check off (#23). */
function hookDisabled(env) {
  const override = String(env.AETHER_POSTEDIT_HOOK ?? '').trim().toLowerCase();
  if (override) return OFF_VALUES.has(override);
  return String(env.CLAUDE_PLUGIN_OPTION_POST_EDIT_HOOK ?? '').trim().toLowerCase() === 'false';
}

async function main() {
  if (hookDisabled(process.env)) return;

  // Manual invocation (argv) takes precedence; otherwise use the hook payload.
  let filePath = process.argv[2];
  let payload = null;
  if (!filePath) {
    payload = await readStdinJson();
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

  const all = analyzeHtml(content, { framework: !PLAIN_HTML_EXTENSIONS.has(ext) });
  if (!Array.isArray(all) || all.length === 0) return;
  const ranges = editedRanges(payload, content);
  const issues = all.filter((i) => overlaps(i, ranges));
  if (issues.length === 0) return;

  const where = ranges === null ? 'in the file you just wrote' : 'in the code you just edited';
  const lines = [`Possible accessibility issues ${where} (static heuristic check, may be false positives):`, ''];
  for (const issue of issues) {
    lines.push(`  [${String(issue.impact).toUpperCase()}] ${issue.ruleId}: ${issue.description}`);
    lines.push(`    HTML: ${String(issue.html).slice(0, 120)}`);
    lines.push(`    Fix:  ${issue.suggestion}`);
    lines.push('');
  }
  lines.push(
    `${issues.length} possible issue(s). Check each against the real markup and fix the ones that are real; ` +
      'if one is a false positive (e.g. a label supplied by a component), say so and move on.',
  );

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

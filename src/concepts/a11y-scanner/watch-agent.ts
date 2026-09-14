#!/usr/bin/env node
/**
 * Watch Agent - Continuous monitoring for code quality
 *
 * Watches src/ directory for TypeScript changes and runs:
 * - TypeScript type checking (tsc --noEmit)
 * - Module import validation
 *
 * Uses Node.js built-in fs.watch (no external dependencies).
 *
 * Usage:
 *   npx ts-node watch-agent.ts
 *   npm run watch:check
 */

import { watch, readdirSync, statSync } from 'fs';
import { execSync } from 'child_process';
import { join, relative } from 'path';
import colors from 'picocolors';

const PROJECT_ROOT = join(import.meta.dirname || __dirname, '..', '..', '..');
const SRC_DIR = join(PROJECT_ROOT, 'src');
const DEBOUNCE_MS = 300;
const HEARTBEAT_INTERVAL_MS = 30_000;

// ============================================================================
// State
// ============================================================================

interface WatchState {
  filesWatched: number;
  lastCheckTime: Date | null;
  errorCount: number;
  checkCount: number;
  lastChangedFile: string | null;
  isChecking: boolean;
}

const state: WatchState = {
  filesWatched: 0,
  lastCheckTime: null,
  errorCount: 0,
  checkCount: 0,
  lastChangedFile: null,
  isChecking: false,
};

// ============================================================================
// Status Display
// ============================================================================

function printStatus(): void {
  const lastCheck = state.lastCheckTime
    ? state.lastCheckTime.toLocaleTimeString()
    : 'never';

  const statusIcon = state.errorCount > 0 ? colors.red('●') : colors.green('●');

  process.stderr.write(
    `\r${statusIcon} ` +
    `Files: ${colors.cyan(String(state.filesWatched))} | ` +
    `Checks: ${colors.cyan(String(state.checkCount))} | ` +
    `Errors: ${state.errorCount > 0 ? colors.red(String(state.errorCount)) : colors.green('0')} | ` +
    `Last: ${colors.gray(lastCheck)}   `
  );
}

function printBanner(): void {
  const line = '─'.repeat(52);
  process.stderr.write(`\n${colors.cyan(line)}\n`);
  process.stderr.write(`  ${colors.cyan('ALLCHEMY WATCH AGENT')}\n`);
  process.stderr.write(`  Monitoring src/ for TypeScript changes\n`);
  process.stderr.write(`${colors.cyan(line)}\n\n`);
}

// ============================================================================
// TypeScript Check
// ============================================================================

interface TscError {
  file: string;
  line: number;
  col: number;
  code: string;
  message: string;
}

function parseTscOutput(output: string): TscError[] {
  const errors: TscError[] = [];
  const lines = output.split('\n');

  for (const line of lines) {
    // Match: src/file.ts(10,5): error TS2304: Cannot find name 'foo'.
    const match = line.match(/^(.+?)\((\d+),(\d+)\):\s+error\s+(TS\d+):\s+(.+)$/);
    if (match) {
      errors.push({
        file: match[1],
        line: parseInt(match[2], 10),
        col: parseInt(match[3], 10),
        code: match[4],
        message: match[5],
      });
    }
  }

  return errors;
}

function runTypeCheck(): void {
  if (state.isChecking) return;
  state.isChecking = true;
  state.checkCount++;
  state.lastCheckTime = new Date();

  process.stderr.write(`\n${colors.gray('▶ Running type check...')}\n`);

  try {
    execSync('npx tsc --noEmit 2>&1', {
      cwd: PROJECT_ROOT,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // Success
    state.errorCount = 0;
    process.stderr.write(`${colors.green('✓ No type errors')}\n`);
  } catch (err: any) {
    const output = err.stdout || err.stderr || '';
    const errors = parseTscOutput(output);

    state.errorCount = errors.length;

    if (errors.length > 0) {
      process.stderr.write(`\n${colors.red(`✗ ${errors.length} type error(s) found:`)}\n\n`);

      for (const error of errors) {
        const location = `${colors.cyan(error.file)}:${colors.yellow(String(error.line))}:${error.col}`;
        process.stderr.write(`  ${location}\n`);
        process.stderr.write(`    ${colors.red(error.code)}: ${error.message}\n\n`);
      }
    } else {
      // Some other error
      process.stderr.write(`${colors.red('✗ Type check failed:')}\n`);
      process.stderr.write(`  ${output.trim().slice(0, 500)}\n`);
      state.errorCount = 1;
    }
  } finally {
    state.isChecking = false;
    printStatus();
  }
}

// ============================================================================
// File Watcher (recursive using fs.watch)
// ============================================================================

function countTsFiles(dir: string): number {
  let count = 0;
  try {
    const entries = readdirSync(dir);
    for (const entry of entries) {
      const fullPath = join(dir, entry);
      try {
        const stat = statSync(fullPath);
        if (stat.isDirectory() && !entry.startsWith('.') && entry !== 'node_modules' && entry !== '__pycache__') {
          count += countTsFiles(fullPath);
        } else if (entry.endsWith('.ts') || entry.endsWith('.tsx')) {
          count++;
        }
      } catch {
        // Skip inaccessible files
      }
    }
  } catch {
    // Skip inaccessible directories
  }
  return count;
}

function startWatcher(): void {
  let debounceTimer: NodeJS.Timeout | null = null;

  // Count initial files
  state.filesWatched = countTsFiles(SRC_DIR);

  // Watch recursively
  try {
    watch(SRC_DIR, { recursive: true }, (eventType, filename) => {
      if (!filename) return;
      if (!filename.endsWith('.ts') && !filename.endsWith('.tsx')) return;

      state.lastChangedFile = filename;

      // Debounce rapid changes
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        process.stderr.write(`\n${colors.gray(`File changed: ${filename}`)}\n`);
        state.filesWatched = countTsFiles(SRC_DIR);
        runTypeCheck();
      }, DEBOUNCE_MS);
    });
  } catch (err) {
    process.stderr.write(colors.red(`Failed to start watcher: ${(err as Error).message}\n`));
    process.exit(2);
  }
}

// ============================================================================
// Heartbeat
// ============================================================================

function startHeartbeat(): void {
  setInterval(() => {
    if (!state.isChecking) {
      printStatus();
    }
  }, HEARTBEAT_INTERVAL_MS);
}

// ============================================================================
// Graceful Shutdown
// ============================================================================

function setupShutdown(): void {
  const shutdown = () => {
    process.stderr.write(`\n\n${colors.gray('Watch agent stopped.')}\n`);
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

// ============================================================================
// Main
// ============================================================================

printBanner();
setupShutdown();

// Run initial check
process.stderr.write(colors.gray('Running initial type check...\n'));
runTypeCheck();

// Start watching
startWatcher();
startHeartbeat();

process.stderr.write(`\n${colors.gray('Watching for changes... (Ctrl+C to stop)')}\n\n`);
printStatus();

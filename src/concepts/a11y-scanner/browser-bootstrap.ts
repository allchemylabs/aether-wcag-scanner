/**
 * Browser bootstrap — make sure Playwright's Chromium is present before the
 * first `chromium.launch()`.
 *
 * Why: the Claude Code plugin used to download Chromium (~550 MB) inside the
 * MCP server launcher, before the server could answer the MCP handshake. Claude
 * Code gives a stdio server ~60 s to start, so on an ordinary connection the
 * plugin showed up as "not connected" on first use. Installing lazily, on the
 * first scan, keeps startup fast and only pays the download when a browser is
 * actually needed. The plugin's SessionStart hook still pre-warms the download
 * in the background, so most users never wait here at all.
 *
 * `playwright install chromium` is idempotent and honours PLAYWRIGHT_BROWSERS_PATH.
 * Its stdout is redirected to stderr: in the MCP server stdout is the JSON-RPC
 * channel and must stay clean.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { chromium } from 'playwright';

let inflight: Promise<void> | null = null;

/** True when the Chromium build Playwright wants is already on disk. */
export function isChromiumInstalled(): boolean {
  try {
    const exe = chromium.executablePath();
    return Boolean(exe) && existsSync(exe);
  } catch {
    return false;
  }
}

/**
 * Ensure Chromium is installed, downloading it once if missing. Concurrent
 * callers share one install. Set AETHER_NO_BROWSER_INSTALL=1 to disable the
 * download (the launch then fails with Playwright's own error).
 */
export function ensureChromiumInstalled(): Promise<void> {
  if (isChromiumInstalled()) return Promise.resolve();
  if (process.env.AETHER_NO_BROWSER_INSTALL === '1') return Promise.resolve();
  if (!inflight) {
    inflight = installChromium().finally(() => {
      inflight = null;
    });
  }
  return inflight;
}

function playwrightCli(): string {
  // `playwright/cli.js` is not in the package's `exports` map, so resolve the
  // package root via package.json and build the path by hand.
  const require = createRequire(import.meta.url);
  return join(dirname(require.resolve('playwright/package.json')), 'cli.js');
}

function installChromium(): Promise<void> {
  return new Promise((resolve, reject) => {
    process.stderr.write('[aether] Chromium for Playwright not found — downloading it now (one-time)…\n');
    const child = spawn(process.execPath, [playwrightCli(), 'install', 'chromium'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    // Both streams go to stderr: stdout is reserved for JSON-RPC in the MCP server.
    child.stdout?.on('data', (chunk) => process.stderr.write(chunk));
    child.stderr?.on('data', (chunk) => process.stderr.write(chunk));
    child.on('error', reject);
    child.on('exit', (code, signal) => {
      if (code === 0) {
        process.stderr.write('[aether] Chromium ready.\n');
        resolve();
      } else {
        reject(
          new Error(
            `playwright install chromium exited with ${code ?? signal}. ` +
              'Run "npx playwright install chromium" manually, then retry.',
          ),
        );
      }
    });
  });
}

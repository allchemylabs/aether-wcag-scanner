/**
 * Shared Chromium launch flags.
 *
 * Chromium's sandbox is the boundary between a hostile page and the host the
 * scanner runs on (developer laptop, CI runner). It must stay ON by default.
 * The `--no-sandbox` pair is only added when it is genuinely required:
 *   - the process runs as root (Docker / Jenkins agents), where Chromium refuses
 *     to start with the sandbox enabled, or
 *   - the operator explicitly opts out with `AETHER_NO_SANDBOX=1`.
 *
 * The remaining flags are inert from a security standpoint (shm/GPU/first-run).
 */

const BASE_ARGS = [
  '--disable-dev-shm-usage',
  '--disable-gpu',
  '--no-first-run',
  '--no-default-browser-check',
];

const NO_SANDBOX_ARGS = ['--no-sandbox', '--disable-setuid-sandbox'];

let warned = false;

/** True when the Chromium sandbox should be disabled for this process. */
export function shouldDisableSandbox(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.AETHER_NO_SANDBOX === '1') return true;
  // process.getuid is undefined on Windows.
  return typeof process.getuid === 'function' && process.getuid() === 0;
}

/**
 * Build the `args` array for `chromium.launch()`. Logs to stderr once per
 * process when the sandbox is disabled so the condition is visible in logs.
 */
export function getChromiumLaunchArgs(env: NodeJS.ProcessEnv = process.env): string[] {
  if (!shouldDisableSandbox(env)) {
    return [...BASE_ARGS];
  }
  if (!warned) {
    warned = true;
    const why = env.AETHER_NO_SANDBOX === '1' ? 'AETHER_NO_SANDBOX=1' : 'running as root';
    // stderr only — the MCP server's stdout is reserved for JSON-RPC.
    console.error(`[aether] Chromium sandbox disabled (${why}). Only scan trusted URLs in this mode.`);
  }
  return [...NO_SANDBOX_ARGS, ...BASE_ARGS];
}

/** Test hook: reset the once-only warning. */
export function _resetSandboxWarning(): void {
  warned = false;
}

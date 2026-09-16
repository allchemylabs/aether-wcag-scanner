#!/usr/bin/env node
/**
 * Dependency bootstrap for the aether-wcag-scanner plugin.
 *
 * Installs the plugin's runtime dependencies INTO THE PLUGIN'S OWN DIRECTORY the
 * first time it runs, then no-ops. Node's ES-module resolver ignores NODE_PATH, so
 * node_modules has to live next to the source.
 *
 * Used two ways:
 *   - as the SessionStart hook: installs node_modules AND pre-downloads Chromium
 *     for Playwright in the background, so the first scan is instant;
 *   - imported by scripts/start.js, which installs ONLY node_modules before
 *     launching the MCP server. Chromium is NOT downloaded on the server's startup
 *     path: Claude Code allows a stdio MCP server roughly 60 s to answer the
 *     handshake, and a ~550 MB browser download blew through that on ordinary
 *     connections ("not connected"). The server downloads Chromium lazily on the
 *     first scan instead (src/concepts/a11y-scanner/browser-bootstrap.ts).
 *
 * Windows: `npm` is a .cmd shim and cannot be spawned without a shell, so npm is
 * run through the node binary and npm-cli.js that ships next to it.
 *
 * Concurrency: the hook and the server start at the same time on a fresh session, so
 * a mkdir-based lock makes the second caller wait for the first to finish.
 * All progress goes to stderr (stdout of a SessionStart hook is fed to the model; stdout
 * of the MCP server is the JSON-RPC channel).
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const PLUGIN_ROOT =
  process.env.CLAUDE_PLUGIN_ROOT || resolve(dirname(fileURLToPath(import.meta.url)), '..');

const TAG = '[aether-wcag-scanner]';
const LOCK_STALE_MS = 15 * 60 * 1000;
const WAIT_MS = 10 * 60 * 1000;
const IS_WINDOWS = process.platform === 'win32';

function log(msg) {
  process.stderr.write(`${TAG} ${msg}\n`);
}

function run(cmd, args, cwd, extra = {}) {
  const res = spawnSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...extra });
  if (res.error) throw res.error;
  if (res.status !== 0) {
    const tail = `${res.stdout || ''}\n${res.stderr || ''}`.trim().split('\n').slice(-15).join('\n');
    throw new Error(`${cmd} ${args.join(' ')} exited ${res.status}\n${tail}`);
  }
}

/**
 * Locate npm's JS entry point so it can be run with the current node binary on
 * every platform (no .cmd shim, no shell). Falls back to the `npm` on PATH.
 */
function npmCli() {
  const candidates = [];
  if (process.env.npm_execpath && /npm-cli\.js$/.test(process.env.npm_execpath)) {
    candidates.push(process.env.npm_execpath);
  }
  const nodeDir = dirname(process.execPath);
  candidates.push(
    join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'), // Windows layout
    join(nodeDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'), // unix layout
  );
  return candidates.find((p) => existsSync(p)) || null;
}

function runNpm(args, cwd) {
  const cli = npmCli();
  if (cli) {
    run(process.execPath, [cli, ...args], cwd);
    return;
  }
  // No bundled npm found next to node (e.g. a bare node binary). Use PATH; on
  // Windows that is npm.cmd, which needs a shell.
  run(IS_WINDOWS ? 'npm.cmd' : 'npm', args, cwd, IS_WINDOWS ? { shell: true } : {});
}

function sleep(ms) {
  spawnSync(process.execPath, ['-e', `setTimeout(()=>{}, ${ms})`]);
}

function tryLock(lock) {
  try {
    mkdirSync(lock, { recursive: false });
    return true;
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
    try {
      if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) {
        rmSync(lock, { recursive: true, force: true });
        mkdirSync(lock);
        return true;
      }
    } catch {
      /* fall through: another process owns it */
    }
    return false;
  }
}

function waitFor(sentinel) {
  const deadline = Date.now() + WAIT_MS;
  log('another process is installing dependencies; waiting…');
  while (Date.now() < deadline) {
    if (existsSync(sentinel)) return true;
    sleep(2000);
  }
  throw new Error('timed out waiting for a concurrent dependency install');
}

function layout() {
  const root = PLUGIN_ROOT;
  const data = process.env.CLAUDE_PLUGIN_DATA || '';
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const installDir = data ? join(data, 'deps') : root;
  const nodeModules = join(installDir, 'node_modules');
  return {
    root,
    data,
    pkg,
    installDir,
    nodeModules,
    linkPath: join(root, 'node_modules'),
    sentinel: join(nodeModules, `.aether-${pkg.version}.installed`),
    lock: join(data || root, '.aether-install.lock'),
  };
}

/**
 * Ensure node_modules exists for this plugin version. Returns true when ready.
 *
 * Layout: CLAUDE_PLUGIN_ROOT (the install dir) may be replaced on update, while
 * CLAUDE_PLUGIN_DATA (~/.claude/plugins/data/<id>/) is the writable store that
 * survives updates. Dependencies are installed into DATA and linked into
 * ROOT/node_modules (a junction on Windows, no admin rights needed) so Node's
 * ES-module resolver finds them next to the source. Without CLAUDE_PLUGIN_DATA
 * (local dev, `npm start`) they are installed into ROOT.
 */
export function ensureNodeModules() {
  const { root, data, installDir, nodeModules, linkPath, sentinel, lock } = layout();

  const linkReady = () => {
    if (installDir === root) return true;
    try {
      if (existsSync(linkPath)) return true;
      symlinkSync(nodeModules, linkPath, 'junction');
      return true;
    } catch (err) {
      log(`could not link node_modules into the plugin directory (${err.code ?? err.message})`);
      return false;
    }
  };

  if (existsSync(sentinel) && linkReady()) return true;

  if (data) mkdirSync(data, { recursive: true });
  if (!tryLock(lock)) {
    waitFor(sentinel);
    return linkReady();
  }
  try {
    if (!existsSync(sentinel)) {
      log('first run: installing dependencies (one-time, ~1 min)…');
      mkdirSync(installDir, { recursive: true });
      if (installDir !== root) {
        // npm installs whatever package.json it finds in cwd; mirror the plugin's manifest there.
        copyFileSync(join(root, 'package.json'), join(installDir, 'package.json'));
      }
      runNpm(['install', '--omit=dev', '--no-audit', '--no-fund', '--loglevel=error'], installDir);
      writeFileSync(sentinel, `${new Date().toISOString()}\n`);
      log('dependencies ready.');
    }
    return linkReady();
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

/**
 * Download Chromium for Playwright if it is not already present. Idempotent and
 * quick when the browser exists. Requires node_modules (call ensureNodeModules first).
 */
export function ensureChromium() {
  const { nodeModules, installDir } = layout();
  const cli = join(nodeModules, 'playwright', 'cli.js');
  if (!existsSync(cli)) throw new Error('playwright is not installed; run ensureNodeModules() first');
  log('checking Chromium for Playwright (downloads once if missing)…');
  run(process.execPath, [cli, 'install', 'chromium'], installDir);
  log('Chromium ready.');
}

/** Everything: node_modules + Chromium. Used by the SessionStart hook. */
export function ensureDeps() {
  if (!ensureNodeModules()) return false;
  ensureChromium();
  return true;
}

// CLI mode (SessionStart hook): never fail the session; the server surfaces a clearer error.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    ensureDeps();
  } catch (err) {
    log(`dependency install failed: ${err?.message ?? err}`);
  }
  process.exit(0);
}

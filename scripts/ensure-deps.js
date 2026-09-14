#!/usr/bin/env node
/**
 * Dependency bootstrap for the aether-wcag-scanner plugin.
 *
 * Installs the plugin's runtime dependencies (and Chromium for Playwright) INTO
 * THE PLUGIN'S OWN DIRECTORY the first time it runs, then no-ops. Node's ES-module
 * resolver ignores NODE_PATH, so node_modules has to live next to the source.
 *
 * Used two ways:
 *   - as the SessionStart hook (pre-warms the install so the MCP server starts fast);
 *   - imported by scripts/start.js, which runs it before launching the MCP server so
 *     the server works even if the hook has not finished (or never ran).
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

function log(msg) {
  process.stderr.write(`${TAG} ${msg}\n`);
}

function run(cmd, args, cwd) {
  const res = spawnSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (res.error) throw res.error;
  if (res.status !== 0) {
    const tail = `${res.stdout || ''}\n${res.stderr || ''}`.trim().split('\n').slice(-15).join('\n');
    throw new Error(`${cmd} ${args.join(' ')} exited ${res.status}\n${tail}`);
  }
}

function sleep(ms) {
  spawnSync(process.execPath, ['-e', `setTimeout(()=>{}, ${ms})`]);
}

function tryLock(lock) {
  try {
    mkdirSync(lock);
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

/**
 * Ensure node_modules + Chromium exist for this plugin version. Returns true when ready.
 *
 * Layout: Claude Code documents CLAUDE_PLUGIN_ROOT (the install dir) as read-only and
 * CLAUDE_PLUGIN_DATA (~/.claude/plugins/data/<id>/) as the writable store that survives
 * updates. Dependencies are installed into DATA and linked into ROOT/node_modules so
 * Node's ES-module resolver (which ignores NODE_PATH) finds them next to the source.
 * Without CLAUDE_PLUGIN_DATA (local dev, `npm start`) they are installed into ROOT.
 */
export function ensureDeps() {
  const root = PLUGIN_ROOT;
  const data = process.env.CLAUDE_PLUGIN_DATA || '';
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const installDir = data ? join(data, 'deps') : root;
  const nodeModules = join(installDir, 'node_modules');
  const linkPath = join(root, 'node_modules');
  const sentinel = join(nodeModules, `.aether-${pkg.version}.installed`);

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
  const lock = join(data || root, '.aether-install.lock');
  if (!tryLock(lock)) {
    waitFor(sentinel);
    return linkReady();
  }
  try {
    if (!existsSync(sentinel)) {
      log('first run: installing dependencies (one-time, 1–3 min)…');
      mkdirSync(installDir, { recursive: true });
      if (installDir !== root) {
        // npm installs whatever package.json it finds in cwd; mirror the plugin's manifest there.
        copyFileSync(join(root, 'package.json'), join(installDir, 'package.json'));
      }
      run('npm', ['install', '--omit=dev', '--no-audit', '--no-fund', '--loglevel=error'], installDir);
      log('installing Chromium for Playwright…');
      run(process.execPath, [join(nodeModules, 'playwright', 'cli.js'), 'install', 'chromium'], installDir);
      writeFileSync(sentinel, `${new Date().toISOString()}\n`);
      log('dependencies ready.');
    }
    return linkReady();
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
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

#!/usr/bin/env node
/**
 * Publish smoke test: start the built MCP server over stdio, run the JSON-RPC
 * initialize + tools/list handshake, and exit non-zero unless the 5 Aether tools
 * are advertised. Used by `npm run smoke` after `npm run build`.
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const child = spawn(process.execPath, [join(root, 'dist', 'mcp-server', 'index.js')], {
  stdio: ['pipe', 'pipe', 'inherit'],
  env: { ...process.env, ALLCHEMY_API_KEY: process.env.ALLCHEMY_API_KEY ?? '' },
});
const send = (msg) => child.stdin.write(JSON.stringify(msg) + '\n');
let buf = '';
const timer = setTimeout(() => { console.error('smoke: timed out waiting for tools/list'); child.kill(); process.exit(1); }, 30_000);
child.stdout.on('data', (chunk) => {
  buf += chunk.toString();
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg; try { msg = JSON.parse(line); } catch { continue; }
    if (msg.id === 1) { if (!msg.result?.instructions?.includes('aether_scan_and_fix')) { console.error('smoke: initialize result has no server instructions'); child.kill(); process.exit(1); } send({ jsonrpc: '2.0', method: 'notifications/initialized' }); send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }); }
    if (msg.id === 2) {
      const names = (msg.result?.tools ?? []).map((t) => t.name).sort();
      clearTimeout(timer); child.kill();
      const ok = names.length === 5 && names.every((n) => n.startsWith('aether_'));
      console.log(`smoke: ${names.length} tools: ${names.join(', ')}`);
      process.exit(ok ? 0 : 1);
    }
  }
});
send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'smoke', version: '0' } } });

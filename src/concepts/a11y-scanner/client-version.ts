/**
 * Single source of truth for the plugin version, shared by the MCP server
 * (initialize result) and the insights client (User-Agent). Bump it with
 * docs/marketplace-draft/package.json and server.json on every release.
 */
export const CLIENT_VERSION = '1.0.6';

/**
 * How this copy was installed, so cloud logs can tell installs apart:
 * 'claude-plugin' (set by the plugin's scripts/start.js), 'npx' (running from
 * an npm install), or 'source' (a repo checkout). Free-form env values are
 * reduced to [a-z0-9-] so they cannot inject into a header or log line.
 */
export function clientChannel(moduleUrl: string = import.meta.url): string {
  const env = (process.env.AETHER_CLIENT_CHANNEL ?? '').toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 24);
  if (env) return env;
  return /[\\/](node_modules|_npx)[\\/]/.test(decodeURIComponent(moduleUrl)) ? 'npx' : 'source';
}

/** e.g. "aether-wcag-scanner/1.0.6 (npx; node/24.1.0)". Cloud Run logs this on every request. */
export function clientUserAgent(): string {
  return `aether-wcag-scanner/${CLIENT_VERSION} (${clientChannel()}; node/${process.versions.node})`;
}

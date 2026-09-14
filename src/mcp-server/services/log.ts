/**
 * Minimal stderr logging for the MCP server.
 *
 * The MCP server speaks JSON-RPC over stdout, so ALL diagnostic output MUST go
 * to stderr. These helpers emit single-line, prefixed entries for beta
 * debuggability: tool entry (with the correlation `scanId`) and swallowed
 * errors that previously fell through silently.
 *
 * User-controlled fields (URLs, rule IDs) are sanitized so an injected CR/LF
 * can't forge a second log line.
 */

/** Strip control chars (incl. CR/LF) and truncate to keep log lines single-line. */
export function sanitizeForLog(value: unknown, maxLen = 256): string {
  const s = typeof value === 'string' ? value : String(value ?? '');
  // eslint-disable-next-line no-control-regex
  const cleaned = s.replace(/[\u0000-\u001f\u007f]/g, ' ');
  return cleaned.length > maxLen ? cleaned.slice(0, maxLen) + '…' : cleaned;
}

/** Log a one-line tool-entry marker carrying the scan correlation id. */
export function logToolEntry(tool: string, scanId: string, fields: Record<string, unknown> = {}): void {
  const extra = Object.entries(fields)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${k}=${sanitizeForLog(v)}`)
    .join(' ');
  console.error(`[aether] tool=${tool} scanId=${scanId}${extra ? ' ' + extra : ''}`);
}

/** Log a swallowed/handled error (a previously silent failure path). */
export function logError(context: string, err: unknown, fields: Record<string, unknown> = {}): void {
  const extra = Object.entries(fields)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${k}=${sanitizeForLog(v)}`)
    .join(' ');
  const message = err instanceof Error ? err.message : String(err);
  console.error(`[aether] ${context}${extra ? ' ' + extra : ''} error=${sanitizeForLog(message)}`);
}

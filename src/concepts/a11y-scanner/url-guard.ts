/**
 * URL guard — allowlist for what the scanner is permitted to navigate to.
 *
 * The scanner drives a real headless Chromium at whatever URL a caller hands
 * it (MCP tool input, CLI arg, SPA route, UI-automation `navigate` step). That
 * makes it an SSRF primitive unless we fence the target: a cloud metadata
 * endpoint (`169.254.169.254`, `metadata.google.internal`) reached from a CI
 * box or a developer laptop leaks instance credentials to whoever controls the
 * scan input.
 *
 * Policy (deliberately narrow — developers scan local dev servers, so loopback
 * and RFC1918 ranges stay allowed; that IS the product):
 *   - protocol must be `http:` or `https:` (no file:, javascript:, data:, ftp:)
 *   - reject link-local / metadata hosts:
 *       IPv4 169.254.0.0/16, IPv6 fe80::/10, `fd00:ec2::254` (AWS IMDSv6),
 *       IPv4-mapped IPv6 (`::ffff:169.254.x.x`) of the above,
 *       `metadata`, `metadata.google.internal`
 *   - reject the unspecified address (`0.0.0.0`/8, `::`)
 *
 * IPv4 obfuscation (decimal `2852039166`, octal `0251.0376.0251.0376`, hex
 * `0xa9fea9fe`, short forms `0x7f.1`) is defeated by parsing with the WHATWG
 * `URL` constructor, which canonicalises every IPv4 spelling to dotted decimal
 * before we look at `hostname`. IPv6 is expanded to 8 groups so compressed and
 * IPv4-mapped forms are compared numerically, never textually.
 */

const METADATA_HOSTNAMES = new Set(['metadata', 'metadata.google.internal']);

/** Parse dotted-decimal IPv4 (already canonicalised by `URL`). */
function parseIPv4(host: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return null;
  const octets = m.slice(1, 5).map(Number);
  return octets.every((o) => o >= 0 && o <= 255) ? octets : null;
}

/**
 * Expand an IPv6 literal (brackets already stripped) to 8 16-bit groups.
 * Handles `::` compression and a trailing embedded IPv4 (`::ffff:1.2.3.4`).
 * Returns null if the literal is malformed.
 */
function expandIPv6(host: string): number[] | null {
  let text = host;
  // Trailing embedded IPv4 → two hex groups
  const v4Match = /:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(text);
  if (v4Match) {
    const v4 = parseIPv4(v4Match[1]);
    if (!v4) return null;
    const hi = ((v4[0] << 8) | v4[1]).toString(16);
    const lo = ((v4[2] << 8) | v4[3]).toString(16);
    text = text.slice(0, -v4Match[1].length) + `${hi}:${lo}`;
  }

  const halves = text.split('::');
  if (halves.length > 2) return null;
  const toGroups = (s: string): number[] | null => {
    if (s === '') return [];
    const parts = s.split(':');
    const out: number[] = [];
    for (const p of parts) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(p)) return null;
      out.push(parseInt(p, 16));
    }
    return out;
  };
  const head = toGroups(halves[0]);
  const tail = halves.length === 2 ? toGroups(halves[1]) : [];
  if (!head || !tail) return null;
  if (halves.length === 1) {
    return head.length === 8 ? head : null;
  }
  const fill = 8 - head.length - tail.length;
  if (fill < 1) return null;
  return [...head, ...new Array<number>(fill).fill(0), ...tail];
}

function isBlockedIPv4(octets: number[]): string | null {
  if (octets[0] === 169 && octets[1] === 254) return 'link-local/metadata address (169.254.0.0/16)';
  if (octets[0] === 0) return 'unspecified address (0.0.0.0/8)';
  return null;
}

function isBlockedIPv6(groups: number[]): string | null {
  // fe80::/10 — link-local
  if ((groups[0] & 0xffc0) === 0xfe80) return 'IPv6 link-local address (fe80::/10)';
  // :: — unspecified
  if (groups.every((g) => g === 0)) return 'unspecified address (::)';
  // fd00:ec2::254 — AWS IMDS over IPv6
  if (
    groups[0] === 0xfd00 && groups[1] === 0x0ec2 &&
    groups.slice(2, 7).every((g) => g === 0) && groups[7] === 0x0254
  ) {
    return 'AWS metadata address (fd00:ec2::254)';
  }
  // ::ffff:a.b.c.d — IPv4-mapped; apply the IPv4 policy to the embedded address
  if (groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff) {
    const v4 = [groups[6] >> 8, groups[6] & 0xff, groups[7] >> 8, groups[7] & 0xff];
    const reason = isBlockedIPv4(v4);
    if (reason) return `IPv4-mapped ${reason}`;
  }
  return null;
}

/**
 * Return a human-readable reason the URL must not be scanned, or null when it
 * is acceptable. Exported for callers that want the reason without throwing.
 */
export function scanBlockReason(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return 'not a valid absolute URL';
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return `unsupported protocol "${parsed.protocol}" (only http: and https: can be scanned)`;
  }

  // WHATWG URL lower-cases and canonicalises hostnames; strip a trailing dot
  // (FQDN form) so `metadata.google.internal.` matches too.
  let host = parsed.hostname.toLowerCase().replace(/\.$/, '');
  if (host === '') return 'empty hostname';

  if (METADATA_HOSTNAMES.has(host)) {
    return `cloud metadata hostname "${host}"`;
  }

  if (host.startsWith('[') && host.endsWith(']')) {
    host = host.slice(1, -1);
    const groups = expandIPv6(host);
    if (!groups) return `malformed IPv6 literal "${host}"`;
    return isBlockedIPv6(groups);
  }

  const v4 = parseIPv4(host);
  if (v4) return isBlockedIPv4(v4);

  return null;
}

/** True when the URL is http(s) and does not target a metadata/link-local host. */
export function isScannableUrl(url: string): boolean {
  return scanBlockReason(url) === null;
}

/**
 * Validate a scan target and return the parsed URL. Throws a clear Error naming
 * the offending URL and the reason when the target is not permitted.
 */
export function assertScannableUrl(url: string): URL {
  const reason = scanBlockReason(url);
  if (reason !== null) {
    throw new Error(`Refusing to scan "${url}": ${reason}. Only http(s) URLs to non-metadata hosts can be scanned.`);
  }
  return new URL(url);
}

/**
 * Assert that `target` is scannable AND shares an origin with `base`. Used for
 * SPA routes and UI-automation navigations, which must never hop the scan off
 * the site it was pointed at.
 */
export function assertSameOriginScannable(target: string, base: string): URL {
  const t = assertScannableUrl(target);
  let baseOrigin: string;
  try {
    baseOrigin = new URL(base).origin;
  } catch {
    throw new Error(`Cannot check same-origin: base URL "${base}" is invalid`);
  }
  if (t.origin !== baseOrigin) {
    throw new Error(
      `Refusing to navigate to "${target}": origin ${t.origin} differs from the scanned origin ${baseOrigin}.`,
    );
  }
  return t;
}

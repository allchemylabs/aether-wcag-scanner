/**
 * Bot-gate detection: recognise the interstitial a bot-protection service
 * (Cloudflare, Akamai, PerimeterX/HUMAN, DataDome, Amazon) serves an automated
 * browser instead of the real page. Scanning that page yields a confident but
 * meaningless result — on 2026-10-02 w3.org's Cloudflare challenge was reported
 * as a single critical `meta-refresh` violation — so the scanner refuses it.
 *
 * Pure function over signals collected in the page, so it is unit-testable
 * without a browser.
 */

export interface BotGateSignals {
  /** document.title */
  title: string;
  /** Visible body text (document.body.innerText) — not raw HTML, to avoid
   *  false positives from font names, meta robots tags or script URLs. */
  text: string;
  /** document.documentElement.innerHTML.length */
  htmlLength: number;
  /** A Cloudflare challenge-platform script / form / config is present.
   *  (Not Turnstile alone: ordinary pages embed the Turnstile widget.) */
  challengePlatform: boolean;
}

/** Real pages are far larger; interstitials are a few KB. */
const MAX_GATE_HTML = 50_000;

const TEXT_MARKERS = [
  // Cloudflare (2024–2026 wording, plus the older "checking your browser")
  'performing security verification',
  'verifies you are not a bot',
  'verifying you are human',
  'verify you are human',
  'needs to review the security of your connection',
  'checking your browser before accessing',
  'enable javascript and cookies to continue',
  // Generic / other vendors
  'validatecaptcha',
  'automated access',
  'unusual traffic',
  'verify you are a human',
  'please verify you are a human',
  'press & hold',
  'click the button below to continue',
  'are not a robot',
  'bot detection',
  'access to this page has been denied',
];

const TITLE_MARKERS = ['just a moment...', 'attention required! | cloudflare', 'access denied'];

/** Returns the matched marker, or null when the page looks like real content. */
export function matchBotGate(s: BotGateSignals): string | null {
  if (s.htmlLength > MAX_GATE_HTML) return null;
  const title = s.title.trim().toLowerCase();
  const text = s.text.toLowerCase();
  for (const m of TEXT_MARKERS) if (text.includes(m)) return m;
  for (const m of TITLE_MARKERS) if (title === m) return `title: ${m}`;
  if (s.challengePlatform) return 'cloudflare challenge-platform';
  return null;
}

/**
 * The page the browser ended up on is not the site's real content, so any
 * axe result would be meaningless. Every viewport would hit the same wall, so
 * the scan stops and reports this instead of violations. Message is user-facing.
 */
export class UnscannableError extends Error {
  constructor(public readonly reason: string, message: string) {
    super(message);
    this.name = 'UnscannableError';
  }
}

const NEXT_STEP =
  'Scan a page you control instead (localhost or a staging URL), or ask the site owner to allow-list the scanner.';

/** A bot-protection interstitial was detected in the rendered page. */
export class BotGateError extends UnscannableError {
  constructor(public readonly marker: string, host: string) {
    super(
      'bot_gate',
      `Blocked by bot protection: ${host} served a security-verification page to the automated browser ` +
        `(matched "${marker}"), so no accessibility results were produced for this site. ${NEXT_STEP}`,
    );
    this.name = 'BotGateError';
  }
}

/** Statuses bot walls and rate limiters answer with. */
const BLOCKING_STATUSES = new Set([401, 403, 429, 503]);

/**
 * Issue #14: the cheapest vendor-agnostic signal that the browser is not
 * looking at the real page. Any 4xx/5xx final navigation is unscannable; null
 * (no response, e.g. a file:// or about: page) and 2xx/3xx are fine.
 */
export function unscannableStatus(status: number | null | undefined, host: string): UnscannableError | null {
  if (status == null || status < 400) return null;
  const why = BLOCKING_STATUSES.has(status)
    ? ' (typical of bot protection or rate limiting)'
    : status >= 500 ? ' (server error)' : '';
  return new UnscannableError(
    `http_${status}`,
    `Unscannable: ${host} answered HTTP ${status}${why}, so the browser was not shown the real page and no ` +
      `accessibility results were produced. ${NEXT_STEP}`,
  );
}

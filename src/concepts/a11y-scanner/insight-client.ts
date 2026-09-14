import { GoogleAuth } from 'google-auth-library';
import { existsSync } from 'node:fs';
import { isAbsolute, resolve as resolvePath, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Violation, CorpusInsight, ViolationPattern, ViolationGuidance, ArtifactVersions } from '../../types/a11y';

export type { CorpusInsight, ViolationPattern, ViolationGuidance };

/**
 * Render mode (docs/grounded-artifact-schema.md §8) — controls which retrieval
 * paths the insights API runs. Deterministic/grounded_semantic skip the Path-A
 * LLM narrative and return ontology-grounded guidance only.
 */
export type RenderMode = 'deterministic' | 'grounded_semantic' | 'interpretive';

export interface InsightRequest {
  axeResults: { violations: Violation[] };
  userFlows?: unknown[];
  url: string;
  businessContext?: {
    industry?: string;
    companySize?: string;
    personas?: string[];
  };
  /** Render mode; defaults to 'interpretive' server-side when omitted. */
  mode?: RenderMode;
}

export interface InsightResponse {
  summary: string;
  rootCause: string;
  userImpact: string;
  priorityFixes: string[];
  wcagReferences: string[];
  corpusInsights?: CorpusInsight[];
  violationPatterns?: ViolationPattern[];
  violationGuidance?: ViolationGuidance[];
  /** Component version stamps for feedback attribution (§2). */
  versions?: ArtifactVersions;
}

export interface SSEProgressEvent {
  event: string;
  data: Record<string, unknown>;
}

/**
 * Developer feedback on a rendered Grounded Artifact (docs §6, §9). Keyed by
 * finding_id and stamped with the artifact versions so a rating is attributable
 * to the exact component revisions that produced the fix.
 */
export interface FeedbackSubmission {
  finding_id: string;
  scan_id?: string;
  rating: 'useful' | 'not_useful';
  reason_code?:
    | 'wrong_fix'
    | 'didnt_apply'
    | 'broke_something'
    | 'unclear'
    | 'wrong_technique'
    | 'other'
    | null;
  developer_correction?: string | null;
  free_text?: string | null;
  rated_by?: string | null;
  versions?: ArtifactVersions;
}

export interface FeedbackResult {
  ok: boolean;
  stored_at: string;
}

export interface AsyncJobResponse {
  jobId: string;
  statusUrl: string;
  mode: 'async';
}

export interface JobStatus {
  jobId: string;
  status: 'pending' | 'running' | 'complete' | 'failed';
  progress: number;
  total: number;
  result?: InsightResponse;
  error?: string;
}

export interface StreamOptions {
  onProgress?: (event: SSEProgressEvent) => void;
  /** Correlation id echoed to the server via X-Scan-ID for log tracing. */
  scanId?: string;
}

/** Production insights API. Overridable via ALLCHEMY_INSIGHT_URL. */
export const DEFAULT_INSIGHT_API_URL = 'https://insights-api-pldzko44hq-uc.a.run.app/insights';

/** Package root (three levels up from src/concepts/a11y-scanner — same depth under dist/). */
const PACKAGE_ROOT = resolvePath(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** Exact loopback hostnames — the only hosts allowed to receive the API key over plain http. */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/** True iff the URL's hostname is exactly a loopback address (no `includes()` matching). */
export function isLoopbackUrl(url: string): boolean {
  try {
    return LOOPBACK_HOSTS.has(new URL(url).hostname.toLowerCase());
  } catch {
    return false;
  }
}

/**
 * Resolve and validate the configured insights URL. Reads the env on every call
 * (so dotenv ordering / tests can't be defeated by import-time capture).
 *
 * Throws — BEFORE any request is built or the API key is attached — when the
 * URL is plain `http:` to anything other than exact loopback, or is not http(s)
 * at all. A cleartext hop to a non-local host would leak the API key.
 */
export function getInsightApiUrl(): string {
  const raw = process.env.ALLCHEMY_INSIGHT_URL || DEFAULT_INSIGHT_API_URL;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`ALLCHEMY_INSIGHT_URL is not a valid URL: "${raw}"`);
  }
  // Accept a bare service origin (what the provisioning kit / gcloud print) by
  // normalising it to the /insights endpoint; every derived URL (stream, status)
  // is computed from that suffix.
  const normalised =
    parsed.pathname === '/' || parsed.pathname === '' ? `${parsed.origin}/insights` : raw;
  if (parsed.protocol === 'https:') return normalised;
  if (parsed.protocol === 'http:' && isLoopbackUrl(raw)) return normalised;
  throw new Error(
    `Refusing insecure insights endpoint "${raw}": ALLCHEMY_INSIGHT_URL must use https:// ` +
      '(plain http:// is only allowed for localhost / 127.0.0.1 / [::1]). No API key was sent.',
  );
}

/**
 * Derive the streaming URL from the configured insights URL.
 * /insights -> /insights/stream
 */
function getStreamUrl(): string {
  return getInsightApiUrl().replace(/\/insights\/?$/, '/insights/stream');
}

/**
 * Derive the base API URL (without /insights path) for status polling.
 */
function getBaseUrl(): string {
  return getInsightApiUrl().replace(/\/insights\/?$/, '');
}

/**
 * Resolve GOOGLE_APPLICATION_CREDENTIALS to an absolute key-file path. A
 * relative value (e.g. `scanner-key.json` from a plugin `.env`) is tried against
 * the current working directory first and then the package root, so the plugin
 * works when launched from an arbitrary repo. Returns undefined when unset or
 * when neither location has the file (GoogleAuth then reports the real error).
 */
function resolveCredentialsPath(): string | undefined {
  const raw = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (!raw) return undefined;
  if (isAbsolute(raw)) return raw;
  const fromCwd = resolvePath(process.cwd(), raw);
  if (existsSync(fromCwd)) return fromCwd;
  const fromRoot = resolvePath(PACKAGE_ROOT, raw);
  if (existsSync(fromRoot)) return fromRoot;
  return undefined;
}

/**
 * Should we attempt to mint a Cloud Run IAM identity token at all?
 * Yes when an SA key file is configured, when the operator forces ADC with
 * AETHER_USE_ADC=1, or when we are visibly running on GCP (Cloud Run / GCE
 * markers). Public-beta users have only an API key — for them we skip IAM
 * silently and the Cloud Run edge admits the request unauthenticated.
 */
function shouldMintIdentityToken(): boolean {
  if (process.env.GOOGLE_APPLICATION_CREDENTIALS) return true;
  if (process.env.AETHER_USE_ADC === '1') return true;
  return Boolean(process.env.K_SERVICE || process.env.GCE_METADATA_HOST);
}

/**
 * Get a GCP identity token for Cloud Run IAM auth.
 * Uses GOOGLE_APPLICATION_CREDENTIALS (SA key file) or ambient credentials (GCE, Cloud Shell).
 * Returns null when targeting loopback (no IAM for local dev) or when no
 * credentials are configured (API-key-only public-beta mode).
 */
async function getIdentityToken(apiUrl: string): Promise<string | null> {
  if (isLoopbackUrl(apiUrl)) {
    return null;
  }
  if (!shouldMintIdentityToken()) {
    return null;
  }

  // Extract the Cloud Run service URL (origin) as the audience
  const audience = new URL(apiUrl).origin;
  try {
    const keyFilename = resolveCredentialsPath();
    const auth = keyFilename ? new GoogleAuth({ keyFilename }) : new GoogleAuth();
    const client = await auth.getIdTokenClient(audience);
    const headers = await client.getRequestHeaders();
    return headers['Authorization'] || null;
  } catch (err) {
    // Token mint failure (revoked/missing SA key, ADC unavailable). The IAM
    // token is a legacy, optional layer now that the edge is public: when an API
    // key is configured, warn (stderr only — stdout is JSON-RPC) and continue
    // with X-API-Key alone instead of silently degrading to templates. Only
    // rethrow when there is no API key either, since the request cannot succeed.
    console.error(
      `[aether] getIdentityToken failed audience=${audience} error=${(err as Error).message}` +
        (process.env.ALLCHEMY_API_KEY
          ? ' — continuing with X-API-Key only. Unset GOOGLE_APPLICATION_CREDENTIALS to silence this.'
          : ''),
    );
    if (process.env.ALLCHEMY_API_KEY) return null;
    throw err;
  }
}

/**
 * Rich error for HTTP failures — preserves status code, detail, and response headers
 * so callers can distinguish rate limits (429) from auth failures (401/403).
 */
export class InsightApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly detail: string,
    public readonly responseHeaders: Record<string, string> = {},
  ) {
    super(`Insights API error: ${status} ${detail}`);
    this.name = 'InsightApiError';
  }
}

/**
 * Build common headers for API requests. When `scanId` is supplied it is echoed
 * to the server via `X-Scan-ID` so a client-side scan can be correlated with its
 * server-side RAG calls in the logs.
 */
async function buildHeaders(scanId?: string): Promise<Record<string, string>> {
  // Validates https/loopback FIRST — throws before the API key is attached.
  const apiUrl = getInsightApiUrl();
  const authHeader = await getIdentityToken(apiUrl);
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (authHeader) headers['Authorization'] = authHeader;
  if (process.env.ALLCHEMY_API_KEY) headers['X-API-Key'] = process.env.ALLCHEMY_API_KEY;
  if (scanId) headers['X-Scan-ID'] = scanId;
  // Debug-only: presence booleans for the two auth layers (never the secrets).
  if (process.env.AETHER_DEBUG) {
    console.error(
      `[aether] buildHeaders hasAuth=${Boolean(authHeader)} hasApiKey=${Boolean(process.env.ALLCHEMY_API_KEY)} scanId=${scanId ?? '-'}`,
    );
  }
  return headers;
}

/**
 * Parse SSE text stream into individual events.
 */
function* parseSSE(text: string): Generator<SSEProgressEvent> {
  const lines = text.split('\n');
  let currentEvent = '';
  let currentData = '';

  for (const line of lines) {
    if (line.startsWith('event: ')) {
      currentEvent = line.slice(7);
    } else if (line.startsWith('data: ')) {
      currentData = line.slice(6);
    } else if (line === '' && currentEvent && currentData) {
      try {
        yield { event: currentEvent, data: JSON.parse(currentData) };
      } catch {
        // Skip malformed JSON
      }
      currentEvent = '';
      currentData = '';
    }
  }
}

/**
 * Poll for async job result.
 */
async function pollForResult(jobId: string, options?: StreamOptions): Promise<InsightResponse> {
  const baseUrl = getBaseUrl();
  const headers = await buildHeaders(options?.scanId);
  const pollInterval = 10_000; // 10s
  const maxPolls = 360; // 1 hour max

  for (let i = 0; i < maxPolls; i++) {
    const response = await fetch(`${baseUrl}/status/${jobId}`, {
      headers,
      signal: AbortSignal.timeout(30_000),
    });

    if (!response.ok) {
      throw new Error(`Status poll failed: ${response.status} ${response.statusText}`);
    }

    const status: JobStatus = await response.json() as JobStatus;

    options?.onProgress?.({
      event: 'job_progress',
      data: { jobId, status: status.status, progress: status.progress, total: status.total },
    });

    if (status.status === 'complete' && status.result) {
      return status.result;
    }

    if (status.status === 'failed') {
      throw new Error(`Async job failed: ${status.error || 'unknown error'}`);
    }

    await new Promise(resolve => setTimeout(resolve, pollInterval));
  }

  throw new Error(`Async job ${jobId} timed out after polling`);
}

/**
 * Consume an SSE response stream and return the final InsightResponse.
 */
async function consumeSSEStream(
  response: Response,
  options?: StreamOptions,
): Promise<InsightResponse> {
  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error('Response body is not readable');
  }

  const decoder = new TextDecoder();
  let buffer = '';
  let result: InsightResponse | null = null;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // Process complete events (separated by double newlines)
      const parts = buffer.split('\n\n');
      // Keep the last incomplete part in the buffer
      buffer = parts.pop() || '';

      for (const part of parts) {
        if (!part.trim()) continue;

        for (const event of parseSSE(part + '\n\n')) {
          options?.onProgress?.(event);

          if (event.event === 'complete') {
            const responseData = (event.data as Record<string, unknown>).response;
            result = responseData as InsightResponse;
          } else if (event.event === 'error') {
            throw new Error(`SSE error: ${JSON.stringify(event.data)}`);
          }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  if (!result) {
    throw new Error('SSE stream ended without a complete event');
  }

  return result;
}

export async function getInsights(
  input: InsightRequest,
  options?: StreamOptions,
): Promise<InsightResponse> {
  const headers = await buildHeaders(options?.scanId);
  headers['Accept'] = 'text/event-stream';

  const streamUrl = getStreamUrl();
  const response = await fetch(streamUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify(input),
    signal: AbortSignal.timeout(600_000), // 10 min safety net
  });

  if (!response.ok && response.status !== 202) {
    // Parse error detail from JSON body if possible
    let detail = response.statusText;
    const respHeaders: Record<string, string> = {};
    response.headers.forEach((v, k) => { respHeaders[k] = v; });

    try {
      const body = await response.json() as Record<string, unknown>;
      if (typeof body.detail === 'string') detail = body.detail;
    } catch {
      // Body not JSON — use statusText
    }

    // Log the API error before throwing — the caller (fix-service) may swallow
    // it into a template fallback, so this stderr line is the only trace of WHY.
    console.error(
      `[aether] insights API error status=${response.status} scanId=${options?.scanId ?? '-'} detail=${detail.replace(/[\r\n]+/g, ' ').slice(0, 256)}`,
    );
    throw new InsightApiError(response.status, detail, respHeaders);
  }

  const contentType = response.headers.get('content-type') || '';

  // Async job response (202 with JSON)
  if (response.status === 202 || contentType.includes('application/json')) {
    const jobResponse: AsyncJobResponse = await response.json() as AsyncJobResponse;
    options?.onProgress?.({
      event: 'async_job_created',
      data: { jobId: jobResponse.jobId, mode: 'async' },
    });
    return pollForResult(jobResponse.jobId, options);
  }

  // SSE stream
  if (contentType.includes('text/event-stream')) {
    return consumeSSEStream(response, options);
  }

  // Unexpected content type — try to parse as JSON (backward compat)
  const data = await response.json() as InsightResponse;
  validateInsightResponse(data);
  return data;
}

/**
 * Submit developer feedback on a Grounded Artifact to the insights API
 * (POST /feedback). Keyed by finding_id; the server persists it to the sink
 * chosen by FEEDBACK_SINK (firestore | gcs | jsonl). Throws InsightApiError on
 * HTTP failures so callers can surface auth/rate-limit state consistently.
 */
export async function submitFeedback(input: FeedbackSubmission): Promise<FeedbackResult> {
  const headers = await buildHeaders(input.scan_id);
  const url = `${getBaseUrl()}/feedback`;

  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(input),
    signal: AbortSignal.timeout(30_000),
  });

  if (!response.ok) {
    let detail = response.statusText;
    const respHeaders: Record<string, string> = {};
    response.headers.forEach((v, k) => { respHeaders[k] = v; });
    try {
      const body = await response.json() as Record<string, unknown>;
      if (typeof body.detail === 'string') detail = body.detail;
    } catch {
      // Body not JSON — use statusText
    }
    throw new InsightApiError(response.status, detail, respHeaders);
  }

  return await response.json() as FeedbackResult;
}

function validateInsightResponse(data: unknown): asserts data is InsightResponse {
  if (!data || typeof data !== 'object') {
    throw new Error(`Insights API returned invalid response: expected object, got ${typeof data}`);
  }

  const obj = data as Record<string, unknown>;
  const requiredFields: (keyof InsightResponse)[] = [
    'summary', 'rootCause', 'userImpact', 'priorityFixes', 'wcagReferences',
  ];
  const missing = requiredFields.filter(field => !(field in obj));
  if (missing.length > 0) {
    throw new Error(`Insights API response missing required fields: ${missing.join(', ')}`);
  }

  if (!Array.isArray(obj.priorityFixes)) {
    throw new Error('Insights API response: priorityFixes must be an array');
  }

  if (!Array.isArray(obj.wcagReferences)) {
    throw new Error('Insights API response: wcagReferences must be an array');
  }
}

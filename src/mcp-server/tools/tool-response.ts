/**
 * Shared MCP tool response helpers.
 *
 * Every tool returns errors in the same shape: a single text block with a
 * JSON-serialized { error, ...context } payload and isError: true. This
 * centralizes that shape so the tool handlers stay focused on their logic.
 */

/**
 * Build a standard error result for a tool handler's catch block.
 * `context` fields (e.g. ruleId, url) are merged alongside the error message.
 */
export function toolError(err: unknown, context: Record<string, unknown> = {}) {
  return {
    content: [
      { type: 'text' as const, text: JSON.stringify({ error: (err as Error).message, ...context }) },
    ],
    isError: true,
  };
}

/** Label that marks the closing line as a message for the user, not data. */
export const USER_NOTICE_PREFIX = 'Notice for the user: ';

/**
 * Standard success result: the JSON payload as the FIRST block (unchanged, so
 * callers that parse content[0] keep working) and, when there is a user-facing
 * notice (missing/invalid key, rate limit, partial scan), a short final block.
 * The relay test on 2026-10-05 showed agents paraphrase or drop a notice buried
 * in the JSON; a separate, labelled line is what the instructions point at.
 */
export function jsonResult(payload: unknown, notice?: string) {
  return {
    content: [
      { type: 'text' as const, text: JSON.stringify(payload, null, 2) },
      ...(notice ? [{ type: 'text' as const, text: USER_NOTICE_PREFIX + notice }] : []),
    ],
  };
}

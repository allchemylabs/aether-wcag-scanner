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

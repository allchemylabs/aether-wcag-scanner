/**
 * aether_check_html — Static analysis of an HTML snippet.
 *
 * Analyzes HTML for accessibility issues without a browser using heuristic
 * pattern matching. If issues are found and the RAG API is available,
 * enriches results with corpus-backed fixes.
 */

import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { analyzeHtml } from '../services/html-analyzer.ts';
import { getFix } from '../services/fix-service.ts';
import { toolError } from './tool-response.ts';
import { logToolEntry, logError } from '../services/log.ts';

/** Upper bound on the HTML accepted for static analysis. */
const MAX_HTML = 200_000;
/** At most this many heuristic issues are enriched with a RAG round-trip. */
const MAX_ENRICHED_ISSUES = 20;
/** Concurrent RAG calls during enrichment. */
const ENRICH_CONCURRENCY = 2;

const CheckHtmlInput = {
  html: z.string().max(MAX_HTML).describe('The HTML to check for accessibility issues'),
  context: z
    .string()
    .max(500)
    .optional()
    .describe('Additional context about where this HTML lives (e.g. "navigation bar", "login form")'),
};

/**
 * Tiny inline concurrency limiter (no dependency): maps `items` through `fn`
 * with at most `limit` in flight, preserving order.
 */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

export function registerCheckHtml(server: McpServer): void {
  server.tool(
    'aether_check_html',
    'Analyze an HTML snippet for WCAG accessibility issues without needing a live URL or browser. Uses static heuristic checks and optionally enriches results with RAG-powered fixes. Use this when a developer pastes HTML or asks about a component\'s accessibility.',
    CheckHtmlInput,
    async ({ html, context }) => {
      const scanId = `scan_${randomUUID()}`;
      logToolEntry('aether_check_html', scanId, { context });
      try {
        const issues = analyzeHtml(html);

        if (issues.length === 0) {
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({
                  clean: true,
                  message: 'No accessibility issues detected in the provided HTML.',
                  note: 'Static analysis only — a full browser scan may catch additional issues like color contrast, focus management, and dynamic content.',
                }),
              },
            ],
          };
        }

        // Enrich each issue with a RAG-powered fix (best-effort). Bounded:
        // at most MAX_ENRICHED_ISSUES round-trips, ENRICH_CONCURRENCY at a
        // time, so a pathological snippet can't fan out hundreds of RAG calls.
        const toEnrich = issues.slice(0, MAX_ENRICHED_ISSUES);
        const unenriched = issues.slice(MAX_ENRICHED_ISSUES).map((issue) => ({
          ruleId: issue.ruleId,
          description: issue.description,
          impact: issue.impact,
          html: issue.html,
          fixHtml: null as string | null,
          explanation: issue.suggestion,
          wcagCriteria: [] as unknown[],
          techniques: [] as unknown[],
          source: 'heuristic',
        }));
        const enrichedIssues = await mapLimit(
          toEnrich,
          ENRICH_CONCURRENCY,
          async (issue) => {
            try {
              const fix = await getFix({
                ruleId: issue.ruleId,
                html: issue.html,
                url: context ?? 'html-snippet',
                // Static-analysis surface — deterministic mode (docs §8).
                mode: 'deterministic',
                scanId,
              });
              return {
                ruleId: issue.ruleId,
                description: issue.description,
                impact: issue.impact,
                html: issue.html,
                fixHtml: fix.fixHtml,
                explanation: fix.explanation,
                wcagCriteria: fix.wcagCriteria,
                techniques: fix.techniques,
                source: fix.source,
              };
            } catch (err) {
              // RAG enrichment failed — fall back to the heuristic suggestion.
              // Log so the degrade-to-heuristic reason isn't invisible.
              logError('check_html RAG enrich failed → heuristic', err, {
                scanId,
                ruleId: issue.ruleId,
              });
              return {
                ruleId: issue.ruleId,
                description: issue.description,
                impact: issue.impact,
                html: issue.html,
                fixHtml: null,
                explanation: issue.suggestion,
                wcagCriteria: [],
                techniques: [],
                source: 'heuristic',
              };
            }
          },
        );
        const allIssues = [...enrichedIssues, ...unenriched];

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                {
                  clean: false,
                  issueCount: allIssues.length,
                  issues: allIssues,
                  ...(unenriched.length > 0
                    ? { note: `Only the first ${MAX_ENRICHED_ISSUES} issues were enriched with RAG fixes; the rest carry heuristic suggestions.` }
                    : {}),
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (err) {
        return toolError(err);
      }
    },
  );
}

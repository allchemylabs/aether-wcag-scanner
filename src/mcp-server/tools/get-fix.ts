/**
 * aether_get_fix — RAG-powered fix or explanation for a specific violation.
 *
 * This is the differentiator: calls the hosted insights API with the violation
 * context, backed by the WCAG corpus. Falls back to local templates when the
 * API is down.
 *
 * Two modes, selected by whether `html` is provided:
 *   • Fix       — pass `ruleId` + `html` (the failing element). Returns fixHtml
 *     + explanation + WCAG criteria/techniques, and (by default) a measured
 *     verification of whether the fix clears the rule.
 *   • Explain   — pass `ruleId` only (omit `html`). Returns WCAG success
 *     criteria, technique code examples, failure patterns, and fix guidance for
 *     the rule (no element-specific fix, no verification).
 */

import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getFix, explainViolation } from '../services/fix-service.ts';
import { verifySnippet } from '../services/verify-service.ts';
import type { VerificationResult } from '../services/verify-service.ts';
import { toolError } from './tool-response.ts';
import { logToolEntry, logError } from '../services/log.ts';

/** Upper bound on any HTML snippet accepted (also verified in a real browser). */
const MAX_HTML = 200_000;

const GetFixInput = {
  ruleId: z.string().max(200).describe('Axe-core rule ID (e.g. "button-name", "image-alt", "color-contrast")'),
  html: z
    .string()
    .max(MAX_HTML)
    .optional()
    .describe('The failing HTML element\'s outerHTML. Omit to get a rule-level explanation instead of an element-specific fix.'),
  parentHtml: z.string().max(MAX_HTML).optional().describe('Parent element\'s outerHTML for context'),
  childrenHtml: z.string().max(MAX_HTML).optional().describe('Children innerHTML for context'),
  siblingHtml: z.string().max(MAX_HTML).optional().describe('Sibling elements\' opening tags (tight lockups) — lets contrast flag logo-adjacent text'),
  failureSummary: z.string().max(5000).optional().describe('Axe\'s failureSummary string'),
  url: z.string().max(2048).optional().describe('URL where the violation was found (context only; not navigated to)'),
  verify: z
    .boolean()
    .optional()
    .default(true)
    .describe('Re-run real axe on original vs fixed HTML to measure whether the fix works (default true). Ignored in explanation mode.'),
};

export function registerGetFix(server: McpServer): void {
  server.tool(
    'aether_get_fix',
    'Get a RAG-powered fix OR explanation for a WCAG violation. Pass `html` (the failing element) to get a concrete fixHtml plus a measured verification. Omit `html` to get a rule-level explanation (WCAG success criteria, technique code examples, failure patterns, and fix guidance). Requires ALLCHEMY_API_KEY for RAG output; falls back to templates without it.',
    GetFixInput,
    async ({ ruleId, html, parentHtml, childrenHtml, siblingHtml, failureSummary, url, verify }) => {
      const scanId = `scan_${randomUUID()}`;
      logToolEntry('aether_get_fix', scanId, { ruleId, url });
      try {
        // Explanation mode: no element supplied, return rule-level guidance.
        if (!html) {
          const explanation = await explainViolation(ruleId, scanId);
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(explanation, null, 2) }],
          };
        }

        // Fix mode: element supplied, generate a concrete fix.
        const result = await getFix({
          ruleId,
          html,
          parentHtml,
          childrenHtml,
          siblingHtml,
          failureSummary,
          url,
          scanId,
        });

        // Deterministically verify the fix on the real browser engine (diff
        // original vs fixed HTML). Attach the measured verdict; never invent one.
        let verification: VerificationResult | undefined;
        if (verify) {
          try {
            verification = await verifySnippet({
              ruleId,
              originalHtml: html,
              fixedHtml: result.fixHtml,
            });
          } catch (err) {
            // Verification is best-effort; the fix itself is still returned.
            // Log so a missing verification block is traceable in a bug report.
            logError('get_fix verification failed', err, { scanId, ruleId });
          }
        }

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ ...result, ...(verification ? { verification } : {}) }, null, 2),
            },
          ],
        };
      } catch (err) {
        return toolError(err, { ruleId });
      }
    },
  );
}

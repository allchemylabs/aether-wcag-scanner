/**
 * aether_verify_fix — deterministic, browser-measured fix verification.
 *
 * Re-runs the real Playwright + axe-core engine after a fix and reports MEASURED
 * facts: did the target rule clear? were new violations introduced? what is the
 * net compliance delta? Two modes:
 *   - URL   → re-scan a live/deployed page (`url`, optional `baseline`).
 *   - snippet → diff original vs fixed HTML strings before deploy
 *               (`originalHtml` + `fixedHtml`).
 *
 * This is the authoritative "did the fix work?" signal — prefer it over any
 * subjective quality judgement.
 */

import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { verifySnippet, verifyUrl } from '../services/verify-service.ts';
import { toolError } from './tool-response.ts';
import { logToolEntry } from '../services/log.ts';
import { isScannableUrl } from '../../concepts/a11y-scanner/url-guard.ts';

/** Upper bound on an HTML snippet accepted for browser verification. */
const MAX_HTML = 200_000;

const VerifyFixInput = {
  ruleId: z.string().max(200).describe('Axe-core rule ID the fix was meant to resolve (e.g. "button-name")'),
  originalHtml: z
    .string()
    .max(MAX_HTML)
    .optional()
    .describe('Original failing HTML (snippet mode; requires fixedHtml)'),
  fixedHtml: z
    .string()
    .max(MAX_HTML)
    .optional()
    .describe('Fixed HTML to verify (snippet mode; requires originalHtml)'),
  url: z
    .string()
    .url()
    .max(2048)
    .refine(isScannableUrl, 'Only http(s) URLs to non-metadata hosts can be scanned')
    .optional()
    .describe('Live/deployed URL to re-scan (URL mode; preferred when a URL exists)'),
  baseline: z
    .array(
      z.object({
        ruleId: z.string().max(200),
        target: z.string().max(2000),
        impact: z.string().max(50).optional(),
      }),
    )
    .max(5000)
    .optional()
    .describe('URL mode: pre-fix violation set for a full new/resolved delta (max 5000 entries)'),
};

export function registerVerifyFix(server: McpServer): void {
  server.tool(
    'aether_verify_fix',
    'Deterministically verify a WCAG fix with the real Playwright + axe-core engine. ' +
      'URL mode re-scans a live page; snippet mode diffs original vs fixed HTML before deploy. ' +
      'Returns MEASURED facts: targetCleared, newViolations (regressions), resolvedViolations, ' +
      'and complianceDelta. This is the authoritative "did the fix work?" signal.',
    VerifyFixInput,
    async ({ ruleId, originalHtml, fixedHtml, url, baseline }) => {
      const scanId = `scan_${randomUUID()}`;
      logToolEntry('aether_verify_fix', scanId, { ruleId, url });
      try {
        let result;
        if (url) {
          result = await verifyUrl({ ruleId, url, baseline });
        } else if (originalHtml !== undefined && fixedHtml !== undefined) {
          result = await verifySnippet({ ruleId, originalHtml, fixedHtml });
        } else {
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({
                  error:
                    'Provide either `url` (URL mode) or both `originalHtml` and `fixedHtml` (snippet mode).',
                  ruleId,
                }),
              },
            ],
            isError: true,
          };
        }

        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        return toolError(err, { ruleId });
      }
    },
  );
}

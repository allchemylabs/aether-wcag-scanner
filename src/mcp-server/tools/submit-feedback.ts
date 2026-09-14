/**
 * aether_submit_feedback — Persist developer feedback on a Grounded Artifact.
 *
 * Sends a rating (+ optional reason_code, developer_correction, version stamps)
 * to the insights API (POST /feedback), keyed by finding_id. This closes the
 * continuous-learning loop (docs §6): a rating attached to the full versioned
 * artifact localizes failures to a pipeline stage and harvests corrections as
 * training material. The server persists to the sink chosen by FEEDBACK_SINK
 * (firestore | gcs | jsonl).
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { submitFeedback } from '../../concepts/a11y-scanner/insight-client.ts';
import type { ArtifactVersions } from '../../types/a11y';
import { toolError } from './tool-response.ts';

const ReasonCode = z.enum([
  'wrong_fix',
  'didnt_apply',
  'broke_something',
  'unclear',
  'wrong_technique',
  'other',
]);

const SubmitFeedbackInput = {
  findingId: z.string().describe('The finding_id of the artifact the rating targets (from a scan/fix result)'),
  rating: z.enum(['useful', 'not_useful']).describe('Whether the fix/guidance was useful'),
  scanId: z.string().optional().describe('The scan_id the finding belonged to'),
  reasonCode: ReasonCode.optional().describe(
    'Why the fix missed: wrong_fix | didnt_apply | broke_something | unclear | wrong_technique | other',
  ),
  developerCorrection: z
    .string()
    .optional()
    .describe('The code the developer actually shipped (becomes raw material for a new template)'),
  freeText: z.string().optional().describe('Optional free-form note'),
  ratedBy: z.string().optional().describe('Role/persona (not PII)'),
  versions: z
    .record(z.string(), z.string())
    .optional()
    .describe('Version stamps echoed from the artifact for attribution'),
};

export function registerSubmitFeedback(server: McpServer): void {
  server.tool(
    'aether_submit_feedback',
    'Submit developer feedback on a previously returned WCAG fix/artifact, keyed by its finding_id. Records a rating plus an optional reason_code and the code the developer actually shipped, so the fix pipeline can learn from misses. Requires ALLCHEMY_API_KEY.',
    SubmitFeedbackInput,
    async ({ findingId, rating, scanId, reasonCode, developerCorrection, freeText, ratedBy, versions }) => {
      try {
        const result = await submitFeedback({
          finding_id: findingId,
          rating,
          scan_id: scanId,
          reason_code: reasonCode,
          developer_correction: developerCorrection,
          free_text: freeText,
          rated_by: ratedBy,
          versions: versions as ArtifactVersions | undefined,
        });

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ ok: result.ok, storedAt: result.stored_at, findingId }, null, 2),
            },
          ],
        };
      } catch (err) {
        return toolError(err, { findingId });
      }
    },
  );
}

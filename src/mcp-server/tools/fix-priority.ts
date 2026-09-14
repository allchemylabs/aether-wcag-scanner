/**
 * Fix-slot allocation for aether_scan_and_fix.
 *
 * Entries arrive severity-sorted (critical → minor). Within each severity tier we
 * interleave across rules (round-robin) so the first N slots cover as many
 * distinct rules as possible: one bad menubar with ten menuitem nodes no longer
 * consumes every slot ahead of a single missing-alt image of the same severity.
 * Relative order inside a rule is preserved.
 */
export interface RuleEntryLike {
  violation: { id: string; impact?: string | null };
}

const SEVERITY_ORDER: Record<string, number> = { critical: 4, serious: 3, moderate: 2, minor: 1 };

export function interleaveByRule<T extends RuleEntryLike>(entries: T[]): T[] {
  const tiers = new Map<number, Map<string, T[]>>();
  for (const e of entries) {
    const sev = SEVERITY_ORDER[e.violation.impact ?? 'minor'] ?? 1;
    const byRule = tiers.get(sev) ?? new Map<string, T[]>();
    tiers.set(sev, byRule);
    const list = byRule.get(e.violation.id) ?? [];
    list.push(e);
    byRule.set(e.violation.id, list);
  }
  const out: T[] = [];
  for (const sev of [...tiers.keys()].sort((a, b) => b - a)) {
    const queues = [...tiers.get(sev)!.values()];
    let remaining = queues.reduce((n, q) => n + q.length, 0);
    while (remaining > 0) {
      for (const q of queues) {
        const next = q.shift();
        if (next) {
          out.push(next);
          remaining--;
        }
      }
    }
  }
  return out;
}

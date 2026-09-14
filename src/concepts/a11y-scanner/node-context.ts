/**
 * Tabular + referenced-element context (SME Issue 4 + Issue 3 wiring) — Tier 2.
 *
 * axe reports a violation's element but none of the *surrounding* DOM a real fix
 * needs. Two cases the SME flagged:
 *
 *   - **empty-table-header (Issue 4):** axe gives `data:null` and no related
 *     nodes — impossible to suggest a header from axe alone. We walk the empty
 *     `<th>`'s column, read its data cells, and attach them so the fix can
 *     propose a real header and explain the header↔cell harm.
 *   - **combobox wiring (Issue 3):** resolve `aria-controls` → confirm the
 *     listbox, note `aria-activedescendant`, so the combobox template can emit
 *     the full WAI-APG pattern instead of a bare `aria-label`.
 *
 * Read best-effort from the live page in one `page.evaluate`, desktop-only,
 * bounded, never throws. Small strings/flags — flows to BOTH the CLI report and
 * the MCP plugin (only heavy screenshot images stay MCP-off).
 */

import type { Page } from 'playwright';
import type { ReferencedContext, TableContext, Violation, ViolationNode } from '../../types/a11y';

/** Bound the traversal — no page needs more than this many enriched nodes. */
const MAX_CONTEXT_NODES = 100;
/** How many data cells to sample from a column (enough to infer a header). */
const MAX_SAMPLE_CELLS = 8;
/** axe rule whose nodes need column traversal. */
const TABLE_RULE = 'empty-table-header';

function selectorOf(target: string | string[] | undefined): string | undefined {
  const sel = Array.isArray(target) ? target[0] : target;
  return sel || undefined;
}

interface ContextResult {
  table?: TableContext;
  refs?: ReferencedContext;
}

/**
 * Resolve table/refs context for a batch of selectors in one round-trip. Each
 * entry carries `wantTable` (the node is an `empty-table-header` cell); refs are
 * computed whenever the element actually has `aria-controls`/`aria-labelledby`.
 * Returns a parallel array; a null entry means the selector didn't resolve.
 */
async function computeContext(
  page: Page,
  entries: { sel: string; wantTable: boolean }[],
): Promise<(ContextResult | null)[]> {
  return page.evaluate(
    (items: { sel: string; wantTable: boolean }[]) => {
      const SAMPLE = 8;

      // NOTE: all logic is inlined into the anonymous map callback below. Under
      // tsx/esbuild `keepNames`, a nested `function foo(){}` (or a
      // `const foo = () => {}`) inside page.evaluate is serialized with a
      // `__name(foo,"foo")` call that is undefined in the page context
      // (ReferenceError → the whole batch is skipped). Only anonymous inline
      // arrows passed directly to array methods survive serialization.
      return items.map((item): ContextResult | null => {
        try {
          const el = document.querySelector(item.sel);
          if (!el) return null;
          const out: ContextResult = {};

          // ---- table context (SME Issue 4: empty-table-header column) ----
          if (item.wantTable) {
            const cell = el as HTMLTableCellElement;
            const row = el.closest('tr');
            const table = el.closest('table');
            if (row && table) {
              // A row header (scope="row") labels its row, not a column —
              // column traversal doesn't apply.
              if (el.getAttribute('scope') === 'row') {
                out.table = { columnIndex: cell.cellIndex ?? 0, sampleCells: [], isRowHeader: true };
              } else {
                const columnIndex = cell.cellIndex ?? 0;
                const tbodyRows = Array.from(table.querySelectorAll('tbody tr'));
                const bodyRows = tbodyRows.length
                  ? tbodyRows
                  : Array.from(table.querySelectorAll('tr')).filter((r) => r !== row);

                const sampleCells: string[] = [];
                for (const r of bodyRows) {
                  const c = (r as HTMLTableRowElement).cells?.[columnIndex];
                  const txt = (c?.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 80);
                  if (txt) sampleCells.push(txt);
                  if (sampleCells.length >= SAMPLE) break;
                }

                // Conservative header suggestion: only when the column's data
                // shares one strong, unambiguous type. A wrong guess is worse
                // than none, so most columns stay undefined and the fix presents
                // the sample cells instead.
                let suggestedHeader: string | undefined;
                const vals = sampleCells.filter((c) => c.length > 0);
                if (vals.length >= 2) {
                  if (vals.every((v) => /^[$€£]\s?\d/.test(v))) suggestedHeader = 'Amount';
                  else if (vals.every((v) => /^\d{1,3}(,\d{3})*(\.\d+)?%?$/.test(v))) suggestedHeader = 'Value';
                  else if (vals.every((v) => /^\d{4}-\d{2}-\d{2}/.test(v)) || vals.every((v) => /^\d{1,2}\/\d{1,2}\/\d{2,4}$/.test(v))) suggestedHeader = 'Date';
                  else if (vals.every((v) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v))) suggestedHeader = 'Email';
                  else if (vals.every((v) => /^(yes|no|active|inactive|enabled|disabled|on|off)$/i.test(v))) suggestedHeader = 'Status';
                }

                out.table = { columnIndex, sampleCells, isRowHeader: false, ...(suggestedHeader && { suggestedHeader }) };
              }
            }
          }

          // ---- referenced context (SME Issue 3: combobox → listbox wiring) ----
          const controlsId = el.getAttribute('aria-controls');
          const labelledById = (el.getAttribute('aria-labelledby') || '').split(/\s+/)[0];
          const hasActiveDescendant = el.hasAttribute('aria-activedescendant');
          const controlsEl = controlsId ? document.getElementById(controlsId) : null;
          const labelEl = labelledById ? document.getElementById(labelledById) : null;
          if (controlsEl || labelEl || hasActiveDescendant) {
            out.refs = {
              ...(controlsEl && { controls: { html: controlsEl.outerHTML.slice(0, 500) } }),
              hasActiveDescendant,
              ...(labelEl && { labelledBy: { html: labelEl.outerHTML.slice(0, 500) } }),
            } as ReferencedContext;
          }

          return out.table || out.refs ? out : null;
        } catch {
          return null;
        }
      });
    },
    entries,
  ) as Promise<(ContextResult | null)[]>;
}

/**
 * Attach `node.table` / `node.refs` to violation nodes that need Tier-2 context.
 * Mutates in place; bounded by MAX_CONTEXT_NODES; best-effort — a failed
 * evaluate leaves context unset rather than throwing. Desktop-only, after
 * runAxe, before page.close().
 */
export async function captureNodeContext(page: Page, violations: Violation[]): Promise<void> {
  const targets: { nodeRef: ViolationNode; sel: string; wantTable: boolean }[] = [];

  for (const v of violations) {
    const wantTable = v.id === TABLE_RULE;
    for (const node of v.nodes ?? []) {
      const sel = selectorOf(node.target);
      if (!sel) continue;
      // Only enrich when there's something to fetch: a table cell, or an element
      // that references others (aria-controls/labelledby present in its html).
      const mayHaveRefs = /aria-(controls|labelledby|activedescendant)=/.test(node.html ?? '');
      if (!wantTable && !mayHaveRefs) continue;
      targets.push({ nodeRef: node, sel, wantTable });
      if (targets.length >= MAX_CONTEXT_NODES) break;
    }
    if (targets.length >= MAX_CONTEXT_NODES) break;
  }

  if (targets.length === 0) return;

  try {
    const results = await computeContext(
      page,
      targets.map((t) => ({ sel: t.sel, wantTable: t.wantTable })),
    );
    results.forEach((res, i) => {
      if (!res) return;
      if (res.table) targets[i].nodeRef.table = res.table;
      if (res.refs) targets[i].nodeRef.refs = res.refs;
    });
  } catch (err) {
    process.stderr.write(`[node-context] capture skipped: ${(err as Error).message}\n`);
  }
}

// src/concepts/a11y-scanner/axe.ts
import { AxeBuilder } from '@axe-core/playwright';
import type { Page } from 'playwright';
import type { AxeCheckResult, Violation } from '../../types/a11y';

export interface AxeResult {
  violations: Violation[];
  axeError?: string;
}

// Cap related nodes per check to bound the request payload (some rules can
// enumerate many related elements). 12 is generous for real fixes.
const MAX_RELATED_NODES = 12;

/**
 * Normalize an axe check bucket (`any`/`all`/`none`) into the trimmed shape the
 * fix pipeline consumes: keep `{id,impact,message,data}` and trim relatedNodes
 * to `{html(≤500),target}`. `data` is preserved as-is (polymorphic). This is
 * axe's own diagnostics — previously discarded at the map step.
 */
function trimChecks(checks: unknown): AxeCheckResult[] {
  if (!Array.isArray(checks)) return [];
  return checks.map((c: Record<string, unknown>) => {
    const related = Array.isArray(c.relatedNodes) ? c.relatedNodes : [];
    const relatedNodes = related.slice(0, MAX_RELATED_NODES).map((r: Record<string, unknown>) => ({
      html: typeof r.html === 'string' ? r.html.substring(0, 500) : '',
      target: r.target as string | string[] | undefined,
    }));
    return {
      id: c.id as string,
      impact: (c.impact as string) || undefined,
      message: (c.message as string) || undefined,
      data: c.data ?? undefined,
      ...(relatedNodes.length ? { relatedNodes } : {}),
    };
  });
}

export async function runAxeOnPage(page: Page, tags?: string[]): Promise<AxeResult> {
  try {
    // Use AxeBuilder with Playwright page
    // AxeBuilder handles axe-core injection with locked version (~4.11.0)
    const builder = new AxeBuilder({ page });

    // Apply tags if specified, otherwise run all rules
    const results = tags && tags.length > 0
      ? await builder.withTags(tags).analyze()
      : await builder.analyze();

    const violations = results.violations.map(v => ({
      id: v.id,
      description: v.description,
      impact: v.impact || undefined,
      helpUrl: v.helpUrl,
      help: v.help,
      nodes: v.nodes?.map(n => ({
        html: n.html || '',
        target: n.target,
        failureSummary: n.failureSummary,
        // Keep axe's own per-node diagnostics (Tier 0) instead of discarding them.
        checks: {
          any: trimChecks(n.any),
          all: trimChecks(n.all),
          none: trimChecks(n.none),
        },
      })) || [],
    })) as Violation[];

    // Enrich violation nodes with surrounding DOM context. Only for real
    // http(s) pages — snippet verification (`setContent`, about:blank) and any
    // non-web scheme get no DOM-context extraction (second layer behind the
    // URL guard; keeps untrusted snippet markup out of the fix payload).
    const pageUrl = page.url();
    const enrich = /^https?:/i.test(pageUrl);
    for (const violation of violations) {
      if (!enrich) break;
      if (!violation.nodes) continue;
      for (const node of violation.nodes) {
        const targets = Array.isArray(node.target) ? node.target : node.target ? [node.target] : [];
        if (targets.length === 0) continue;
        try {
          const domContext = await page.evaluate((selector: string) => {
            const el = document.querySelector(selector);
            if (!el) return null;

            // Parent: outerHTML with children replaced by placeholder
            const parent = el.parentElement;
            let parentHtml = '';
            if (parent && parent.tagName !== 'HTML' && parent.tagName !== 'BODY') {
              const clone = parent.cloneNode(false) as Element;
              clone.textContent = '...';
              parentHtml = clone.outerHTML;
            }

            // Children: the element's innerHTML
            const childrenHtml = el.innerHTML;

            // Siblings: opening tags (attributes only, children stripped) of the
            // element's sibling elements — but ONLY for a *tight lockup* (small
            // parent). This exposes a logo/brand sibling next to attribution text
            // like "Built by <Logo>" so the contrast logotype caveat can apply,
            // while skipping large containers (navbars) that would over-flag.
            let siblingHtml = '';
            if (parent && parent.childElementCount <= 4) {
              const tags: string[] = [];
              for (const sib of Array.from(parent.children)) {
                if (sib === el) continue;
                const sc = sib.cloneNode(false) as Element;
                tags.push(sc.outerHTML);
              }
              siblingHtml = tags.join(' ');
            }

            return { parentHtml, childrenHtml, siblingHtml };
          }, targets[0]);

          if (domContext) {
            node.parentHtml = domContext.parentHtml?.substring(0, 500) || undefined;
            node.childrenHtml = domContext.childrenHtml?.substring(0, 1000) || undefined;
            node.siblingHtml = domContext.siblingHtml?.substring(0, 500) || undefined;
          }
        } catch {
          // CSS selector may not be queryable, skip silently
        }
      }
    }

    return { violations };
  } catch (err) {
    const message = (err as Error).message;
    console.warn(`Axe analysis failed (gracefully degraded): ${message}`);
    return { violations: [], axeError: message };
  }
}
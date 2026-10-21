/**
 * Element semantics — what assistive technology sees for one element, read from
 * Chromium's own accessibility tree (CDP Accessibility.getPartialAXTree).
 *
 * Fix verification used to diff axe violations only, so a fix that deleted
 * aria-expanded from a div acting as a button "cleared" aria-allowed-attr and
 * came back verified while screen readers lost the open/closed state (#18).
 * Comparing these semantics before and after a fix catches that class of
 * regression whichever tier wrote the fix.
 *
 * Snippet mode renders without the page's JavaScript, so this sees role, name,
 * states and focusability, not whether click/keyboard handlers still work.
 */

import type { Page } from 'playwright';

/** ARIA states/properties whose loss changes what a user is told. */
export const TRACKED_STATES = ['expanded', 'pressed', 'checked', 'selected', 'disabled', 'required', 'invalid', 'haspopup', 'level'] as const;

/**
 * Control-state attributes compared in the DOM as well. Chromium does not expose
 * e.g. aria-expanded on a role-less div (it is invalid there), so the AX tree
 * alone misses the very fix #18 is about: deleting the state instead of making
 * the element the control it describes.
 */
const DOM_STATE_ATTRS = ['aria-expanded', 'aria-pressed', 'aria-checked', 'aria-selected'] as const;

/** Roles a user can operate; changing one of these into a non-interactive role is a regression. */
const INTERACTIVE_ROLES = new Set([
  'button', 'link', 'checkbox', 'radio', 'switch', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio',
  'option', 'combobox', 'textbox', 'searchbox', 'slider', 'spinbutton', 'treeitem', 'listbox', 'gridcell',
  'PopUpButton', 'ToggleButton',
]);

export interface ElementSemantics {
  role: string;
  name: string;
  focusable: boolean;
  /** Tracked states present on the element, as Chromium reports them. */
  states: Partial<Record<(typeof TRACKED_STATES)[number], string>>;
  /** Control-state attributes present in the DOM, whatever Chromium exposes. */
  stateAttrs: Partial<Record<(typeof DOM_STATE_ATTRS)[number], string>>;
}

interface AXValue {
  value?: unknown;
}
interface AXNode {
  ignored?: boolean;
  role?: AXValue;
  name?: AXValue;
  properties?: Array<{ name: string; value: AXValue }>;
}

/** Tag name of a snippet's first element, e.g. "div" for '<div class="x">…'. */
export function rootTagOf(html: string): string | undefined {
  return /^\s*(?:<!--[\s\S]*?-->\s*)*<([a-zA-Z][\w-]*)/.exec(html)?.[1]?.toLowerCase();
}

/**
 * Semantics of the snippet's root element (the first element in <body>), or null
 * when there is none or the browser can't report it (non-Chromium, CDP error).
 *
 * `preferTag`: when the root has a different tag but contains one of this tag,
 * measure that one instead — so a fix that WRAPS the element (region → <main>,
 * listitem → <ul>) is compared element-to-element, not against the wrapper.
 */
export async function captureRootSemantics(page: Page, preferTag?: string): Promise<ElementSemantics | null> {
  let cdp;
  try {
    cdp = await page.context().newCDPSession(page);
  } catch {
    return null; // not Chromium
  }
  try {
    const tag = preferTag && /^[a-z][\w-]*$/.test(preferTag) ? preferTag : '';
    const expression =
      `(function () { var r = document.body && document.body.firstElementChild; if (!r) return r;` +
      ` var t = ${JSON.stringify(tag)}; if (t && r.tagName.toLowerCase() !== t) { var inner = r.querySelector(t); if (inner) return inner; }` +
      ` return r; })()`;
    const { result } = (await cdp.send('Runtime.evaluate', { expression })) as {
      result: { objectId?: string };
    };
    if (!result.objectId) return null;
    const attrsJson = (await cdp.send('Runtime.callFunctionOn', {
      objectId: result.objectId,
      functionDeclaration: `function (names) { var o = {}; for (var i = 0; i < names.length; i++) { var v = this.getAttribute(names[i]); if (v !== null) o[names[i]] = v; } return JSON.stringify(o); }`,
      arguments: [{ value: [...DOM_STATE_ATTRS] }],
      returnByValue: true,
    })) as { result: { value?: string } };
    const stateAttrs = JSON.parse(attrsJson.result.value ?? '{}') as ElementSemantics['stateAttrs'];
    const { node } = (await cdp.send('DOM.describeNode', { objectId: result.objectId })) as { node: { backendNodeId: number } };
    const { nodes } = (await cdp.send('Accessibility.getPartialAXTree', {
      backendNodeId: node.backendNodeId,
      fetchRelatives: false,
    })) as { nodes: AXNode[] };
    const ax = nodes[0];
    if (!ax) return null;
    const props = new Map((ax.properties ?? []).map((p) => [p.name, p.value?.value]));
    const states: ElementSemantics['states'] = {};
    for (const s of TRACKED_STATES) {
      // Present-but-false matters (aria-expanded="false" = collapsed); only absence is "no state".
      const v = props.get(s);
      if (v !== undefined && v !== null) states[s] = String(v);
    }
    return {
      role: ax.ignored ? 'none' : String(ax.role?.value ?? 'generic'),
      name: String(ax.name?.value ?? '').trim(),
      focusable: props.get('focusable') === true,
      states,
      stateAttrs,
    };
  } catch {
    return null;
  } finally {
    await cdp.detach().catch(() => undefined);
  }
}

/**
 * What the fix took away. Gains (a new state, becoming focusable, a better role)
 * are not regressions. Each entry is a short, user-facing sentence fragment.
 */
export function semanticRegressions(before: ElementSemantics, after: ElementSemantics): string[] {
  const out: string[] = [];
  const lost = new Set<string>();
  for (const s of TRACKED_STATES) {
    if (before.states[s] !== undefined && after.states[s] === undefined) {
      lost.add(`aria-${s}`);
      out.push(`lost aria-${s} (was "${before.states[s]}")`);
    }
  }
  for (const a of DOM_STATE_ATTRS) {
    const state = a.slice(5) as (typeof TRACKED_STATES)[number];
    if (lost.has(a) || before.stateAttrs[a] === undefined) continue;
    if (after.stateAttrs[a] === undefined && after.states[state] === undefined) {
      out.push(`removed ${a}="${before.stateAttrs[a]}" (the state it describes is gone; make the element the control instead)`);
    }
  }
  if (before.focusable && !after.focusable) out.push('no longer keyboard-focusable');
  if (before.name && !after.name) out.push(`lost its accessible name ("${before.name.slice(0, 60)}")`);
  if (INTERACTIVE_ROLES.has(before.role) && !INTERACTIVE_ROLES.has(after.role)) {
    out.push(`role changed from ${before.role} to ${after.role}`);
  }
  return out;
}

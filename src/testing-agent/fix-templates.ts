import type { ViolationNode } from '../types/a11y.d.ts';

export interface FixTemplate {
  errorSummary: string;
  generateFix: (html: string, node?: ViolationNode) => FixResult;
}

export interface FixResult {
  fixHtml: string;
  explanation: string;
}

function extractTagName(html: string): string {
  const match = html.match(/^<([a-z][a-z0-9-]*)/i);
  return match ? match[1].toLowerCase() : 'element';
}

function hasAttribute(html: string, attr: string): boolean {
  return new RegExp(`\\b${attr}\\s*=`, 'i').test(html);
}

function insertAttribute(html: string, attr: string, value: string): string {
  return html.replace(/>/, ` ${attr}="${value}">`);
}

function getAttributeValue(html: string, attr: string): string {
  const dq = html.match(new RegExp(`\\b${attr}\\s*=\\s*"([^"]*)"`, 'i'));
  if (dq) return dq[1];
  const sq = html.match(new RegExp(`\\b${attr}\\s*=\\s*'([^']*)'`, 'i'));
  return sq ? sq[1] : '';
}

/** WAI-APG select-only combobox: role="combobox" or aria-haspopup="listbox". */
function isSelectOnlyCombobox(html: string): boolean {
  if (/role\s*=\s*["']?\s*combobox/i.test(html)) return true;
  const popup = getAttributeValue(html, 'aria-haspopup').toLowerCase();
  return popup === 'listbox' || popup === 'true';
}

function comboboxNameFix(html: string): FixResult {
  const tag = extractTagName(html);
  const controls = getAttributeValue(html, 'aria-controls');
  const hasName = hasAttribute(html, 'aria-label') || hasAttribute(html, 'aria-labelledby');
  const fixHtml = hasName
    ? html
    : insertAttribute(html, 'aria-label', '[Name this control, e.g. "Choose a fruit"]');
  const listboxNote = controls
    ? ` It already references its listbox via aria-controls="${controls}".`
    : " Add aria-controls pointing at the listbox element's id.";
  const nameStep = hasName
    ? 'it already has an accessible name — ensure that name is descriptive'
    : 'give it an accessible name (prefer aria-labelledby pointing at the visible label, or aria-label)';
  return {
    fixHtml,
    explanation:
      `This <${tag} role="combobox"> is a select-only combobox. Follow the WAI-ARIA APG ` +
      `select-only combobox pattern rather than adding a bare label: (1) ${nameStep}; ` +
      `(2) keep role="combobox" with aria-haspopup="listbox" and aria-expanded reflecting ` +
      `the open/closed state; (3) point aria-controls at the listbox and move focus within ` +
      `it with aria-activedescendant.${listboxNote}`,
  };
}

// ---------------------------------------------------------------------------
// Accessible-name cluster (link-name, button-name, image-alt). Mirrors the
// Python resolve_name_fix: inspect the element's real children to pick the
// right remediation — a wrapped <img> gets a descriptive alt, an icon-only
// control gets an aria-label, and only a genuinely empty control falls back to
// "add visible text". Python (cloud) is the primary path; this keeps the local
// fix-service template fallback consistent.
// ---------------------------------------------------------------------------

function firstImg(html: string): string {
  const match = (html || '').match(/<img\b[^>]*>/i);
  return match ? match[0] : '';
}

function imgMissingAlt(imgHtml: string): boolean {
  if (!imgHtml) return false;
  if (!hasAttribute(imgHtml, 'alt')) return true;
  return /alt\s*=\s*""/i.test(imgHtml);
}

function innerHtmlOf(html: string): string {
  const match = (html || '').match(/^\s*<[^>]+>([\s\S]*)<\/[^>]+>\s*$/);
  return match ? match[1] : '';
}

function visibleText(html: string): string {
  return (html || '').replace(/<[^>]+>/g, '').trim();
}

function isIconOnly(fragment: string): boolean {
  if (!fragment) return false;
  if (firstImg(fragment)) return false;
  if (visibleText(fragment)) return false;
  return /<(svg|i|span|use|path)\b/i.test(fragment);
}

function fixImgAltElement(html: string): FixResult {
  if (hasAttribute(html, 'alt')) {
    return {
      fixHtml: html.replace(/alt\s*=\s*""/i, 'alt="[Describe the image]"'),
      explanation: 'Provide a meaningful alt value. Use alt="" only for purely decorative images.',
    };
  }
  return {
    fixHtml: insertAttribute(html, 'alt', '[Describe the image]'),
    explanation: 'Add an alt attribute describing the image content. Use alt="" for decorative images.',
  };
}

/** Contextual accessible-name fix shared by link-name / button-name / image-alt. */
function resolveNameFix(rule: string, html: string, node?: ViolationNode): FixResult {
  const tag = extractTagName(html);
  const childrenHtml = node?.childrenHtml || '';

  // image-alt: the offending element is the image itself.
  if (rule === 'image-alt' || tag === 'img') {
    return fixImgAltElement(html);
  }

  // Select-only combobox (WAI-APG): must precede the icon-only / bare-label
  // defaults so a combobox gets the full pattern, not a placeholder aria-label.
  if (isSelectOnlyCombobox(html)) {
    return comboboxNameFix(html);
  }

  // A wrapped <img> with a missing/empty alt is the strongest signal.
  const innerImg = firstImg(html) || firstImg(childrenHtml);
  if (innerImg && imgMissingAlt(innerImg)) {
    const control = tag === 'a' ? 'link' : tag === 'button' ? 'button' : tag;
    const desc = control === 'link' ? `[Describe where this ${control} goes]` : `[Describe this ${control}]`;
    const fixedImg = hasAttribute(innerImg, 'alt')
      ? innerImg.replace(/alt\s*=\s*""/i, `alt="${desc}"`)
      : insertAttribute(innerImg, 'alt', desc);
    const fixHtml = innerImg && html.includes(innerImg)
      ? html.replace(innerImg, fixedImg)
      : insertAttribute(html, 'aria-label', desc);
    return {
      fixHtml,
      explanation:
        `This <${tag}> gets its accessible name from the image it wraps. Give that <img> a ` +
        `descriptive alt (shown) — the destination or action, not the file name. ` +
        `Alternatively add aria-label="${desc}" to the <${tag}> itself.`,
    };
  }

  // Icon-only control → aria-label.
  if (isIconOnly(childrenHtml) || isIconOnly(innerHtmlOf(html))) {
    return {
      fixHtml: insertAttribute(html, 'aria-label', '[Purpose of this control]'),
      explanation:
        `This <${tag}> contains only an icon and no text, so assistive technology has no name ` +
        `to announce. Add an aria-label naming its action (e.g. "Search", "Close menu", "Play").`,
    };
  }

  // Default: element-appropriate visible-text guidance.
  if (rule === 'button-name') {
    if (hasAttribute(html, 'aria-label')) {
      return {
        fixHtml: html,
        explanation: 'Ensure the existing aria-label value is a non-empty descriptive string.',
      };
    }
    return {
      fixHtml: insertAttribute(html, 'aria-label', '[Button purpose]'),
      explanation: 'Add an aria-label, visible text content, or aria-labelledby reference.',
    };
  }
  // link-name default.
  if (rule === 'aria-command-name' || rule === 'aria-toggle-field-name') {
    // role="button"/"link"/"menuitem" (or switch/checkbox) on a non-native element
    // with no text: name it in place (server issue #4: never substitute an example).
    if (hasAttribute(html, 'aria-label')) {
      return {
        fixHtml: html,
        explanation: 'Ensure the existing aria-label value is a non-empty description of the action.',
      };
    }
    return {
      fixHtml: insertAttribute(html, 'aria-label', '[Describe the action, e.g. Close]'),
      explanation:
        'Add an aria-label describing the action (e.g. aria-label="Close"), or aria-labelledby pointing at ' +
        "visible text. If the control is a third-party widget, set the label through its configuration.",
    };
  }
  return {
    fixHtml: insertAttribute(html, 'aria-label', '[Link purpose]'),
    explanation: 'Add visible text content, an aria-label, or aria-labelledby reference to the link.',
  };
}

// ARIA attributes whose whole purpose is to provide an accessible name.
// Removing one of these to satisfy aria-prohibited-attr would silently strip the
// element's name from assistive technology, so they need role-based remediation.
const NAME_PROVIDING_ARIA = new Set(['aria-label', 'aria-labelledby']);

/**
 * Determine which ARIA attributes are actually prohibited on an element.
 * Prefers axe's failureSummary (which names the offending attribute, e.g.
 * "aria-label attribute cannot be used on a div ..."); falls back to the set of
 * aria-* attributes present on the element when no summary is available.
 */
function removeAttribute(html: string, attr: string): string {
  // Opening tag only; tolerant of quoted/unquoted values.
  return html.replace(new RegExp(`\\s+${attr}(?:\\s*=\\s*("[^"]*"|'[^']*'|[^\\s>]+))?`, 'i'), '');
}

// WAI-ARIA 1.2 §5.2.6 required context role / §5.2.7 required owned elements —
// consulted only when axe's check data and failureSummary are both missing.
const ARIA_REQUIRED_PARENTS: Record<string, string[]> = {
  menuitem: ['menu', 'menubar', 'group'],
  menuitemcheckbox: ['menu', 'menubar', 'group'],
  menuitemradio: ['menu', 'menubar', 'group'],
  option: ['listbox', 'group'],
  tab: ['tablist'],
  treeitem: ['tree', 'group'],
  row: ['table', 'grid', 'treegrid', 'rowgroup'],
  rowgroup: ['table', 'grid', 'treegrid'],
  cell: ['row'], gridcell: ['row'], columnheader: ['row'], rowheader: ['row'],
  listitem: ['list', 'group'],
  caption: ['figure', 'grid', 'table', 'treegrid'],
};
const ARIA_REQUIRED_CHILDREN: Record<string, string[]> = {
  menu: ['menuitem', 'menuitemcheckbox', 'menuitemradio', 'group'],
  menubar: ['menuitem', 'menuitemcheckbox', 'menuitemradio', 'group'],
  listbox: ['option', 'group'], tablist: ['tab'], tree: ['treeitem', 'group'],
  table: ['row', 'rowgroup'], grid: ['row', 'rowgroup'], treegrid: ['row', 'rowgroup'], rowgroup: ['row'],
  row: ['cell', 'gridcell', 'columnheader', 'rowheader'], list: ['listitem'], radiogroup: ['radio'], feed: ['article'],
};
const MENU_ITEM_ROLES = new Set(['menuitem', 'menuitemcheckbox', 'menuitemradio']);
const MENU_CONTAINER_ROLES = new Set(['menu', 'menubar']);
const ARIA_STRUCTURE_REF =
  'Reference: WAI-ARIA 1.2 §5.2.7 Required Owned Elements / §5.2.6 Required Context Role; WAI-ARIA Authoring Practices "Menu and Menubar" pattern.';

function rolesFromSummary(summary?: string): string[] {
  const m = (summary ?? '').match(/Required ARIA (?:parents?|children) roles? not present:\s*([a-z ,]+)/i);
  return m ? m[1].split(',').map((r) => r.trim()).filter(Boolean) : [];
}
function elementRole(html: string): string {
  const m = html.match(/\brole\s*=\s*["']?([a-z]+)/i);
  return m ? m[1].toLowerCase() : '';
}
function checkData(node: ViolationNode | undefined, checkId: string): unknown {
  const buckets = node?.checks;
  if (!buckets) return undefined;
  for (const list of [buckets.any, buckets.all, buckets.none]) {
    const hit = (list ?? []).find((c) => c.id === checkId);
    if (hit) return hit.data;
  }
  return undefined;
}
function isLink(html: string): boolean {
  return /^\s*<a\b/i.test(html) && hasAttribute(html, 'href');
}

function findProhibitedAriaAttrs(html: string, failureSummary?: string): string[] {
  const fromSummary = failureSummary
    ? [...failureSummary.matchAll(/\baria-[a-z-]+\b/gi)].map((m) => m[0].toLowerCase())
    : [];
  const source = fromSummary.length > 0 ? fromSummary : html.match(/\baria-[a-z-]+(?==)/gi) ?? [];
  const present = new Set((html.match(/\baria-[a-z-]+(?==)/gi) ?? []).map((a) => a.toLowerCase()));
  // Only keep attrs that are actually on the element (summary can mention roles too).
  return [...new Set(source.map((a) => a.toLowerCase()))].filter((a) => present.has(a));
}

export const FIX_TEMPLATES: Record<string, FixTemplate> = {

  'region': {
    errorSummary: 'Content is not contained within a landmark region',
    generateFix: (html) => ({
      fixHtml: `<main>\n  ${html}\n</main>`,
      explanation: 'Wrap page content in a landmark element such as <main>, <nav>, <header>, <footer>, or <aside>.',
    }),
  },

  'landmark-unique': {
    errorSummary: 'Multiple landmarks of the same type lack unique labels',
    generateFix: (html) => {
      const tag = extractTagName(html);
      return {
        fixHtml: insertAttribute(html, 'aria-label', `[Descriptive ${tag} label]`),
        explanation: `Add a unique aria-label to each <${tag}> so assistive technology can distinguish them.`,
      };
    },
  },

  'button-name': {
    errorSummary: 'Button has no accessible name',
    generateFix: (html, node) => resolveNameFix('button-name', html, node),
  },

  'aria-command-name': {
    errorSummary: 'ARIA command (button/link/menuitem role) has no accessible name',
    generateFix: (html, node) => resolveNameFix('aria-command-name', html, node),
  },

  'aria-toggle-field-name': {
    errorSummary: 'ARIA toggle field (checkbox/switch role) has no accessible name',
    generateFix: (html, node) => resolveNameFix('aria-toggle-field-name', html, node),
  },

  'page-has-heading-one': {
    errorSummary: 'Page does not contain a level-one heading',
    generateFix: () => ({
      fixHtml: '<h1>Page Title</h1>',
      explanation: 'Add an <h1> element describing the page. Each page should have exactly one.',
    }),
  },

  'heading-order': {
    errorSummary: 'Heading levels skip one or more levels',
    generateFix: (html) => {
      const tag = extractTagName(html);
      const level = parseInt(tag.replace('h', ''), 10);
      const correctLevel = Math.max(level - 1, 2);
      return {
        fixHtml: html
          .replace(new RegExp(`<${tag}`, 'i'), `<h${correctLevel}`)
          .replace(new RegExp(`</${tag}`, 'i'), `</h${correctLevel}`),
        explanation: `Change <${tag}> to <h${correctLevel}>, or restructure so heading levels increase by one (h1 > h2 > h3 ...).`,
      };
    },
  },

  'color-contrast': {
    errorSummary: 'Text does not meet minimum color contrast ratio',
    generateFix: (html, node) => {
      const summary = node?.failureSummary || '';
      const fgMatch = summary.match(/foreground color:\s*(#[0-9a-fA-F]{6})/);
      const bgMatch = summary.match(/background color:\s*(#[0-9a-fA-F]{6})/);
      const expectedMatch = summary.match(/Expected contrast ratio of\s+([\d.]+):1/);
      // axe phrases the measured ratio as "insufficient color contrast of 3.0:1" and the
      // target as "Expected contrast ratio of 4.5:1"; the old pattern matched the target.
      const currentMatch = summary.match(/contrast of\s+([\d.]+):1/) || summary.match(/has a contrast ratio of\s+([\d.]+):1/);
      const sizeMatch = summary.match(/font size:\s+([\d.]+)pt/i);
      const weightMatch = summary.match(/font weight:\s*(normal|bold|\d+)/i);

      if (!fgMatch || !bgMatch) {
        return {
          fixHtml: html,
          explanation: 'No contrast data available. Adjust foreground/background colors to meet 4.5:1 for normal text or 3:1 for large text.',
        };
      }

      const fg = fgMatch[1].toLowerCase();
      const bg = bgMatch[1].toLowerCase();
      const target = expectedMatch ? parseFloat(expectedMatch[1]) : 4.5;
      const current = currentMatch ? parseFloat(currentMatch[1]) : 0;
      const fontSize = sizeMatch ? parseFloat(sizeMatch[1]) : 12;
      const weightRaw = weightMatch ? weightMatch[1].toLowerCase() : 'normal';
      const fontWeight = weightRaw === 'bold' || (parseInt(weightRaw) >= 700) ? 'bold' : 'normal';

      const hexToRgb = (h: string) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)] as const;
      const rgbToHex = (r: number, g: number, b: number) => '#' + [r, g, b].map(c => c.toString(16).padStart(2, '0')).join('');
      const linearize = (c: number) => { const s = c / 255; return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
      const luminance = (r: number, g: number, b: number) => 0.2126 * linearize(r) + 0.7152 * linearize(g) + 0.0722 * linearize(b);
      const contrastRatio = (h1: string, h2: string) => {
        const [l1, l2] = [luminance(...hexToRgb(h1)), luminance(...hexToRgb(h2))];
        return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
      };

      // Move `base` toward black or white (keeping `other` fixed) until the pair meets
      // `target`; try both poles and keep the smaller change. Returns null when neither
      // pole can reach the target — never the original colour (that produced a
      // "#ffffff → #ffffff" no-op for white text on mid-tone backgrounds, issue #2).
      const searchTowardPoles = (base: string, other: string): { change: number; hex: string } | null => {
        const baseRgb = hexToRgb(base);
        let best: { change: number; hex: string } | null = null;
        for (const toward of [[0, 0, 0], [255, 255, 255]] as const) {
          const poleHex = rgbToHex(toward[0], toward[1], toward[2]);
          if (contrastRatio(poleHex, other) < target) continue;
          let low = 0, high = 1;
          let found = { change: 1, hex: poleHex };
          for (let i = 0; i < 32; i++) {
            const mid = (low + high) / 2;
            const candidate = rgbToHex(
              Math.round(baseRgb[0] + (toward[0] - baseRgb[0]) * mid),
              Math.round(baseRgb[1] + (toward[1] - baseRgb[1]) * mid),
              Math.round(baseRgb[2] + (toward[2] - baseRgb[2]) * mid),
            );
            if (contrastRatio(candidate, other) >= target) { found = { change: mid, hex: candidate }; high = mid; }
            else { low = mid; }
          }
          if (!best || found.change < best.change) best = found;
        }
        return best;
      };

      const fgFound = searchTowardPoles(fg, bg);
      const bgFound = searchTowardPoles(bg, fg);
      if (!fgFound && !bgFound) return {
          fixHtml: html,
          explanation: `Contrast ${current.toFixed(1)}:1 (${fg} on ${bg}) does not meet ${target}:1, and no adjustment of either colour alone reaches it. Choose a different foreground/background pair.`,
        }; // nothing deterministic reaches the target
      const useFg = !!fgFound && (!bgFound || fgFound.change <= bgFound.change);

      let fixCss: string;
      let fixHtml: string;
      let newRatio: number;
      let remedy: string;
      if (useFg && fgFound) {
        newRatio = contrastRatio(fgFound.hex, bg);
        fixCss = `/* Fix: change foreground from ${fg} to ${fgFound.hex} */\n.element { color: ${fgFound.hex}; }`;
        fixHtml = html.includes('style=') && html.includes('color:')
          ? html.replace(/(?<![a-z-])color:\s*[^;"']+/, `color: ${fgFound.hex}`) + `\n\n${fixCss}`
          : `${html}\n\n${fixCss}`;
        remedy = `Changed foreground to ${fgFound.hex} (${newRatio.toFixed(1)}:1).`;
      } else if (bgFound) {
        newRatio = contrastRatio(fg, bgFound.hex);
        fixCss = `/* Fix: keep text ${fg}; change background from ${bg} to ${bgFound.hex} (smaller change than recolouring the text) */\n.element { background-color: ${bgFound.hex}; }`;
        fixHtml = html.includes('style=') && /background(?:-color)?:/.test(html)
          ? html.replace(/background(?:-color)?:\s*[^;"']+/, `background-color: ${bgFound.hex}`) + `\n\n${fixCss}`
          : `${html}\n\n${fixCss}`;
        remedy = `Changed background to ${bgFound.hex} (${newRatio.toFixed(1)}:1) and kept the text colour ${fg}, a smaller visual change than recolouring the text.`;
      } else {
        return {
          fixHtml: html,
          explanation: `Contrast ${current.toFixed(1)}:1 (${fg} on ${bg}) does not meet ${target}:1, and no adjustment of either colour alone reaches it. Choose a different foreground/background pair.`,
        };
      }
      if (newRatio < target) return {
          fixHtml: html,
          explanation: `Contrast ${current.toFixed(1)}:1 (${fg} on ${bg}) does not meet ${target}:1, and no adjustment of either colour alone reaches it. Choose a different foreground/background pair.`,
        }; // never ship a fix that still fails

      let explanation = `Contrast ${current.toFixed(1)}:1 (${fg} on ${bg}) does not meet ${target}:1. ${remedy}`;
      if (fontSize >= 18 || (fontSize >= 14 && fontWeight === 'bold')) {
        explanation += ' Large text: 3:1 minimum applies.';
      }
      return { fixHtml, explanation };
    },
  },

  'aria-required-attr': {
    errorSummary: 'Element with ARIA role is missing required attribute(s)',
    generateFix: (html, node) => {
      const hint = node?.failureSummary || '';
      const attrMatch = hint.match(/aria-[a-z-]+/g);
      const missingAttrs = attrMatch ? [...new Set(attrMatch)] : ['aria-[required-attr]'];
      let fixed = html;
      for (const attr of missingAttrs.slice(0, 3)) {
        if (!hasAttribute(fixed, attr)) {
          fixed = insertAttribute(fixed, attr, '[value]');
        }
      }
      return {
        fixHtml: fixed,
        explanation: `Add the missing ARIA attribute(s): ${missingAttrs.join(', ')}.`,
      };
    },
  },

  'nested-interactive': {
    errorSummary: 'Interactive control is nested inside another interactive control',
    generateFix: (html) => ({
      fixHtml: html,
      explanation: 'Restructure the DOM so each interactive element (button, link, input) is independent — not nested inside another interactive control.',
    }),
  },

  'meta-viewport': {
    errorSummary: 'Zooming and scaling is disabled in the viewport meta tag',
    generateFix: () => ({
      fixHtml: '<meta name="viewport" content="width=device-width, initial-scale=1.0">',
      explanation: 'Remove maximum-scale, minimum-scale, and user-scalable=no. Users must be able to zoom.',
    }),
  },

  'link-name': {
    errorSummary: 'Link has no discernible text',
    generateFix: (html, node) => resolveNameFix('link-name', html, node),
  },

  'landmark-one-main': {
    errorSummary: 'Page does not have a main landmark',
    generateFix: () => ({
      fixHtml: '<main>\n  <!-- primary page content -->\n</main>',
      explanation: 'Wrap the primary content in a <main> element or add role="main" to the appropriate container.',
    }),
  },

  'image-alt': {
    errorSummary: 'Image is missing alt text',
    generateFix: (html, node) => resolveNameFix('image-alt', html, node),
  },

  'aria-required-parent': {
    errorSummary: 'Element with ARIA role is not inside its required parent',
    generateFix: (html, node) => {
      const role = elementRole(html);
      const data = checkData(node, 'aria-required-parent');
      const roles =
        (Array.isArray(data) && data.length ? data.map(String) : rolesFromSummary(node?.failureSummary)) ||
        [];
      const resolved = roles.length ? roles : ARIA_REQUIRED_PARENTS[role] ?? [];
      if (!resolved.length) {
        // Never emit a placeholder role — an honest "no template" beats a fake fix.
        return {
          fixHtml: html,
          explanation:
            'This element\'s role requires a specific parent role that could not be determined from the scan data. ' +
            ARIA_STRUCTURE_REF,
        };
      }
      if (MENU_ITEM_ROLES.has(role) && isLink(html)) {
        return {
          fixHtml: removeAttribute(html, 'role'),
          explanation:
            'This link carries role="menuitem" but is not inside a menu/menubar. For site navigation, remove the ' +
            'menu roles: keep the <a href> inside a plain <nav><ul><li> structure (also remove role="menubar" from the ' +
            `containing list). Only use role="menuitem" for a true application menu, where it must be a direct owned child of role="${resolved[0]}"` +
            (resolved.length > 1 ? ` (or ${resolved.slice(1).join(', ')})` : '') +
            ' with each <li> marked role="none". ' + ARIA_STRUCTURE_REF,
        };
      }
      const parentRole = resolved[0];
      const options = resolved.length > 1 ? ` (any of: ${resolved.join(', ')})` : '';
      return {
        fixHtml: `<div role="${parentRole}">\n  ${html}\n</div>`,
        explanation:
          `role="${role || '?'}" must be a direct owned child of an element with role="${parentRole}"${options}. ` +
          'Wrap it in that container, or move it inside the existing one; any intermediate wrapper (e.g. <li>) needs role="none" so ownership passes through. ' +
          ARIA_STRUCTURE_REF,
      };
    },
  },

  'aria-required-children': {
    errorSummary: 'Element with ARIA role is missing its required child roles',
    generateFix: (html, node) => {
      const role = elementRole(html);
      const data = checkData(node, 'aria-required-children') as { messageKey?: string } | string[] | undefined;
      const children = node?.childrenHtml ?? '';
      const summary = node?.failureSummary ?? '';
      const unallowedCase =
        (data && !Array.isArray(data) && data.messageKey === 'unallowed') || /children which are not allowed/i.test(summary);
      if (unallowedCase) {
        const liWrappers = /<li\b/i.test(children) || /\bli\[/i.test(summary);
        const navLinks = /<a\s[^>]*href/i.test(children);
        if (MENU_CONTAINER_ROLES.has(role) && (navLinks || liWrappers)) {
          return {
            fixHtml: removeAttribute(html, 'role'),
            explanation:
              `This list has role="${role}" but its children are <li> elements, not menuitems, so the menu is structurally invalid. ` +
              'For site navigation the fix is to drop the menu roles: remove role="menubar" here and role="menuitem" from the links, ' +
              'leaving a standard <nav><ul><li><a> structure. If this is a true application menu, instead add role="none" to every <li> ' +
              "so the menuitem links become the menubar's owned children. " + ARIA_STRUCTURE_REF,
          };
        }
        if (liWrappers) {
          const fixedChildren = children ? children.replace(/<li\b(?![^>]*\brole=)/gi, '<li role="none"') : '';
          const tag = (html.match(/^\s*<([a-z0-9]+)/i)?.[1] ?? 'ul').toLowerCase();
          return {
            fixHtml: `${html}${fixedChildren ? `\n  ${fixedChildren}\n` : '\n  <!-- each <li> wrapper: role="none" -->\n'}</${tag}>`,
            explanation:
              `role="${role}" may only own children with the roles it requires. The <li> wrappers interrupt that ownership; ` +
              'give each <li> role="none" so the real children are exposed directly to the container. ' + ARIA_STRUCTURE_REF,
          };
        }
      }
      const required = Array.isArray(data) && data.length ? data.map(String) : rolesFromSummary(summary).length ? rolesFromSummary(summary) : ARIA_REQUIRED_CHILDREN[role] ?? [];
      return {
        fixHtml: html,
        explanation: required.length
          ? `role="${role}" requires owned children with role ${required.join(' / ')}, but none were found. Give each real item inside it role="${required[0]}" (wrappers such as <li> need role="none"), or remove role="${role}" if this is not an interactive widget. ` + ARIA_STRUCTURE_REF
          : 'This element\'s role requires specific child roles that could not be determined from the scan data. ' + ARIA_STRUCTURE_REF,
      };
    },
  },

  'aria-prohibited-attr': {
    errorSummary: 'Element uses ARIA attributes not permitted for its role',
    generateFix: (html, node) => {
      const prohibited = findProhibitedAriaAttrs(html, node?.failureSummary);
      const nameProviding = prohibited.filter((a) => NAME_PROVIDING_ARIA.has(a));

      // Name-providing attrs (aria-label/aria-labelledby) express intent to give
      // the element an accessible name. Stripping them silences the element for
      // assistive tech. The correct remediation is to give the element a role that
      // PERMITS a name (and keyboard support if it is interactive) — not to delete
      // the label. We can't infer the exact widget, so emit a placeholder role +
      // tabindex and let the developer choose the right one.
      if (nameProviding.length > 0 && !hasAttribute(html, 'role')) {
        const withRole = insertAttribute(html, 'role', '[permitting-role]');
        const withTabindex = hasAttribute(withRole, 'tabindex')
          ? withRole
          : insertAttribute(withRole, 'tabindex', '0');
        return {
          fixHtml: withTabindex,
          explanation:
            `The ${nameProviding.join(', ')} attribute is prohibited on this element's role, ` +
            'but removing it would delete the accessible name. Instead give the element a role ' +
            'that permits a name. Pick the role that matches its behavior: use role="button" for ' +
            'a clickable control, role="separator" (with aria-orientation and arrow-key handling) ' +
            'for a draggable resizer/divider, or role="img"/"group"/"region" for non-interactive ' +
            'content. Add tabindex="0" and keyboard handlers if the control is operable, and word ' +
            'the label to reflect keyboard support (e.g. "Drag or use arrow keys to resize").',
        };
      }

      // Otherwise remove only the prohibited attrs that do NOT carry an accessible
      // name (never strip aria-label/aria-labelledby, even alongside a role).
      const removable = prohibited.filter((a) => !NAME_PROVIDING_ARIA.has(a));
      let cleaned = html;
      for (const attr of removable) {
        cleaned = cleaned.replace(new RegExp(`\\s*${attr}="[^"]*"`, 'gi'), '');
      }
      return {
        fixHtml: cleaned !== html ? cleaned : html,
        explanation:
          removable.length > 0
            ? `Remove the prohibited attribute(s) (${removable.join(', ')}) — this element's role does not support them.`
            : "Remove the prohibited ARIA attribute(s) for this element's implicit or explicit role.",
      };
    },
  },

  'tabindex': {
    errorSummary: 'Element has a tabindex value greater than 0',
    generateFix: (html) => ({
      fixHtml: html.replace(/tabindex\s*=\s*"[^"]*"/, 'tabindex="0"'),
      explanation: 'Use tabindex="0" (or remove it) and rely on DOM order for tab sequence. Never use positive tabindex.',
    }),
  },

  'scrollable-region-focusable': {
    errorSummary: 'Scrollable region is not keyboard accessible',
    generateFix: (html) => ({
      fixHtml: insertAttribute(html, 'tabindex', '0'),
      explanation: 'Add tabindex="0" so keyboard users can focus and scroll the container.',
    }),
  },

  'role-img-alt': {
    errorSummary: 'Element with role="img" has no accessible name',
    generateFix: (html) => ({
      fixHtml: insertAttribute(html, 'aria-label', '[Describe the image]'),
      explanation: 'Add aria-label or aria-labelledby to provide an accessible name.',
    }),
  },

  'meta-viewport-large': {
    errorSummary: 'Viewport meta tag restricts zoom below 500%',
    generateFix: () => ({
      fixHtml: '<meta name="viewport" content="width=device-width, initial-scale=1.0">',
      explanation: 'Remove maximum-scale restrictions. Allow zoom to at least 500%.',
    }),
  },

  'empty-heading': {
    errorSummary: 'Heading element has no text content',
    generateFix: (html) => {
      const tag = extractTagName(html);
      return {
        fixHtml: `<${tag}>Descriptive heading text</${tag}>`,
        explanation: `Add meaningful text to the <${tag}>, or remove it if unneeded.`,
      };
    },
  },

  'aria-hidden-focus': {
    errorSummary: 'Element with aria-hidden="true" contains focusable content',
    generateFix: (html) => ({
      fixHtml: html.replace(/\s*aria-hidden\s*=\s*"true"/, ''),
      explanation: 'Remove aria-hidden="true" since this element contains focusable children. Alternatively, add tabindex="-1" to each focusable child if the container must be hidden from assistive technology.',
    }),
  },

  'aria-allowed-role': {
    errorSummary: 'ARIA role is not valid for this element type',
    generateFix: (html) => {
      const roleMatch = html.match(/\srole\s*=\s*"([^"]*)"/i);
      const role = roleMatch ? roleMatch[1].trim().toLowerCase() : '';
      let fixed = html.replace(/\s*role\s*=\s*"[^"]*"/i, '');
      let explanation = 'Remove the invalid role, or change to an element that supports it.';
      if (role === 'heading') {
        // aria-level is only valid alongside role="heading"; leaving it behind trips
        // aria-allowed-attr, and dropping the page's only heading level 1 trips
        // page-has-heading-one. Say so instead of trading one violation for two.
        const levelMatch = html.match(/\saria-level\s*=\s*"(\d+)"/i);
        fixed = fixed.replace(/\s*aria-level\s*=\s*"[^"]*"/i, '');
        const level = levelMatch ? levelMatch[1] : '1';
        explanation =
          `Removed role="heading" and its aria-level (aria-level is only valid with role="heading"). ` +
          `This element is not allowed to be a heading; if the page relied on it as its <h${level}>, ` +
          `add a real <h${level}> element with the same text instead.`;
      } else if (/\saria-level\s*=/i.test(html)) {
        fixed = fixed.replace(/\s*aria-level\s*=\s*"[^"]*"/i, '');
        explanation += ' Also removed aria-level, which is only valid with role="heading".';
      }
      return { fixHtml: fixed, explanation };
    },
  },

  'presentation-role-conflict': {
    errorSummary: 'Element marked presentational also carries global ARIA or is focusable',
    generateFix: (html) => {
      // The element is presentational (role="presentation"/"none" or an implicit
      // presentation role such as <img alt="">) yet ALSO carries a global ARIA
      // state/property or is focusable, which forces it back into the
      // accessibility tree — a conflict browsers resolve by ignoring the
      // presentational role. Clear it deterministically.
      if (/role\s*=\s*"(presentation|none)"/i.test(html)) {
        return {
          fixHtml: html.replace(/\s*role\s*=\s*"(presentation|none)"/i, ''),
          explanation:
            'This element has role="presentation"/"none" but also carries a global ARIA ' +
            'attribute or is focusable, so browsers ignore the presentational role. Remove ' +
            'role="presentation"/"none" so the element is consistently exposed with its native ' +
            'semantics. If it should truly be ignored, instead remove the conflicting global ARIA ' +
            'attributes (e.g. aria-label, aria-hidden="false") and any tabindex.',
        };
      }
      if (/aria-hidden\s*=\s*"false"/i.test(html)) {
        return {
          fixHtml: html.replace(/\s*aria-hidden\s*=\s*"false"/i, ''),
          explanation:
            'The element has an implicit presentation role (e.g. an <img> with empty alt) but ' +
            'aria-hidden="false" forces it back into the accessibility tree, creating the conflict. ' +
            'Remove aria-hidden="false" (it is redundant), or give the element real semantics ' +
            '(e.g. a non-empty alt or an explicit role) if it should be exposed.',
        };
      }
      return {
        fixHtml: html,
        explanation:
          'This element is marked presentational yet also carries a global ARIA state/property or ' +
          'is focusable, so it cannot be consistently ignored. Either remove the presentational ' +
          'role/semantics so it is exposed normally, or remove the conflicting global ARIA ' +
          'attributes and tabindex so it can truly be ignored.',
      };
    },
  },
};

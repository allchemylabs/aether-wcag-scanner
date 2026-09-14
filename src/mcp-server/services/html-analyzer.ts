/**
 * HTML Analyzer — Static heuristic checks for 21 accessibility rules.
 *
 * Runs without a browser by pattern-matching against HTML strings.
 * Used by the check-html MCP tool and the post-edit hook CLI.
 */

export interface HtmlIssue {
  ruleId: string;
  description: string;
  impact: string;
  html: string;
  suggestion: string;
}

interface Rule {
  id: string;
  description: string;
  impact: string;
  /** Return issues found in the HTML string, or empty array if clean. */
  check: (html: string) => HtmlIssue[];
}

function findAll(html: string, pattern: RegExp): RegExpExecArray[] {
  const results: RegExpExecArray[] = [];
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(html)) !== null) {
    results.push(m);
  }
  return results;
}

const RULES: Rule[] = [
  {
    id: 'image-alt',
    description: 'Images must have alternate text',
    impact: 'critical',
    check: (html) => {
      const imgs = findAll(html, /<img\b[^>]*>/gi);
      return imgs
        .filter((m) => !/\balt\s*=/i.test(m[0]))
        .map((m) => ({
          ruleId: 'image-alt',
          description: 'Image is missing alt attribute',
          impact: 'critical',
          html: m[0],
          suggestion: 'Add alt="description" (or alt="" for decorative images)',
        }));
    },
  },
  {
    id: 'button-name',
    description: 'Buttons must have discernible text',
    impact: 'critical',
    check: (html) => {
      const buttons = findAll(html, /<button\b[^>]*>([\s\S]*?)<\/button>/gi);
      return buttons
        .filter((m) => {
          const tag = m[0];
          const content = m[1]?.trim() ?? '';
          const hasAriaLabel = /\baria-label\s*=\s*"[^"]+"/i.test(tag);
          const hasAriaLabelledby = /\baria-labelledby\s*=/i.test(tag);
          const hasTitle = /\btitle\s*=\s*"[^"]+"/i.test(tag);
          return !content && !hasAriaLabel && !hasAriaLabelledby && !hasTitle;
        })
        .map((m) => ({
          ruleId: 'button-name',
          description: 'Button has no accessible name',
          impact: 'critical',
          html: m[0],
          suggestion: 'Add text content, aria-label, or aria-labelledby',
        }));
    },
  },
  {
    id: 'link-name',
    description: 'Links must have discernible text',
    impact: 'serious',
    check: (html) => {
      const links = findAll(html, /<a\b[^>]*>([\s\S]*?)<\/a>/gi);
      return links
        .filter((m) => {
          const tag = m[0];
          const content = m[1]?.replace(/<[^>]+>/g, '').trim() ?? '';
          const hasAriaLabel = /\baria-label\s*=\s*"[^"]+"/i.test(tag);
          return !content && !hasAriaLabel;
        })
        .map((m) => ({
          ruleId: 'link-name',
          description: 'Link has no discernible text',
          impact: 'serious',
          html: m[0],
          suggestion: 'Add visible text, aria-label, or aria-labelledby to the link',
        }));
    },
  },
  {
    id: 'label',
    description: 'Form elements must have labels',
    impact: 'critical',
    check: (html) => {
      const inputs = findAll(html, /<input\b[^>]*>/gi);
      return inputs
        .filter((m) => {
          const tag = m[0];
          if (/\btype\s*=\s*"(hidden|submit|button|reset|image)"/i.test(tag)) return false;
          const hasAriaLabel = /\baria-label\s*=/i.test(tag);
          const hasAriaLabelledby = /\baria-labelledby\s*=/i.test(tag);
          const hasId = /\bid\s*=\s*"([^"]+)"/i.exec(tag);
          // Check if there's a <label for="id"> nearby — rough heuristic
          const hasLabelFor = hasId ? html.includes(`for="${hasId[1]}"`) : false;
          return !hasAriaLabel && !hasAriaLabelledby && !hasLabelFor;
        })
        .map((m) => ({
          ruleId: 'label',
          description: 'Form input is missing a label',
          impact: 'critical',
          html: m[0],
          suggestion: 'Add a <label for="id"> element, aria-label, or aria-labelledby',
        }));
    },
  },
  {
    id: 'html-has-lang',
    description: 'HTML element must have a lang attribute',
    impact: 'serious',
    check: (html) => {
      const htmlTag = /<html\b[^>]*>/i.exec(html);
      if (!htmlTag) return [];
      if (/\blang\s*=\s*"[^"]+"/i.test(htmlTag[0])) return [];
      return [
        {
          ruleId: 'html-has-lang',
          description: '<html> element is missing lang attribute',
          impact: 'serious',
          html: htmlTag[0],
          suggestion: 'Add lang="en" (or appropriate language code) to the <html> element',
        },
      ];
    },
  },
  {
    id: 'document-title',
    description: 'Documents must have a title element',
    impact: 'serious',
    check: (html) => {
      if (/<title\b[^>]*>[^<]+<\/title>/i.test(html)) return [];
      if (!/<head\b/i.test(html) && !/<html\b/i.test(html)) return []; // Fragment, not a full doc
      return [
        {
          ruleId: 'document-title',
          description: 'Document is missing a <title> element',
          impact: 'serious',
          html: '<head>...</head>',
          suggestion: 'Add a descriptive <title> element inside <head>',
        },
      ];
    },
  },
  {
    id: 'meta-viewport',
    description: 'Zooming and scaling must not be disabled',
    impact: 'critical',
    check: (html) => {
      const meta = findAll(html, /<meta\b[^>]*name\s*=\s*"viewport"[^>]*>/gi);
      return meta
        .filter(
          (m) =>
            /user-scalable\s*=\s*no/i.test(m[0]) ||
            /maximum-scale\s*=\s*1(\.0)?[^0-9]/i.test(m[0]),
        )
        .map((m) => ({
          ruleId: 'meta-viewport',
          description: 'Viewport meta tag disables user zoom',
          impact: 'critical',
          html: m[0],
          suggestion: 'Remove user-scalable=no and maximum-scale restrictions',
        }));
    },
  },
  {
    id: 'empty-heading',
    description: 'Headings must not be empty',
    impact: 'minor',
    check: (html) => {
      const headings = findAll(html, /<(h[1-6])\b[^>]*>([\s\S]*?)<\/\1>/gi);
      return headings
        .filter((m) => {
          const content = (m[2] ?? '').replace(/<[^>]+>/g, '').trim();
          return content === '';
        })
        .map((m) => ({
          ruleId: 'empty-heading',
          description: 'Heading element has no text content',
          impact: 'minor',
          html: m[0],
          suggestion: 'Add meaningful text to the heading or remove it',
        }));
    },
  },
  {
    id: 'tabindex',
    description: 'Elements should not have tabindex greater than zero',
    impact: 'serious',
    check: (html) => {
      const elems = findAll(html, /tabindex\s*=\s*"([^"]*)"/gi);
      return elems
        .filter((m) => parseInt(m[1], 10) > 0)
        .map((m) => ({
          ruleId: 'tabindex',
          description: 'Element has a positive tabindex value',
          impact: 'serious',
          html: m[0],
          suggestion: 'Use tabindex="0" or remove tabindex. Rely on DOM order for focus sequence.',
        }));
    },
  },
  {
    id: 'aria-hidden-focus',
    description: 'ARIA hidden elements must not contain focusable content',
    impact: 'serious',
    check: (html) => {
      const issues: HtmlIssue[] = [];
      const hiddenBlocks = findAll(html, /aria-hidden\s*=\s*"true"[^>]*>([\s\S]*?)<\//gi);
      for (const m of hiddenBlocks) {
        const inner = m[1] ?? '';
        if (/<(a|button|input|select|textarea)\b/i.test(inner) || /tabindex\s*=\s*"(?!-1)/i.test(inner)) {
          issues.push({
            ruleId: 'aria-hidden-focus',
            description: 'aria-hidden="true" element contains focusable content',
            impact: 'serious',
            html: m[0].slice(0, 200),
            suggestion: 'Remove aria-hidden="true" or add tabindex="-1" to all focusable children',
          });
        }
      }
      return issues;
    },
  },
  {
    id: 'color-contrast',
    description: 'Text must meet minimum contrast ratio',
    impact: 'serious',
    check: (html) => {
      // Heuristic: detect light-on-light or dark-on-dark inline styles
      const issues: HtmlIssue[] = [];
      const elems = findAll(html, /style\s*=\s*"([^"]*)"/gi);
      for (const m of elems) {
        const style = m[1];
        const colorMatch = /(?:^|;)\s*color\s*:\s*(white|#fff(?:fff)?|rgb\s*\(\s*255)/i.exec(style);
        const bgMatch = /background(?:-color)?\s*:\s*(white|#fff(?:fff)?|rgb\s*\(\s*255)/i.exec(style);
        if (colorMatch && bgMatch) {
          issues.push({
            ruleId: 'color-contrast',
            description: 'White text on white background detected via inline style',
            impact: 'serious',
            html: m[0],
            suggestion: 'Ensure foreground/background colors have at least 4.5:1 contrast ratio',
          });
        }
      }
      return issues;
    },
  },
  {
    id: 'nested-interactive',
    description: 'Interactive controls must not be nested',
    impact: 'serious',
    check: (html) => {
      const issues: HtmlIssue[] = [];
      // Check for <a> containing <button> or vice versa
      const anchorsWithButtons = findAll(html, /<a\b[^>]*>[\s\S]*?<button\b/gi);
      for (const m of anchorsWithButtons) {
        issues.push({
          ruleId: 'nested-interactive',
          description: 'Button nested inside a link',
          impact: 'serious',
          html: m[0].slice(0, 200),
          suggestion: 'Move the button outside the link element',
        });
      }
      const buttonsWithAnchors = findAll(html, /<button\b[^>]*>[\s\S]*?<a\b/gi);
      for (const m of buttonsWithAnchors) {
        issues.push({
          ruleId: 'nested-interactive',
          description: 'Link nested inside a button',
          impact: 'serious',
          html: m[0].slice(0, 200),
          suggestion: 'Move the link outside the button element',
        });
      }
      return issues;
    },
  },
  {
    id: 'role-img-alt',
    description: 'Elements with role="img" must have an accessible name',
    impact: 'serious',
    check: (html) => {
      const elems = findAll(html, /<[a-z][^>]*\brole\s*=\s*"img"[^>]*>/gi);
      return elems
        .filter((m) => !/\baria-label\s*=/i.test(m[0]) && !/\baria-labelledby\s*=/i.test(m[0]) && !/\balt\s*=/i.test(m[0]))
        .map((m) => ({
          ruleId: 'role-img-alt',
          description: 'Element with role="img" has no accessible name',
          impact: 'serious',
          html: m[0],
          suggestion: 'Add aria-label or aria-labelledby to provide an accessible name',
        }));
    },
  },
  {
    id: 'frame-title',
    description: 'Frames must have an accessible name',
    impact: 'serious',
    check: (html) => {
      const frames = findAll(html, /<iframe\b[^>]*>/gi);
      return frames
        .filter((m) => !/\btitle\s*=\s*"[^"]+"/i.test(m[0]) && !/\baria-label\s*=/i.test(m[0]))
        .map((m) => ({
          ruleId: 'frame-title',
          description: 'iframe is missing a title attribute',
          impact: 'serious',
          html: m[0],
          suggestion: 'Add a descriptive title attribute to the iframe',
        }));
    },
  },
  {
    id: 'select-name',
    description: 'Select elements must have an accessible name',
    impact: 'critical',
    check: (html) => {
      const selects = findAll(html, /<select\b[^>]*>/gi);
      return selects
        .filter((m) => {
          const tag = m[0];
          const hasAriaLabel = /\baria-label\s*=/i.test(tag);
          const hasAriaLabelledby = /\baria-labelledby\s*=/i.test(tag);
          const hasId = /\bid\s*=\s*"([^"]+)"/i.exec(tag);
          const hasLabelFor = hasId ? html.includes(`for="${hasId[1]}"`) : false;
          return !hasAriaLabel && !hasAriaLabelledby && !hasLabelFor;
        })
        .map((m) => ({
          ruleId: 'select-name',
          description: 'Select element is missing an accessible name',
          impact: 'critical',
          html: m[0],
          suggestion: 'Add a <label for="id"> element, aria-label, or aria-labelledby',
        }));
    },
  },
];

/**
 * Analyze an HTML string for accessibility issues using static heuristics.
 * Returns an array of detected issues (empty = clean).
 */
export function analyzeHtml(html: string): HtmlIssue[] {
  const issues: HtmlIssue[] = [];
  for (const rule of RULES) {
    issues.push(...rule.check(html));
  }
  return issues;
}

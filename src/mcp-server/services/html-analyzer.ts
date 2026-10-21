/**
 * HTML Analyzer — Static heuristic checks for 15 accessibility rules.
 *
 * Runs without a browser. Used by the check-html MCP tool and the post-edit hook
 * CLI, which runs it on HTML and on framework templates (JSX/TSX, Vue, Svelte,
 * Astro). Tags are read by a small scanner that understands quoted values,
 * `{…}` expressions (including `=>` inside them), `{...spread}` and Vue
 * `:bound` attributes, because plain `<tag[^>]*>` regexes misfire on JSX (#22).
 *
 * In framework mode only lowercase tags are native elements (`<Input>` is a
 * component), `htmlFor` counts as `for`, and anything that can't be decided
 * statically — an expression `type` or `id`, a spread, dynamic children — is
 * treated as fine. The goal is few false positives, not completeness; real
 * verification is the browser-based scanner.
 */

export interface HtmlIssue {
  ruleId: string;
  description: string;
  impact: string;
  html: string;
  suggestion: string;
  /** Offset of the offending tag in the analysed source (the hook uses it to keep only edited lines). */
  index?: number;
}

export interface AnalyzeOptions {
  /**
   * Framework template (JSX/TSX/Vue/Svelte/Astro) rather than plain HTML:
   * case-sensitive tag names, components skipped, unknown values not flagged.
   */
  framework?: boolean;
}

interface Attr {
  /** Lowercased, with htmlFor → for, className → class, and Vue :/v-bind: prefixes removed. */
  name: string;
  kind: 'string' | 'expr' | 'bare';
  value: string;
}

interface Tag {
  name: string;
  start: number;
  /** Offset just past the closing `>` of the opening tag. */
  end: number;
  raw: string;
  attrs: Attr[];
  /** Has a `{...spread}` that could supply any attribute. */
  spread: boolean;
  selfClosing: boolean;
}

interface Ctx {
  src: string;
  tags: Tag[];
  framework: boolean;
}

interface Rule {
  id: string;
  description: string;
  impact: string;
  check: (ctx: Ctx) => HtmlIssue[];
}

// ---------------------------------------------------------------------------
// Scanner
// ---------------------------------------------------------------------------

/** Index just past the `}` matching the `{` at `open`, skipping string literals. */
function skipBraces(src: string, open: number): number {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === '"' || c === "'" || c === '`') {
      const close = src.indexOf(c, i + 1);
      if (close === -1) return src.length;
      i = close;
    } else if (c === '{') {
      depth++;
    } else if (c === '}') {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return src.length;
}

function normalizeAttrName(raw: string): { name: string; bound: boolean } {
  let name = raw;
  let bound = false;
  if (name.startsWith('v-bind:')) {
    name = name.slice(7);
    bound = true;
  } else if (name.startsWith(':')) {
    name = name.slice(1);
    bound = true;
  }
  name = name.toLowerCase();
  if (name === 'htmlfor') name = 'for';
  if (name === 'classname') name = 'class';
  return { name, bound };
}

const WS = /\s/;

function scanTags(src: string): Tag[] {
  const tags: Tag[] = [];
  let i = 0;
  while ((i = src.indexOf('<', i)) !== -1) {
    // A tag name must follow `<` directly and end at whitespace, `/` or `>`,
    // so comparisons (`i < a.length`) and generics (`Array<string>`) are skipped.
    const m = /^<([A-Za-z][\w.:-]*)(?=[\s/>])/.exec(src.slice(i, i + 80));
    if (!m) {
      i++;
      continue;
    }
    let j = i + m[0].length;
    const attrs: Attr[] = [];
    let spread = false;
    let closed = false;
    let selfClosing = false;
    while (j < src.length) {
      while (j < src.length && WS.test(src[j])) j++;
      const c = src[j];
      if (c === '>') {
        closed = true;
        j++;
        break;
      }
      if (c === '/' && src[j + 1] === '>') {
        closed = true;
        selfClosing = true;
        j += 2;
        break;
      }
      if (c === '{') {
        const e = skipBraces(src, j);
        if (/^\{\s*\.\.\./.test(src.slice(j, e))) spread = true;
        j = e;
        continue;
      }
      const nm = /^[^\s=>/{"'`]+/.exec(src.slice(j, j + 200));
      if (!nm) {
        j++;
        continue;
      }
      const { name, bound } = normalizeAttrName(nm[0]);
      j += nm[0].length;
      let k = j;
      while (k < src.length && WS.test(src[k])) k++;
      if (src[k] !== '=') {
        attrs.push({ name, kind: 'bare', value: '' });
        continue;
      }
      k++;
      while (k < src.length && WS.test(src[k])) k++;
      const q = src[k];
      if (q === '"' || q === "'" || q === '`') {
        const e = src.indexOf(q, k + 1);
        if (e === -1) break;
        attrs.push({ name, kind: bound ? 'expr' : 'string', value: src.slice(k + 1, e) });
        j = e + 1;
      } else if (q === '{') {
        const e = skipBraces(src, k);
        const inner = src.slice(k + 1, e - 1).trim();
        // {"hidden"} / {'x'} / {`x`} are plain strings; anything else is dynamic.
        const lit = /^(["'`])([^"'`$]*)\1$/.exec(inner);
        attrs.push(lit ? { name, kind: 'string', value: lit[2] } : { name, kind: 'expr', value: inner });
        j = e;
      } else {
        const uv = /^[^\s>]+/.exec(src.slice(k));
        const v = uv ? uv[0].replace(/\/$/, '') : '';
        attrs.push({ name, kind: 'string', value: v });
        j = k + v.length;
      }
    }
    if (closed) {
      tags.push({ name: m[1], start: i, end: j, raw: src.slice(i, j), attrs, spread, selfClosing });
      i = j;
    } else {
      i++;
    }
  }
  return tags;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isNative(ctx: Ctx, tag: Tag, ...names: string[]): boolean {
  const n = ctx.framework ? tag.name : tag.name.toLowerCase();
  return names.includes(n);
}

function attr(tag: Tag, name: string): Attr | undefined {
  return tag.attrs.find((a) => a.name === name);
}

/** Attribute present with a non-empty string, or any dynamic value (assumed set). */
function hasValue(tag: Tag, name: string): boolean {
  const a = attr(tag, name);
  if (!a) return false;
  return a.kind === 'expr' || (a.kind === 'string' && a.value.trim() !== '');
}

/** Inner source of a non-void element, up to its first matching closing tag. */
function innerOf(ctx: Ctx, tag: Tag): string | null {
  if (tag.selfClosing) return '';
  const re = new RegExp(`</${tag.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*>`, ctx.framework ? 'g' : 'gi');
  re.lastIndex = tag.end;
  const m = re.exec(ctx.src);
  return m ? ctx.src.slice(tag.end, m.index) : null;
}

/** Could this content give the element an accessible name? Unknowns count as yes. */
function hasNameContent(ctx: Ctx, inner: string): boolean {
  // Dynamic children ({expr}, {{ vue }}, <slot>) can render text.
  if (/[{}]/.test(inner) || /<slot\b/i.test(inner)) return true;
  const inside = scanTags(inner);
  for (const t of inside) {
    if (ctx.framework && /^[A-Z]/.test(t.name)) return true; // component: unknown output
    if (t.spread) return true;
    if (hasValue(t, 'aria-label') || hasValue(t, 'aria-labelledby')) return true;
    const n = t.name.toLowerCase();
    if (n === 'img' && hasValue(t, 'alt')) return true;
    if (n === 'svg' && /<title\b[^>]*>[^<]*\S/i.test(inner)) return true;
  }
  const text = inner.replace(/<[^>]*>/g, '').replace(/&nbsp;|&#160;/g, ' ').trim();
  return text !== '';
}

/** Is `tag` inside a native <label>…</label>? */
function insideLabel(ctx: Ctx, tag: Tag): boolean {
  return ctx.tags.some((t) => {
    if (!isNative(ctx, t, 'label') || t.start >= tag.start) return false;
    const inner = innerOf(ctx, t);
    return inner !== null && tag.start < t.end + inner.length;
  });
}

/** Does a native <label for="id"> exist for this id? */
function labelFor(ctx: Ctx, id: string): boolean {
  return ctx.tags.some((t) => isNative(ctx, t, 'label') && attr(t, 'for')?.value === id);
}

/** Form-control naming shared by the label and select-name rules. */
function controlIsNamed(ctx: Ctx, tag: Tag): boolean {
  if (tag.spread) return true; // {...register('email')} / {...props} may carry a label
  if (hasValue(tag, 'aria-label') || hasValue(tag, 'aria-labelledby')) return true;
  if (insideLabel(ctx, tag)) return true;
  const id = attr(tag, 'id');
  if (id?.kind === 'expr') return true; // can't resolve id={useId()} statically
  if (id?.kind === 'string' && id.value && labelFor(ctx, id.value)) return true;
  return false;
}

function issue(rule: Pick<Rule, 'id' | 'impact'>, tag: Tag | null, description: string, suggestion: string, html?: string): HtmlIssue {
  return {
    ruleId: rule.id,
    description,
    impact: rule.impact,
    html: html ?? tag?.raw ?? '',
    suggestion,
    ...(tag ? { index: tag.start } : {}),
  };
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

const RULES: Rule[] = [
  {
    id: 'image-alt',
    description: 'Images must have alternate text',
    impact: 'critical',
    check(ctx) {
      return ctx.tags
        .filter((t) => isNative(ctx, t, 'img') && !t.spread && !attr(t, 'alt'))
        .map((t) => issue(this, t, 'Image is missing alt attribute', 'Add alt="description" (or alt="" for decorative images)'));
    },
  },
  {
    id: 'button-name',
    description: 'Buttons must have discernible text',
    impact: 'critical',
    check(ctx) {
      return ctx.tags
        .filter((t) => isNative(ctx, t, 'button') && !t.spread)
        .filter((t) => !hasValue(t, 'aria-label') && !hasValue(t, 'aria-labelledby') && !hasValue(t, 'title'))
        .filter((t) => {
          const inner = innerOf(ctx, t);
          return inner !== null && !hasNameContent(ctx, inner);
        })
        .map((t) => issue(this, t, 'Button has no accessible name', 'Add text content, aria-label, or aria-labelledby'));
    },
  },
  {
    id: 'link-name',
    description: 'Links must have discernible text',
    impact: 'serious',
    check(ctx) {
      return ctx.tags
        .filter((t) => isNative(ctx, t, 'a') && !t.spread)
        .filter((t) => !hasValue(t, 'aria-label') && !hasValue(t, 'aria-labelledby') && !hasValue(t, 'title'))
        .filter((t) => {
          const inner = innerOf(ctx, t);
          return inner !== null && !hasNameContent(ctx, inner);
        })
        .map((t) => issue(this, t, 'Link has no discernible text', 'Add visible text, aria-label, or aria-labelledby to the link'));
    },
  },
  {
    id: 'label',
    description: 'Form elements must have labels',
    impact: 'critical',
    check(ctx) {
      return ctx.tags
        .filter((t) => isNative(ctx, t, 'input'))
        .filter((t) => {
          const type = attr(t, 'type');
          if (type?.kind === 'expr') return false; // type={kind}: unknown
          if (type && /^(hidden|submit|button|reset|image)$/i.test(type.value.trim())) return false;
          return !controlIsNamed(ctx, t);
        })
        .map((t) => issue(this, t, 'Form input is missing a label', 'Add a <label for="id"> element, wrap it in a <label>, or add aria-label / aria-labelledby'));
    },
  },
  {
    id: 'html-has-lang',
    description: 'HTML element must have a lang attribute',
    impact: 'serious',
    check(ctx) {
      return ctx.tags
        .filter((t) => isNative(ctx, t, 'html') && !t.spread && !hasValue(t, 'lang'))
        .map((t) => issue(this, t, '<html> element is missing lang attribute', 'Add lang="en" (or appropriate language code) to the <html> element'));
    },
  },
  {
    id: 'document-title',
    description: 'Documents must have a title element',
    impact: 'serious',
    check(ctx) {
      // Framework layouts set the title elsewhere (Next.js metadata, vue-meta, svelte:head…).
      if (ctx.framework) return [];
      if (/<title\b[^>]*>[^<]*\S[^<]*<\/title>/i.test(ctx.src)) return [];
      if (!/<head\b/i.test(ctx.src) && !/<html\b/i.test(ctx.src)) return []; // fragment
      return [issue(this, null, 'Document is missing a <title> element', 'Add a descriptive <title> element inside <head>', '<head>...</head>')];
    },
  },
  {
    id: 'meta-viewport',
    description: 'Zooming and scaling must not be disabled',
    impact: 'critical',
    check(ctx) {
      return ctx.tags
        .filter((t) => isNative(ctx, t, 'meta') && attr(t, 'name')?.value.toLowerCase() === 'viewport')
        .filter((t) => {
          const content = attr(t, 'content')?.value ?? '';
          return /user-scalable\s*=\s*no/i.test(content) || /maximum-scale\s*=\s*1(\.0)?(?![0-9.])/i.test(content);
        })
        .map((t) => issue(this, t, 'Viewport meta tag disables user zoom', 'Remove user-scalable=no and maximum-scale restrictions'));
    },
  },
  {
    id: 'empty-heading',
    description: 'Headings must not be empty',
    impact: 'minor',
    check(ctx) {
      return ctx.tags
        .filter((t) => isNative(ctx, t, 'h1', 'h2', 'h3', 'h4', 'h5', 'h6') && !t.spread)
        .filter((t) => !hasValue(t, 'aria-label') && !hasValue(t, 'aria-labelledby'))
        .filter((t) => {
          const inner = innerOf(ctx, t);
          return inner !== null && !hasNameContent(ctx, inner);
        })
        .map((t) => issue(this, t, 'Heading element has no text content', 'Add meaningful text to the heading or remove it'));
    },
  },
  {
    id: 'tabindex',
    description: 'Elements should not have tabindex greater than zero',
    impact: 'serious',
    check(ctx) {
      return ctx.tags
        .filter((t) => {
          const a = attr(t, 'tabindex');
          return a !== undefined && /^\s*\d+\s*$/.test(a.value) && parseInt(a.value, 10) > 0;
        })
        .map((t) => issue(this, t, 'Element has a positive tabindex value', 'Use tabindex="0" or remove tabindex. Rely on DOM order for focus sequence.'));
    },
  },
  {
    id: 'aria-hidden-focus',
    description: 'ARIA hidden elements must not contain focusable content',
    impact: 'serious',
    check(ctx) {
      const issues: HtmlIssue[] = [];
      for (const t of ctx.tags) {
        if (attr(t, 'aria-hidden')?.value.trim() !== 'true') continue;
        const inner = innerOf(ctx, t);
        if (!inner) continue;
        const focusable = scanTags(inner).some((c) => {
          const n = ctx.framework ? c.name : c.name.toLowerCase();
          const ti = attr(c, 'tabindex');
          if (ti && ti.value.trim() === '-1') return false;
          if (['button', 'input', 'select', 'textarea'].includes(n)) return attr(c, 'disabled') === undefined;
          if (n === 'a') return attr(c, 'href') !== undefined;
          return ti !== undefined;
        });
        if (focusable) {
          issues.push(issue(this, t, 'aria-hidden="true" element contains focusable content', 'Remove aria-hidden="true" or add tabindex="-1" to all focusable children'));
        }
      }
      return issues;
    },
  },
  {
    id: 'color-contrast',
    description: 'Text must meet minimum contrast ratio',
    impact: 'serious',
    check(ctx) {
      // Heuristic: white-on-white inline styles only.
      const white = '(white|#fff(?:fff)?\\b|rgb\\s*\\(\\s*255\\s*,\\s*255\\s*,\\s*255)';
      return ctx.tags
        .filter((t) => {
          const style = attr(t, 'style');
          if (!style || style.kind !== 'string') return false;
          return new RegExp(`(?:^|;)\\s*color\\s*:\\s*${white}`, 'i').test(style.value) &&
            new RegExp(`background(?:-color)?\\s*:\\s*${white}`, 'i').test(style.value);
        })
        .map((t) => issue(this, t, 'White text on white background detected via inline style', 'Ensure foreground/background colors have at least 4.5:1 contrast ratio'));
    },
  },
  {
    id: 'nested-interactive',
    description: 'Interactive controls must not be nested',
    impact: 'serious',
    check(ctx) {
      const issues: HtmlIssue[] = [];
      const pairs: Array<[string, string, string, string]> = [
        ['a', 'button', 'Button nested inside a link', 'Move the button outside the link element'],
        ['button', 'a', 'Link nested inside a button', 'Move the link outside the button element'],
      ];
      for (const [outer, innerName, description, suggestion] of pairs) {
        for (const t of ctx.tags.filter((x) => isNative(ctx, x, outer))) {
          const inner = innerOf(ctx, t);
          if (inner && scanTags(inner).some((c) => (ctx.framework ? c.name : c.name.toLowerCase()) === innerName)) {
            issues.push(issue(this, t, description, suggestion, ctx.src.slice(t.start, t.end + Math.min(inner.length, 160))));
          }
        }
      }
      return issues;
    },
  },
  {
    id: 'role-img-alt',
    description: 'Elements with role="img" must have an accessible name',
    impact: 'serious',
    check(ctx) {
      return ctx.tags
        .filter((t) => !(ctx.framework && /^[A-Z]/.test(t.name)) && !t.spread)
        .filter((t) => attr(t, 'role')?.kind === 'string' && attr(t, 'role')!.value.trim() === 'img')
        .filter((t) => !hasValue(t, 'aria-label') && !hasValue(t, 'aria-labelledby') && !hasValue(t, 'alt') && !hasValue(t, 'title'))
        .map((t) => issue(this, t, 'Element with role="img" has no accessible name', 'Add aria-label or aria-labelledby to provide an accessible name'));
    },
  },
  {
    id: 'frame-title',
    description: 'Frames must have an accessible name',
    impact: 'serious',
    check(ctx) {
      return ctx.tags
        .filter((t) => isNative(ctx, t, 'iframe') && !t.spread)
        .filter((t) => !hasValue(t, 'title') && !hasValue(t, 'aria-label') && !hasValue(t, 'aria-labelledby'))
        .map((t) => issue(this, t, 'iframe is missing a title attribute', 'Add a descriptive title attribute to the iframe'));
    },
  },
  {
    id: 'select-name',
    description: 'Select elements must have an accessible name',
    impact: 'critical',
    check(ctx) {
      return ctx.tags
        .filter((t) => isNative(ctx, t, 'select') && !controlIsNamed(ctx, t))
        .map((t) => issue(this, t, 'Select element is missing an accessible name', 'Add a <label for="id"> element, wrap it in a <label>, or add aria-label / aria-labelledby'));
    },
  },
];

/**
 * Analyze an HTML string (or framework template with `framework: true`) for
 * accessibility issues using static heuristics. Returns issues (empty = clean).
 */
export function analyzeHtml(html: string, options: AnalyzeOptions = {}): HtmlIssue[] {
  const ctx: Ctx = { src: html, tags: scanTags(html), framework: options.framework === true };
  const issues: HtmlIssue[] = [];
  for (const rule of RULES) {
    issues.push(...rule.check(ctx));
  }
  return issues;
}

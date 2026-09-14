/**
 * Axe Rule → WCAG Success Criterion mapping.
 *
 * Maps axe-core rule IDs to the WCAG 2.1 criteria they test, along with
 * human-readable descriptions and default impact. Used by the aether_get_fix
 * tool (including its explanation-only mode) to enrich results even when the
 * RAG API is unavailable.
 */

export interface WcagCriterion {
  sc: string;       // e.g. "1.1.1"
  title: string;    // e.g. "Non-text Content"
  level: string;    // "A" | "AA" | "AAA"
}

export interface AxeRuleInfo {
  description: string;
  impact: string;
  wcag: WcagCriterion[];
}

export const AXE_RULE_METADATA: Record<string, AxeRuleInfo> = {
  'region': {
    description: 'All page content should be contained by landmarks',
    impact: 'moderate',
    wcag: [{ sc: '1.3.1', title: 'Info and Relationships', level: 'A' }],
  },
  'landmark-unique': {
    description: 'Ensures landmarks are unique',
    impact: 'moderate',
    wcag: [{ sc: '1.3.1', title: 'Info and Relationships', level: 'A' }],
  },
  'button-name': {
    description: 'Buttons must have discernible text',
    impact: 'critical',
    wcag: [{ sc: '4.1.2', title: 'Name, Role, Value', level: 'A' }],
  },
  'page-has-heading-one': {
    description: 'Page should contain a level-one heading',
    impact: 'moderate',
    wcag: [{ sc: '1.3.1', title: 'Info and Relationships', level: 'A' }],
  },
  'heading-order': {
    description: 'Heading levels should only increase by one',
    impact: 'moderate',
    wcag: [{ sc: '1.3.1', title: 'Info and Relationships', level: 'A' }],
  },
  'color-contrast': {
    description: 'Elements must meet minimum color contrast ratio thresholds',
    impact: 'serious',
    wcag: [{ sc: '1.4.3', title: 'Contrast (Minimum)', level: 'AA' }],
  },
  'aria-required-attr': {
    description: 'Required ARIA attributes must be provided',
    impact: 'critical',
    wcag: [{ sc: '4.1.2', title: 'Name, Role, Value', level: 'A' }],
  },
  'nested-interactive': {
    description: 'Interactive controls must not be nested',
    impact: 'serious',
    wcag: [{ sc: '4.1.2', title: 'Name, Role, Value', level: 'A' }],
  },
  'meta-viewport': {
    description: 'Zooming and scaling must not be disabled',
    impact: 'critical',
    wcag: [{ sc: '1.4.4', title: 'Resize Text', level: 'AA' }],
  },
  'link-name': {
    description: 'Links must have discernible text',
    impact: 'serious',
    wcag: [{ sc: '4.1.2', title: 'Name, Role, Value', level: 'A' }],
  },
  'landmark-one-main': {
    description: 'Document should have one main landmark',
    impact: 'moderate',
    wcag: [{ sc: '1.3.1', title: 'Info and Relationships', level: 'A' }],
  },
  'image-alt': {
    description: 'Images must have alternate text',
    impact: 'critical',
    wcag: [{ sc: '1.1.1', title: 'Non-text Content', level: 'A' }],
  },
  'aria-required-parent': {
    description: 'Required ARIA parent role must be present',
    impact: 'critical',
    wcag: [{ sc: '1.3.1', title: 'Info and Relationships', level: 'A' }],
  },
  'aria-prohibited-attr': {
    description: 'Elements must not use prohibited ARIA attributes',
    impact: 'serious',
    wcag: [{ sc: '4.1.2', title: 'Name, Role, Value', level: 'A' }],
  },
  'tabindex': {
    description: 'Elements should not have tabindex greater than zero',
    impact: 'serious',
    wcag: [{ sc: '2.4.3', title: 'Focus Order', level: 'A' }],
  },
  'scrollable-region-focusable': {
    description: 'Scrollable region must have keyboard access',
    impact: 'serious',
    wcag: [{ sc: '2.1.1', title: 'Keyboard', level: 'A' }],
  },
  'role-img-alt': {
    description: 'Elements with role="img" must have an accessible name',
    impact: 'serious',
    wcag: [{ sc: '1.1.1', title: 'Non-text Content', level: 'A' }],
  },
  'meta-viewport-large': {
    description: 'Users should be able to zoom and scale the page',
    impact: 'serious',
    wcag: [{ sc: '1.4.4', title: 'Resize Text', level: 'AA' }],
  },
  'empty-heading': {
    description: 'Headings must not be empty',
    impact: 'minor',
    wcag: [{ sc: '1.3.1', title: 'Info and Relationships', level: 'A' }],
  },
  'aria-hidden-focus': {
    description: 'ARIA hidden elements must not be focusable',
    impact: 'serious',
    wcag: [{ sc: '4.1.2', title: 'Name, Role, Value', level: 'A' }],
  },
  'aria-allowed-role': {
    description: 'ARIA role must be appropriate for the element',
    impact: 'minor',
    wcag: [{ sc: '4.1.2', title: 'Name, Role, Value', level: 'A' }],
  },
  'label': {
    description: 'Form elements must have labels',
    impact: 'critical',
    wcag: [
      { sc: '1.3.1', title: 'Info and Relationships', level: 'A' },
      { sc: '4.1.2', title: 'Name, Role, Value', level: 'A' },
    ],
  },
  'html-has-lang': {
    description: 'HTML element must have a lang attribute',
    impact: 'serious',
    wcag: [{ sc: '3.1.1', title: 'Language of Page', level: 'A' }],
  },
  'document-title': {
    description: 'Documents must have a title element',
    impact: 'serious',
    wcag: [{ sc: '2.4.2', title: 'Page Titled', level: 'A' }],
  },
  'list': {
    description: 'Lists must be structured correctly',
    impact: 'serious',
    wcag: [{ sc: '1.3.1', title: 'Info and Relationships', level: 'A' }],
  },
  'listitem': {
    description: 'List items must be within a list container',
    impact: 'serious',
    wcag: [{ sc: '1.3.1', title: 'Info and Relationships', level: 'A' }],
  },
  'definition-list': {
    description: 'Definition lists must be structured correctly',
    impact: 'serious',
    wcag: [{ sc: '1.3.1', title: 'Info and Relationships', level: 'A' }],
  },
  'select-name': {
    description: 'Select elements must have an accessible name',
    impact: 'critical',
    wcag: [{ sc: '4.1.2', title: 'Name, Role, Value', level: 'A' }],
  },
  'input-image-alt': {
    description: 'Image buttons must have alternate text',
    impact: 'critical',
    wcag: [{ sc: '1.1.1', title: 'Non-text Content', level: 'A' }],
  },
  'frame-title': {
    description: 'Frames must have an accessible name',
    impact: 'serious',
    wcag: [{ sc: '4.1.2', title: 'Name, Role, Value', level: 'A' }],
  },
};

/**
 * Look up WCAG metadata for an axe rule. Returns undefined for unknown rules.
 */
export function getRuleMetadata(ruleId: string): AxeRuleInfo | undefined {
  return AXE_RULE_METADATA[ruleId];
}

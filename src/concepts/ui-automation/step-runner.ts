import type { Page } from 'playwright';
import { runAxeOnPage as runAxe } from '../a11y-scanner/axe.ts';
import { assertSameOriginScannable } from '../a11y-scanner/url-guard.ts';
import type { Violation } from '../../types/a11y';
import type { UIAutomationSequenceResult, UIAutomationStep, UIStepExecutionWithScans } from '../../types/ui-automation';

/**
 * Coerce a ViolationNode.target (which may be string | string[] | undefined)
 * into a stable string key for deduplication. Guards against the latent
 * runtime bug where calling .join() on a bare string would throw.
 */
function targetKey(target: string | string[] | undefined): string {
  if (Array.isArray(target)) return target.join('');
  return target || '';
}

/**
 * Merge and deduplicate violations by their id and impact
 */
function mergeViolations(violations: Violation[][]): Violation[] {
  const violationMap = new Map<string, Violation>();

  for (const group of violations) {
    for (const violation of group) {
      const key = `${violation.id}`;
      if (!violationMap.has(key)) {
        violationMap.set(key, violation);
      } else {
        // Merge nodes if the violation already exists
        const existing = violationMap.get(key)!;
        if (violation.nodes && existing.nodes) {
          const nodeIds = new Set(existing.nodes.map(n => n.html || targetKey(n.target)));
          const uniqueNewNodes = violation.nodes.filter(n => !nodeIds.has(n.html || targetKey(n.target)));
          existing.nodes = [...existing.nodes, ...uniqueNewNodes];
        }
      }
    }
  }

  return Array.from(violationMap.values());
}

export async function runUIAutomationSequenceWithScans(
  page: Page,
  steps: UIAutomationStep[],
  initialViolations: Violation[]
): Promise<UIAutomationSequenceResult> {
  const stepExecutions: UIStepExecutionWithScans[] = [];
  const trueInitialViolations = [...initialViolations];
  const allViolationsCollected: Violation[][] = [trueInitialViolations];

  let currentViolations = initialViolations;

  for (const step of steps) {
    const start = Date.now();
    let success = false;
    let error: string | undefined;
    let violationsAfterStep: Violation[] | undefined;

    try {
      await runSingleStep(page, step);
      success = true;
      const axeResult = await runAxe(page, undefined);
      violationsAfterStep = axeResult.violations;
      if (violationsAfterStep) {
        allViolationsCollected.push(violationsAfterStep);
      }
    } catch (err) {
      error = (err as Error).message;
    }

    stepExecutions.push({
      step,
      success,
      error,
      stepDurationMs: Date.now() - start,
      violationsBeforeStep: currentViolations,
      violationsAfterStep,
    });

    // Continue running remaining steps even if this one failed
    // to capture all errors and violations across the entire sequence

    if (violationsAfterStep) {
      currentViolations = violationsAfterStep;
    }
  }

  return {
    initialViolations: trueInitialViolations,
    stepExecutions,
    allViolationsFound: mergeViolations(allViolationsCollected),
  };
}

async function runSingleStep(page: Page, step: UIAutomationStep): Promise<void> {
  switch (step.action) {
    case 'navigate': {
      if (!step.value) {
        throw new Error('navigate step requires a value URL');
      }
      // Steps come from a JSON file / SPA config — never trust the target.
      // Must be http(s), not a metadata host, and on the SAME ORIGIN as the
      // page currently being scanned (relative values resolve against it).
      const current = page.url();
      if (!/^https?:/i.test(current)) {
        throw new Error('navigate step requires a loaded http(s) page to resolve against');
      }
      const target = new URL(step.value, current).toString();
      assertSameOriginScannable(target, current);
      await page.goto(target, { timeout: step.timeoutMs ?? 30000 });
      break;
    }

    case 'click':
      if (!step.selector) {
        throw new Error('click step requires a selector');
      }
      await page.click(step.selector, { timeout: step.timeoutMs ?? 10000 });
      break;

    case 'fill':
      if (!step.selector || step.value === undefined) {
        throw new Error('fill step requires selector and value');
      }
      await page.fill(step.selector, step.value, { timeout: step.timeoutMs ?? 10000 });
      break;

    case 'press':
      if (!step.selector || !step.value) {
        throw new Error('press step requires selector and value');
      }
      await page.press(step.selector, step.value, { timeout: step.timeoutMs ?? 10000 });
      break;

    case 'waitForSelector':
      if (!step.selector) {
        throw new Error('waitForSelector step requires selector');
      }
      await page.waitForSelector(step.selector, { timeout: step.timeoutMs ?? 10000 });
      break;

    case 'wait':
      if (!step.value) {
        throw new Error('wait step requires value milliseconds');
      }
      const waitMs = parseInt(step.value, 10);
      if (Number.isNaN(waitMs)) {
        throw new Error(`Invalid wait value: ${step.value}`);
      }
      await page.waitForTimeout(waitMs);
      break;

    case 'assert':
    case 'assertText':
      if (!step.selector || step.value === undefined) {
        throw new Error(`${step.action} step requires selector and expected value`);
      }
      {
        const text = await page.textContent(step.selector);
        if (text === null || !text.includes(step.value)) {
          throw new Error(`Text assertion failed (expected to include: ${step.value}, got: ${text})`);
        }
      }
      break;

    case 'type':
      if (!step.selector || step.value === undefined) {
        throw new Error('type step requires selector and value');
      }
      await page.fill(step.selector, step.value, { timeout: step.timeoutMs ?? 10000 });
      break;

    case 'select':
      if (!step.selector || step.value === undefined) {
        throw new Error('select step requires selector and value');
      }
      await page.selectOption(step.selector, step.value, { timeout: step.timeoutMs ?? 10000 });
      break;

    case 'evaluate':
      // Removed: this used to eval() arbitrary JS from the step file inside the
      // scanned page. Step files are data, not code.
      throw new Error('evaluate step type is not supported');

    default:
      throw new Error(`Unsupported UI action: ${step.action}`);
  }
}

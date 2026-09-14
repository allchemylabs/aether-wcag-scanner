import type { Page } from 'playwright';
import type { Violation } from './a11y';

export type UIActionType = 'navigate' | 'click' | 'fill' | 'type' | 'select' | 'press' | 'waitForSelector' | 'wait' | 'assert' | 'assertText' | 'evaluate';

export interface UIAutomationStep {
  name: string;
  action: UIActionType;
  selector?: string;
  value?: string;
  timeoutMs?: number;
}

export interface UIAutomationResult {
  step: UIAutomationStep;
  success: boolean;
  error?: string;
  durationMs: number;
}

export interface UIStepExecutionWithScans {
  step: UIAutomationStep;
  success: boolean;
  error?: string;
  stepDurationMs: number;
  violationsBeforeStep: Violation[];
  violationsAfterStep?: Violation[];
}

export interface UIAutomationSequenceResult {
  initialViolations: Violation[];
  stepExecutions: UIStepExecutionWithScans[];
  allViolationsFound: Violation[];
}

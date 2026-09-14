import type { Violation } from '../../types/a11y';

export interface ViolationStats {
  critical: number;
  serious: number;
  moderate: number;
  minor: number;
  total: number;
}

export function calculateViolationStats(violations: Violation[]): ViolationStats {
  return {
    critical: violations.filter(v => v.impact === 'critical').reduce((sum, v) => sum + (v.nodes?.length || 1), 0),
    serious: violations.filter(v => v.impact === 'serious').reduce((sum, v) => sum + (v.nodes?.length || 1), 0),
    moderate: violations.filter(v => v.impact === 'moderate').reduce((sum, v) => sum + (v.nodes?.length || 1), 0),
    minor: violations.filter(v => v.impact === 'minor').reduce((sum, v) => sum + (v.nodes?.length || 1), 0),
    total: violations.reduce((sum, v) => sum + (v.nodes?.length || 1), 0),
  };
}

const SEVERITY_LEVELS: Record<string, number> = {
  critical: 4,
  serious: 3,
  moderate: 2,
  minor: 1,
};

export function meetsThreshold(impact: string | undefined, failOn: string): boolean {
  const level = SEVERITY_LEVELS[impact || 'minor'] || 0;
  const threshold = SEVERITY_LEVELS[failOn] || 0;
  return level >= threshold;
}

export function countViolationsAtOrAbove(violations: Violation[], failOn: string): number {
  return violations
    .filter(v => meetsThreshold(v.impact, failOn))
    .reduce((sum, v) => sum + (v.nodes?.length || 1), 0);
}

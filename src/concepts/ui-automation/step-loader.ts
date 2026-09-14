import fs from 'fs/promises';
import path from 'path';
import type { UIAutomationStep } from '../../types/ui-automation';

/**
 * Load the UI-automation step sequence for a URL.
 *
 * OPT-IN ONLY: steps are read from `$UI_STEPS_DIR/<sanitised-host-path>.json`
 * and nothing is loaded unless `UI_STEPS_DIR` is explicitly set. There is no
 * default `ui-steps/` directory any more — a step file drives clicks, form
 * fills and navigations in a real browser, so silently picking one up from the
 * current working directory (e.g. a cloned repository) is not acceptable.
 *
 * CLI callers (pipeline-runner / a11y-scanner index) that want step files
 * should export `UI_STEPS_DIR=ui-steps` (or any path). The MCP server never
 * loads steps: ClusterScanner is constructed with `uiAutomation: false` there,
 * so this function is not even consulted.
 */
export async function loadUIAutomationSteps(url: string): Promise<UIAutomationStep[]> {
  const stepsDir = process.env.UI_STEPS_DIR;
  if (!stepsDir) {
    return [];
  }
  const fileName = sanitizeUrlToFileName(url) + '.json';
  const filePath = path.join(stepsDir, fileName);

  try {
    const content = await fs.readFile(filePath, 'utf-8');
    const steps = JSON.parse(content) as UIAutomationStep[];
    if (!Array.isArray(steps)) {
      throw new Error(`UI automation step file must be an array of steps: ${filePath}`);
    }
    return steps;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw error;
  }
}

function sanitizeUrlToFileName(url: string): string {
  return url
    .replace(/^https?:\/\//i, '')
    .replace(/\/+$/g, '')
    .replace(/\W+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();
}

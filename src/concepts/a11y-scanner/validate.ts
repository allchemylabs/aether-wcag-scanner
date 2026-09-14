#!/usr/bin/env node
/**
 * Validate - Pre-commit validation script
 *
 * Runs a suite of checks before committing code:
 * 1. TypeScript compilation (tsc --noEmit)
 * 2. Module import resolution
 * 3. Environment variable documentation
 * 4. Python syntax check
 *
 * Exit codes:
 *   0 = all checks passed
 *   1 = one or more checks failed
 *
 * Usage:
 *   npx ts-node validate.ts
 *   npm run validate
 */

import { execSync } from 'child_process';
import { readFileSync, existsSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import colors from 'picocolors';

const PROJECT_ROOT = join(import.meta.dirname || __dirname, '..', '..', '..');

// ============================================================================
// Check Runner
// ============================================================================

interface CheckResult {
  name: string;
  passed: boolean;
  message: string;
  details?: string[];
}

const results: CheckResult[] = [];

function addResult(result: CheckResult): void {
  results.push(result);

  const icon = result.passed ? colors.green('✓') : colors.red('✗');
  process.stderr.write(`  ${icon} ${result.name}: ${result.message}\n`);

  if (!result.passed && result.details) {
    for (const detail of result.details) {
      process.stderr.write(`    ${colors.gray('→')} ${detail}\n`);
    }
  }
}

// ============================================================================
// Check 1: TypeScript Compilation
// ============================================================================

function checkTypeScript(): void {
  try {
    execSync('npx tsc --noEmit 2>&1', {
      cwd: PROJECT_ROOT,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    addResult({
      name: 'TypeScript',
      passed: true,
      message: 'No compilation errors',
    });
  } catch (err: any) {
    const output = (err.stdout || err.stderr || '').trim();
    const errorLines = output.split('\n').filter((l: string) => l.includes('error TS'));

    addResult({
      name: 'TypeScript',
      passed: false,
      message: `${errorLines.length} compilation error(s)`,
      details: errorLines.slice(0, 10),
    });
  }
}

// ============================================================================
// Check 2: Module Import Resolution
// ============================================================================

function checkImports(): void {
  const scannerDir = join(PROJECT_ROOT, 'src', 'concepts', 'a11y-scanner');
  const issues: string[] = [];

  try {
    const files = readdirSync(scannerDir).filter(f => f.endsWith('.ts'));

    for (const file of files) {
      const content = readFileSync(join(scannerDir, file), 'utf-8');
      const importRegex = /from\s+['"](.+?)['"]/g;
      let match;

      while ((match = importRegex.exec(content)) !== null) {
        const importPath = match[1];

        // Check relative imports
        if (importPath.startsWith('./') || importPath.startsWith('../')) {
          const resolvedBase = importPath.replace(/\.ts$/, '');
          const withTs = join(scannerDir, resolvedBase + '.ts');
          const withDTs = join(scannerDir, resolvedBase + '.d.ts');
          const asDir = join(scannerDir, resolvedBase, 'index.ts');

          if (!existsSync(withTs) && !existsSync(withDTs) && !existsSync(asDir)) {
            // Check if it resolves from project root for ../types paths
            const fromFile = join(scannerDir, importPath.replace(/\.ts$/, '') + '.ts');
            const fromFileAlt = join(scannerDir, importPath.replace(/\.ts$/, '') + '.d.ts');
            if (!existsSync(fromFile) && !existsSync(fromFileAlt)) {
              issues.push(`${file}: unresolved import '${importPath}'`);
            }
          }
        }
      }
    }

    if (issues.length === 0) {
      addResult({
        name: 'Imports',
        passed: true,
        message: 'All scanner imports resolve',
      });
    } else {
      addResult({
        name: 'Imports',
        passed: false,
        message: `${issues.length} unresolved import(s)`,
        details: issues,
      });
    }
  } catch (err) {
    addResult({
      name: 'Imports',
      passed: false,
      message: `Check failed: ${(err as Error).message}`,
    });
  }
}

// ============================================================================
// Check 3: Environment Variable Documentation
// ============================================================================

function checkEnvDocs(): void {
  const envExamplePath = join(PROJECT_ROOT, '.env.example');

  if (!existsSync(envExamplePath)) {
    addResult({
      name: 'Env Docs',
      passed: false,
      message: '.env.example file not found',
    });
    return;
  }

  const envExample = readFileSync(envExamplePath, 'utf-8');

  // Scan source for process.env references
  const srcDir = join(PROJECT_ROOT, 'src');
  const envVarsUsed = new Set<string>();
  const undocumented: string[] = [];

  function scanDir(dir: string): void {
    try {
      const entries = readdirSync(dir);
      for (const entry of entries) {
        const fullPath = join(dir, entry);
        try {
          const stat = statSync(fullPath);
          if (stat.isDirectory() && entry !== 'node_modules' && entry !== '__pycache__' && entry !== 'venv' && !entry.startsWith('.')) {
            scanDir(fullPath);
          } else if (entry.endsWith('.ts')) {
            const content = readFileSync(fullPath, 'utf-8');
            const matches = content.matchAll(/process\.env\.(\w+)/g);
            for (const m of matches) {
              envVarsUsed.add(m[1]);
            }
          }
        } catch { /* skip */ }
      }
    } catch { /* skip */ }
  }

  scanDir(srcDir);

  // Check which env vars are not documented
  for (const envVar of envVarsUsed) {
    // Skip common Node.js env vars
    if (['NODE_ENV', 'PATH', 'HOME', 'DEBUG'].includes(envVar)) continue;

    if (!envExample.includes(envVar)) {
      undocumented.push(envVar);
    }
  }

  if (undocumented.length === 0) {
    addResult({
      name: 'Env Docs',
      passed: true,
      message: `All ${envVarsUsed.size} env vars documented`,
    });
  } else {
    addResult({
      name: 'Env Docs',
      passed: false,
      message: `${undocumented.length} env var(s) not in .env.example`,
      details: undocumented.map(v => `Missing: ${v}`),
    });
  }
}

// ============================================================================
// Check 4: Python Syntax Check
// ============================================================================

function checkPythonSyntax(): void {
  const pythonDir = join(PROJECT_ROOT, 'src', 'concepts', 'insights-engine');

  if (!existsSync(pythonDir)) {
    addResult({
      name: 'Python',
      passed: true,
      message: 'No Python source directory found (skipped)',
    });
    return;
  }

  const pyFiles: string[] = [];
  function findPyFiles(dir: string): void {
    try {
      const entries = readdirSync(dir);
      for (const entry of entries) {
        const fullPath = join(dir, entry);
        try {
          const stat = statSync(fullPath);
          if (stat.isDirectory() && entry !== '__pycache__' && entry !== 'venv' && entry !== '.venv') {
            findPyFiles(fullPath);
          } else if (entry.endsWith('.py')) {
            pyFiles.push(fullPath);
          }
        } catch { /* skip */ }
      }
    } catch { /* skip */ }
  }

  findPyFiles(pythonDir);

  if (pyFiles.length === 0) {
    addResult({
      name: 'Python',
      passed: true,
      message: 'No .py files found (skipped)',
    });
    return;
  }

  const failures: string[] = [];

  for (const pyFile of pyFiles) {
    try {
      execSync(`python3 -m py_compile "${pyFile}" 2>&1`, {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err: any) {
      const relPath = pyFile.replace(PROJECT_ROOT + '/', '');
      const output = (err.stderr || err.stdout || '').trim();
      failures.push(`${relPath}: ${output.split('\n').pop()}`);
    }
  }

  if (failures.length === 0) {
    addResult({
      name: 'Python',
      passed: true,
      message: `${pyFiles.length} file(s) syntax OK`,
    });
  } else {
    addResult({
      name: 'Python',
      passed: false,
      message: `${failures.length} syntax error(s)`,
      details: failures,
    });
  }
}

// ============================================================================
// Main
// ============================================================================

const line = '─'.repeat(52);
process.stderr.write(`\n${colors.cyan(line)}\n`);
process.stderr.write(`  ${colors.cyan('ALLCHEMY PRE-COMMIT VALIDATION')}\n`);
process.stderr.write(`${colors.cyan(line)}\n\n`);

checkTypeScript();
checkImports();
checkEnvDocs();
checkPythonSyntax();

// Summary
process.stderr.write(`\n${line}\n`);

const passed = results.filter(r => r.passed).length;
const failed = results.filter(r => !r.passed).length;

if (failed === 0) {
  process.stderr.write(`  ${colors.green(`All ${passed} checks passed`)}\n`);
} else {
  process.stderr.write(`  ${colors.red(`${failed} check(s) failed`)}, ${passed} passed\n`);
}

process.stderr.write(`${line}\n\n`);

process.exit(failed > 0 ? 1 : 0);

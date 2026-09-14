/**
 * SPA Config Loader
 * =================
 *
 * Loads + validates an SPAScanConfig JSON file. Produces clear error messages
 * for common mistakes and refuses legacy configs that would reintroduce the
 * `networkidle` footgun.
 */

import { readFileSync } from 'fs';
import type {
  SPAScanConfig,
  SPAFramework,
  SPARouteConfig,
  SPADiscoveryMode,
} from '../../types/spa-config';

const VALID_FRAMEWORKS: SPAFramework[] = ['angular', 'react', 'vue', 'generic'];
const VALID_DISCOVERY_MODES: SPADiscoveryMode[] = ['manual', 'auto', 'both'];

export class SPAConfigError extends Error {
  constructor(message: string) {
    super(`SPA config: ${message}`);
    this.name = 'SPAConfigError';
  }
}

/**
 * Load and validate an SPA config file. Throws SPAConfigError with a clear
 * message on any validation failure.
 */
export function loadSPAConfig(path: string): SPAScanConfig {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch (err) {
    throw new SPAConfigError(`could not read file "${path}": ${(err as Error).message}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new SPAConfigError(`invalid JSON in "${path}": ${(err as Error).message}`);
  }

  return validateSPAConfig(parsed, path);
}

/**
 * Validate a parsed config object. Separated from loadSPAConfig so it can be
 * exercised directly in unit tests without touching the filesystem.
 */
export function validateSPAConfig(parsed: unknown, sourcePath = '<inline>'): SPAScanConfig {
  if (!isObject(parsed)) {
    throw new SPAConfigError(`${sourcePath}: root must be an object`);
  }

  // ---- GUARDRAIL: refuse networkIdle-style legacy config ----
  //
  // This is the #1 anti-pattern we're differentiating against. Any config
  // that explicitly sets `networkIdle: true` (or similar) is refused with
  // a loud error telling the user what to do instead.
  if ('networkIdle' in parsed) {
    throw new SPAConfigError(
      `${sourcePath}: "networkIdle" is not supported. This scanner uses a ` +
        `layered stability cascade instead (see the SPA section of the README). ` +
        `Remove the "networkIdle" key from your config.`,
    );
  }
  if ('waitForLoadState' in parsed) {
    throw new SPAConfigError(
      `${sourcePath}: "waitForLoadState" is not configurable. The scanner uses ` +
        `the stability cascade defined in spa-stability.ts. Remove this key.`,
    );
  }

  // ---- entryUrl ----
  const entryUrl = parsed.entryUrl;
  if (typeof entryUrl !== 'string' || !/^https?:\/\//.test(entryUrl)) {
    throw new SPAConfigError(
      `${sourcePath}: "entryUrl" is required and must start with http:// or https://`,
    );
  }

  // ---- framework ----
  const framework = parsed.framework;
  if (typeof framework !== 'string' || !VALID_FRAMEWORKS.includes(framework as SPAFramework)) {
    throw new SPAConfigError(
      `${sourcePath}: "framework" must be one of ${VALID_FRAMEWORKS.join(', ')}`,
    );
  }

  // ---- discovery ----
  if (!isObject(parsed.discovery)) {
    throw new SPAConfigError(`${sourcePath}: "discovery" must be an object`);
  }
  const discoveryMode = parsed.discovery.mode;
  if (
    typeof discoveryMode !== 'string' ||
    !VALID_DISCOVERY_MODES.includes(discoveryMode as SPADiscoveryMode)
  ) {
    throw new SPAConfigError(
      `${sourcePath}: "discovery.mode" must be one of ${VALID_DISCOVERY_MODES.join(', ')}`,
    );
  }
  // ---- routes ----
  // In manual mode, routes are required. In auto/both mode, routes are optional
  // (auto-discovery will find them).
  if (discoveryMode === 'manual') {
    if (!Array.isArray(parsed.routes)) {
      throw new SPAConfigError(`${sourcePath}: "routes" must be an array`);
    }
    if (parsed.routes.length === 0) {
      throw new SPAConfigError(`${sourcePath}: "routes" must contain at least one route`);
    }
  } else if (parsed.routes !== undefined && !Array.isArray(parsed.routes)) {
    throw new SPAConfigError(`${sourcePath}: "routes" must be an array when provided`);
  }
  const rawRoutes = Array.isArray(parsed.routes) ? parsed.routes : [];
  const routes: SPARouteConfig[] = rawRoutes.map((r, idx) =>
    validateRoute(r, `${sourcePath}:routes[${idx}]`),
  );

  // ---- stability (optional) ----
  let stability: SPAScanConfig['stability'];
  if (parsed.stability !== undefined) {
    if (!isObject(parsed.stability)) {
      throw new SPAConfigError(`${sourcePath}: "stability" must be an object when provided`);
    }
    stability = {
      mutationDebounceMs: asPositiveIntOrUndefined(
        parsed.stability.mutationDebounceMs,
        `${sourcePath}:stability.mutationDebounceMs`,
      ),
      angularTestabilityTimeoutMs: asPositiveIntOrUndefined(
        parsed.stability.angularTestabilityTimeoutMs,
        `${sourcePath}:stability.angularTestabilityTimeoutMs`,
      ),
      maxTimeoutMs: asPositiveIntOrUndefined(
        parsed.stability.maxTimeoutMs,
        `${sourcePath}:stability.maxTimeoutMs`,
      ),
    };
  }

  // ---- auth (optional) ----
  let auth: SPAScanConfig['auth'];
  if (parsed.auth !== undefined) {
    if (!isObject(parsed.auth)) {
      throw new SPAConfigError(`${sourcePath}: "auth" must be an object when provided`);
    }
    if (!Array.isArray(parsed.auth.steps)) {
      throw new SPAConfigError(`${sourcePath}: "auth.steps" must be an array`);
    }
    // UIAutomationStep validation is intentionally lightweight here — the
    // step-runner will surface clearer per-step errors at execution time.
    auth = { steps: parsed.auth.steps };
  }

  return {
    entryUrl,
    framework: framework as SPAFramework,
    discovery: {
      mode: discoveryMode as SPADiscoveryMode,
      ...(Array.isArray(parsed.discovery.excludePatterns) && {
        excludePatterns: parsed.discovery.excludePatterns,
      }),
      ...(typeof parsed.discovery.maxRoutes === 'number' && {
        maxRoutes: parsed.discovery.maxRoutes,
      }),
    },
    routes,
    ...(stability && { stability }),
    ...(auth && { auth }),
  };
}

// ----------------------------------------------------------------------------
// Route validation
// ----------------------------------------------------------------------------

function validateRoute(value: unknown, ctx: string): SPARouteConfig {
  if (!isObject(value)) {
    throw new SPAConfigError(`${ctx}: must be an object`);
  }
  if (typeof value.path !== 'string' || value.path.length === 0) {
    throw new SPAConfigError(`${ctx}.path: must be a non-empty string`);
  }
  if (typeof value.name !== 'string' || value.name.length === 0) {
    throw new SPAConfigError(
      `${ctx}.name: must be a non-empty string (used as part of the ` +
        `state fingerprint to distinguish multiple states of the same URL)`,
    );
  }

  const route: SPARouteConfig = {
    path: value.path,
    name: value.name,
  };

  if (value.interactions !== undefined) {
    if (!Array.isArray(value.interactions)) {
      throw new SPAConfigError(`${ctx}.interactions: must be an array when provided`);
    }
    route.interactions = value.interactions;
  }

  if (value.waitForSelector !== undefined) {
    if (typeof value.waitForSelector !== 'string') {
      throw new SPAConfigError(`${ctx}.waitForSelector: must be a string when provided`);
    }
    route.waitForSelector = value.waitForSelector;
  }

  if (value.stabilityOverrides !== undefined) {
    if (!isObject(value.stabilityOverrides)) {
      throw new SPAConfigError(`${ctx}.stabilityOverrides: must be an object when provided`);
    }
    route.stabilityOverrides = {
      mutationDebounceMs: asPositiveIntOrUndefined(
        value.stabilityOverrides.mutationDebounceMs,
        `${ctx}.stabilityOverrides.mutationDebounceMs`,
      ),
      angularTestabilityTimeoutMs: asPositiveIntOrUndefined(
        value.stabilityOverrides.angularTestabilityTimeoutMs,
        `${ctx}.stabilityOverrides.angularTestabilityTimeoutMs`,
      ),
      maxTimeoutMs: asPositiveIntOrUndefined(
        value.stabilityOverrides.maxTimeoutMs,
        `${ctx}.stabilityOverrides.maxTimeoutMs`,
      ),
    };
  }

  return route;
}

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asPositiveIntOrUndefined(value: unknown, ctx: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || !Number.isInteger(value)) {
    throw new SPAConfigError(`${ctx}: must be a positive integer`);
  }
  return value;
}

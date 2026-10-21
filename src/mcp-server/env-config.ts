/**
 * Clean up config values the MCP host handed us without filling them in.
 *
 * The plugin's .mcp.json passes ALLCHEMY_API_KEY="${user_config.api_key}". When the
 * user never set the key (a terminal `claude plugin install` does not prompt for it),
 * Claude Code passes the value on in one of two ways:
 *   - as an empty string, or
 *   - as the literal, unsubstituted "${user_config.api_key}" text (seen in the
 *     insights-api logs on 2026-10-19 as "unknown key prefix=${user_c").
 * Either way the variable is present, so dotenv treats it as already set and never
 * reads the project's .env, and the placeholder is sent to the cloud as a key and
 * rejected with "Invalid API key". Treat both as unset.
 */

const PLACEHOLDER = /^\$\{[^}]*\}$/;

/** True for a value that is really "not configured": empty, or an unfilled ${...} placeholder. */
export function isUnsetConfigValue(value: string | undefined): boolean {
  if (value === undefined) return false;
  const trimmed = value.trim();
  return trimmed === '' || PLACEHOLDER.test(trimmed);
}

/** Delete each named variable whose value is empty or an unfilled placeholder. */
export function clearUnsetConfigValues(names: string[], env: NodeJS.ProcessEnv = process.env): void {
  for (const name of names) {
    if (isUnsetConfigValue(env[name])) delete env[name];
  }
}

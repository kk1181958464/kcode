/**
 * Project Config Denylist — security boundary for project-level configuration.
 *
 * Prevents workspace-scoped configuration (e.g., .kcode/config.json or similar)
 * from overriding security-sensitive global settings. This protects against
 * supply-chain attacks where a malicious repo includes config that redirects
 * API calls or grants elevated permissions.
 *
 * Usage: sanitizeProjectConfig(rawConfig) before merging into app settings.
 */

/**
 * Keys that MUST NOT be overridden by project-level configuration.
 * These are security-critical settings that should only come from
 * user-level (global) configuration.
 */
export const DENYLIST: readonly string[] = [
  // API and provider configuration
  "providerUrl",
  "baseUrl",
  "apiUrl",
  "apiKey",
  "apiSecret",
  "accessToken",
  "secretKey",
  "authToken",
  "bearerToken",
  "modelProvider",
  "providers",
  "provider",

  // Network and host restrictions
  "allowedHosts",
  "trustedDomains",
  "proxyUrl",
  "proxy",
  "sslVerify",
  "tlsReject",
  "NODE_TLS_REJECT_UNAUTHORIZED",

  // Permission escalation
  "permissionMode",
  "autoApprove",
  "skipVerification",
  "disableVerification",
  "fullAccess",
  "allowUnsafe",
  "dangerouslyDisableAllSecurity",

  // Shell/command overrides
  "shell",
  "shellPath",
  "shellArgs",
  "terminalPath",
  "preCommand",
  "postCommand",
  "initScript",

  // Plugin/extension loading
  "plugins",
  "extensions",
  "loadExtensions",
  "customTools",
  "mcpServers",

  // Update and telemetry
  "updateUrl",
  "telemetryEndpoint",
  "analyticsUrl",
  "crashReportUrl",
];

/**
 * Deep key paths that are also denied (for nested config structures).
 * Format: "parent.child" — checked against dot-separated paths.
 */
export const DENYLIST_PATHS: readonly string[] = [
  "network.proxy",
  "network.allowedHosts",
  "security.permissions",
  "security.autoApprove",
  "agent.apiKey",
  "agent.baseUrl",
  "agent.provider",
];

export interface SanitizeResult {
  /** The sanitized config with denied keys removed */
  config: Record<string, unknown>;
  /** Keys that were stripped (for warning the user) */
  strippedKeys: string[];
}

/**
 * Remove security-sensitive keys from a project config object.
 * Returns the sanitized config and a list of stripped keys for user notification.
 */
export function sanitizeProjectConfig(
  raw: Record<string, unknown>,
): SanitizeResult {
  const strippedKeys: string[] = [];
  const config = sanitizeObject(raw, "", strippedKeys);
  return { config, strippedKeys };
}

function sanitizeObject(
  obj: Record<string, unknown>,
  prefix: string,
  stripped: string[],
): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(obj)) {
    const fullPath = prefix ? `${prefix}.${key}` : key;

    // Check top-level denylist
    if (DENYLIST.includes(key)) {
      stripped.push(fullPath);
      continue;
    }

    // Check path-based denylist
    if (DENYLIST_PATHS.includes(fullPath)) {
      stripped.push(fullPath);
      continue;
    }

    // Check for keys that look like secrets by naming pattern
    if (looksLikeSecret(key)) {
      stripped.push(fullPath);
      continue;
    }

    // Recurse into nested objects (but not arrays)
    if (value && typeof value === "object" && !Array.isArray(value)) {
      result[key] = sanitizeObject(
        value as Record<string, unknown>,
        fullPath,
        stripped,
      );
    } else {
      result[key] = value;
    }
  }

  return result;
}

/**
 * Heuristic: key names that likely contain secrets.
 */
function looksLikeSecret(key: string): boolean {
  const lower = key.toLowerCase();
  return (
    lower.endsWith("_key") ||
    lower.endsWith("_secret") ||
    lower.endsWith("_token") ||
    lower.endsWith("_password") ||
    lower.endsWith("password") ||
    lower === "credentials" ||
    lower === "secret" ||
    lower === "privatekey" ||
    lower === "private_key"
  );
}

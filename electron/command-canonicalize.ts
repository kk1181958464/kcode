/**
 * Command Canonicalization — normalize shell commands before comparison so that
 * insignificant differences (extra whitespace, quote style, path separators,
 * env-var prefixes) don't prevent approval-cache matches.
 *
 * Inspired by Codex CLI's command matching that recognizes structurally-identical
 * commands even when surface syntax varies.
 */

/**
 * Canonicalize a shell command string for comparison purposes.
 * Returns a normalized form where insignificant differences are removed.
 *
 * Normalizations applied:
 * 1. Collapse consecutive whitespace to single space
 * 2. Trim leading/trailing whitespace
 * 3. Normalize Windows path separators to forward slashes
 * 4. Strip unnecessary outer quotes from simple arguments
 * 5. Normalize common executable path prefixes (node_modules/.bin/, ./, npx)
 * 6. Lowercase the executable name (commands are case-insensitive on Windows)
 * 7. Separate env-var assignments from the actual command
 */
export function canonicalizeCommand(command: string): string {
  let normalized = command
    // Normalize path separators BEFORE tokenizing (\ is path sep, not escape on Windows)
    .replace(/\\/g, "/")
    // Collapse whitespace
    .replace(/\s+/g, " ")
    .trim();

  if (!normalized) return "";

  // Split into env assignments and command (env vars are stripped for comparison)
  const { rest } = splitEnvPrefix(normalized);

  // Tokenize the command portion (quotes are preserved for multi-word args)
  const tokens = shellTokenize(rest);
  if (!tokens.length) return "";

  // Normalize the executable (first token)
  tokens[0] = normalizeExecutable(tokens[0]);

  // Normalize each argument token
  for (let i = 1; i < tokens.length; i++) {
    tokens[i] = normalizeArgument(tokens[i]);
  }

  return tokens.join(" ");
}

/**
 * Extract leading KEY=VALUE assignments from a command line.
 * e.g., "NODE_ENV=test CI=1 npm test" → { envVars: "CI=1 NODE_ENV=test", rest: "npm test" }
 */
function splitEnvPrefix(command: string): { envVars: string; rest: string } {
  const parts = command.split(" ");
  const envParts: string[] = [];
  let i = 0;

  while (i < parts.length && /^[A-Z_][A-Z0-9_]*=/.test(parts[i])) {
    envParts.push(parts[i]);
    i++;
  }

  // Sort env vars for deterministic comparison
  envParts.sort();

  return {
    envVars: envParts.join(" "),
    rest: parts.slice(i).join(" "),
  };
}

/**
 * Simple shell tokenizer that respects quotes.
 * Backslashes are NOT treated as escape chars — they were already normalized
 * to forward slashes before tokenization (Windows path support).
 * Multi-word quoted args are kept as a single token WITH surrounding quotes
 * so they remain distinguishable from multiple separate args.
 */
function shellTokenize(command: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let inSingle = false;
  let inDouble = false;
  let quotedMultiWord = false;

  for (const char of command) {
    if (char === "'" && !inDouble) {
      inSingle = !inSingle;
      current += char;
      continue;
    }
    if (char === '"' && !inSingle) {
      inDouble = !inDouble;
      current += char;
      continue;
    }
    if (char === " " && !inSingle && !inDouble) {
      if (current) {
        tokens.push(current);
        current = "";
        quotedMultiWord = false;
      }
      continue;
    }
    if (inSingle || inDouble) quotedMultiWord = true;
    current += char;
  }
  if (current) tokens.push(current);

  // Strip quotes from single-word tokens only (no spaces inside)
  return tokens.map((token) => {
    // Check if it's a quoted single word (quotes around a token with no spaces)
    const stripped = token.replace(/^(['"])(.*)\1$/, "$2");
    if (stripped !== token && !stripped.includes(" ")) {
      return stripped;
    }
    return token;
  });
}

/**
 * Normalize executable name:
 * - Strip common path prefixes (./node_modules/.bin/, npx run, etc.)
 * - Normalize path separators
 * - Lowercase on Windows-like patterns (.exe, .cmd, .bat)
 */
function normalizeExecutable(exe: string): string {
  let normalized = exe
    // Normalize path separators
    .replace(/\\/g, "/")
    // Strip node_modules/.bin/ prefix
    .replace(/^\.?\/?(node_modules\/\.bin\/)/, "")
    // Strip ./ prefix
    .replace(/^\.\//, "");

  // Strip Windows extensions for comparison
  normalized = normalized.replace(/\.(exe|cmd|bat|ps1)$/i, "");

  // Lowercase the executable (case-insensitive match)
  return normalized.toLowerCase();
}

/**
 * Normalize a single argument token:
 * - Normalize path separators
 * - Preserve case (arguments can be case-sensitive unlike executables)
 */
function normalizeArgument(arg: string): string {
  // Normalize Windows paths in arguments
  return arg.replace(/\\/g, "/");
}

/**
 * Compare two commands after canonicalization.
 * Returns true if they are structurally equivalent.
 */
export function commandsMatch(a: string, b: string): boolean {
  return canonicalizeCommand(a) === canonicalizeCommand(b);
}

/**
 * Extract the canonical executable + subcommand pair from a command.
 * Useful for generating approval patterns.
 * e.g., "NODE_ENV=test ./node_modules/.bin/jest --coverage" → ["jest"]
 *        "npm run build" → ["npm", "run"]
 *        "git commit -m 'fix'" → ["git", "commit"]
 */
export function extractCommandSignature(command: string): string[] {
  const canonical = canonicalizeCommand(command);
  if (!canonical) return [];

  // Remove env var prefix for signature
  const { rest } = splitEnvPrefix(canonical);
  const tokens = rest.split(" ").filter(Boolean);
  if (!tokens.length) return [];

  // Return executable + first non-flag argument (subcommand)
  const sig: string[] = [tokens[0]];
  for (let i = 1; i < tokens.length && sig.length < 2; i++) {
    // Skip flags (--, -x, --flag)
    if (!tokens[i].startsWith("-")) {
      sig.push(tokens[i]);
      break;
    }
  }
  return sig;
}

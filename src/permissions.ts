import type { PermissionMode, PermissionPolicy } from "./types";

export type CommandPolicyAction = "allow" | "prompt" | "deny";

export type CommandPolicyRule = {
  action: CommandPolicyAction;
  match: string[];
  notMatch?: string[];
  reason?: string;
};

export type CommandPolicyResult = {
  action: CommandPolicyAction;
  matched?: CommandPolicyRule;
  tokens: string[][];
};

export type PermissionDecision = "allow" | "confirm" | "deny";

/** Tokenize shell-like command segments without executing or expanding them. */
export function tokenizeShellCommand(command: string): string[][] {
  const segments: string[][] = [];
  let current: string[] = [];
  let token = "";
  let quote: "'" | '"' | undefined;
  const pushToken = () => {
    if (token) current.push(token);
    token = "";
  };
  const pushSegment = () => {
    pushToken();
    if (current.length) segments.push(current);
    current = [];
  };
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    if (quote) {
      if (char === quote) quote = undefined;
      else if (char === "`" && quote === '"' && index + 1 < command.length)
        token += command[++index];
      else token += char;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char === "`" && index + 1 < command.length) {
      token += command[++index];
      continue;
    }
    if (/\s/.test(char)) {
      pushToken();
      continue;
    }
    if (char === ";" || char === "\n" || char === "\r") {
      pushSegment();
      continue;
    }
    if (char === "&" || char === "|") {
      pushSegment();
      if (command[index + 1] === char) index += 1;
      continue;
    }
    token += char;
  }
  pushSegment();
  return segments;
}

const SHELL_WRAPPERS = new Set([
  "powershell",
  "pwsh",
  "cmd",
  "bash",
  "sh",
  "zsh",
]);

function nestedShellScript(tokens: string[]) {
  const executable = executableName(tokens[0] ?? "") ?? "";
  if (!SHELL_WRAPPERS.has(executable)) return "";
  const switches =
    executable === "cmd"
      ? new Set(["/c", "/k"])
      : executable === "powershell" || executable === "pwsh"
        ? new Set(["-command", "-c"])
        : new Set(["-c", "-lc"]);
  const index = tokens.findIndex((token) => switches.has(token.toLowerCase()));
  return index >= 0 ? tokens.slice(index + 1).join(" ").trim() : "";
}

function expandCommandSegment(tokens: string[], depth = 0): string[][] {
  if (depth >= 4) return [tokens];
  const nested = nestedShellScript(tokens);
  if (!nested) return [tokens];
  const segments = tokenizeShellCommand(nested);
  return segments.length
    ? segments.flatMap((segment) => expandCommandSegment(segment, depth + 1))
    : [tokens];
}

/** Parse executable command segments, including scripts passed to shell wrappers. */
export function commandSegmentsForPolicy(command: string) {
  return tokenizeShellCommand(command).flatMap((segment) =>
    expandCommandSegment(segment),
  );
}

function executableName(value: string) {
  return value
    .replace(/^['"]|['"]$/g, "")
    .replaceAll("\\", "/")
    .split("/")
    .at(-1)
    ?.replace(/\.(?:exe|cmd|bat|ps1)$/i, "")
    .toLowerCase();
}

function prefixMatches(tokens: string[], prefix: string[]) {
  return prefix.every(
    (value, index) => tokens[index]?.toLowerCase() === value.toLowerCase(),
  );
}

export function evaluateCommandPolicy(
  command: string,
  rules: readonly CommandPolicyRule[],
): CommandPolicyResult {
  const tokens = commandSegmentsForPolicy(command);
  for (const rule of rules) {
    const matched = tokens.some(
      (segment) =>
        prefixMatches(segment, rule.match) &&
        !(rule.notMatch ?? []).some((notMatch) =>
          prefixMatches(segment, notMatch.split(/\s+/).filter(Boolean)),
        ),
    );
    if (matched) return { action: rule.action, matched: rule, tokens };
  }
  return { action: "prompt", tokens };
}

export function resolvePermissionDecision(
  mode: PermissionMode,
  policy: PermissionPolicy | undefined,
  category: keyof PermissionPolicy | undefined,
) {
  if (!category) return "allow" as const;
  if (mode === "read-only") return "deny" as const;
  return policy?.[category] ?? (mode === "full-access" ? "allow" : "confirm");
}

const PERMISSION_CATEGORY_PRIORITY: (keyof PermissionPolicy)[] = [
  "gitPublish",
  "deletePaths",
  "network",
  "workspaceWrite",
  "longRunningProcesses",
  "runCommands",
];

export function resolvePermissionDecisionForCategories(
  mode: PermissionMode,
  policy: PermissionPolicy | undefined,
  categories: readonly (keyof PermissionPolicy)[],
): { decision: PermissionDecision; category?: keyof PermissionPolicy } {
  const ordered = PERMISSION_CATEGORY_PRIORITY.filter((category) =>
    categories.includes(category),
  );
  for (const decision of ["deny", "confirm"] as const) {
    const category = ordered.find(
      (candidate) =>
        resolvePermissionDecision(mode, policy, candidate) === decision,
    );
    if (category) return { decision, category };
  }
  return { decision: "allow", category: ordered[0] };
}

export function isPermissionPolicyCustomized(
  mode: PermissionMode,
  policy: PermissionPolicy,
) {
  if (mode === "read-only") return false;
  const defaultDecision = mode === "full-access" ? "allow" : "confirm";
  return Object.values(policy).some((value) => value !== defaultDecision);
}

function gitSubcommand(tokens: string[]) {
  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (
      token === "-C" ||
      token === "-c" ||
      token === "--git-dir" ||
      token === "--work-tree" ||
      token === "--namespace"
    ) {
      index += 1;
      continue;
    }
    if (token.startsWith("--git-dir=") || token.startsWith("--work-tree="))
      continue;
    if (token.startsWith("-")) continue;
    return token.toLowerCase();
  }
  return "";
}

export function permissionCategoriesForCommand(command: string) {
  const categories = new Set<keyof PermissionPolicy>(["runCommands"]);
  for (const segment of commandSegmentsForPolicy(command)) {
    const tokens = segment.filter((token) => token !== "&");
    const executable = executableName(tokens[0] ?? "") ?? "";
    if (executable === "git") {
      const subcommand = gitSubcommand(tokens);
      if (subcommand === "push" || subcommand === "commit")
        categories.add("gitPublish");
      if (["fetch", "pull", "clone", "submodule"].includes(subcommand))
        categories.add("network");
      if (
        [
          "add",
          "am",
          "apply",
          "checkout",
          "commit",
          "merge",
          "mv",
          "rebase",
          "reset",
          "restore",
          "revert",
          "rm",
          "stash",
          "switch",
          "tag",
        ].includes(subcommand)
      )
        categories.add("workspaceWrite");
      if (
        subcommand === "clean" ||
        (subcommand === "reset" &&
          tokens.some((token) => token.toLowerCase() === "--hard"))
      )
        categories.add("deletePaths");
    }
    if (executable === "gh") {
      const first = (tokens[1] ?? "").toLowerCase();
      const second = (tokens[2] ?? "").toLowerCase();
      if (
        (first === "workflow" && second === "run") ||
        (first === "run" && second === "rerun") ||
        (first === "release" &&
          ["create", "delete", "upload"].includes(second))
      )
        categories.add("gitPublish");
      categories.add("network");
    }
    if (
      [
        "curl",
        "wget",
        "invoke-webrequest",
        "iwr",
        "invoke-restmethod",
        "irm",
        "ssh",
        "scp",
        "sftp",
      ].includes(executable)
    )
      categories.add("network");
    if (
      (executable === "npm" || executable === "pnpm" || executable === "yarn") &&
      ["install", "add", "update", "upgrade", "view", "publish"].includes(
        (tokens[1] ?? "").toLowerCase(),
      )
    )
      categories.add("network");
    if (
      [
        "rm",
        "rmdir",
        "rd",
        "del",
        "erase",
        "unlink",
        "remove-item",
      ].includes(executable)
    )
      categories.add("deletePaths");
    if (
      [
        "cp",
        "mv",
        "mkdir",
        "touch",
        "copy",
        "move",
        "copy-item",
        "move-item",
        "new-item",
        "set-content",
        "add-content",
        "out-file",
      ].includes(executable) ||
      tokens.some((token) => token === ">" || token === ">>")
    )
      categories.add("workspaceWrite");
  }
  return PERMISSION_CATEGORY_PRIORITY.filter((category) =>
    categories.has(category),
  );
}

export function permissionCategoryForCommand(
  command: string,
): keyof PermissionPolicy {
  return permissionCategoriesForCommand(command)[0] ?? "runCommands";
}

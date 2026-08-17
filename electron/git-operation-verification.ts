import { parseCommandInvocations } from "./command-canonicalize";

export type GitOperation = "commit" | "push" | "release";

type VerificationHistoryItem =
  | { kind: "message"; role: "user" | "assistant"; content: string }
  | {
      kind: "calls";
      calls: {
        id: string;
        name: string;
        input: Record<string, unknown>;
      }[];
    }
  | { kind: "result"; callId: string; content: string };

const COMMAND_TOOLS = new Set(["run_command", "ssh_run"]);

type CommandSemantics = {
  git: boolean;
  commit: boolean;
  push: boolean;
  releaseTrigger: boolean;
  releaseVerification: boolean;
  repositoryList: boolean;
};

function gitSubcommand(args: string[]) {
  const optionsWithValue = new Set([
    "-c",
    "-C",
    "--git-dir",
    "--work-tree",
    "--namespace",
  ]);
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (optionsWithValue.has(token)) {
      index += 1;
      continue;
    }
    if (
      token.startsWith("--git-dir=") ||
      token.startsWith("--work-tree=") ||
      token.startsWith("--namespace=") ||
      token.startsWith("-")
    )
      continue;
    return token.toLowerCase();
  }
  return "";
}

function ghPositionals(args: string[]) {
  const optionsWithValue = new Set(["-R", "--repo", "--hostname"]);
  const values: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (optionsWithValue.has(token)) {
      index += 1;
      continue;
    }
    if (token.startsWith("--repo=") || token.startsWith("--hostname="))
      continue;
    if (!token.startsWith("-")) values.push(token.toLowerCase());
  }
  return values;
}

function commandSemantics(command: string): CommandSemantics {
  const semantics: CommandSemantics = {
    git: false,
    commit: false,
    push: false,
    releaseTrigger: false,
    releaseVerification: false,
    repositoryList: false,
  };
  for (const invocation of parseCommandInvocations(command)) {
    if (invocation.executable === "git") {
      semantics.git = true;
      const subcommand = gitSubcommand(invocation.args);
      if (subcommand === "commit") semantics.commit = true;
      if (subcommand === "push") semantics.push = true;
      continue;
    }
    if (invocation.executable !== "gh") continue;
    semantics.git = true;
    const [first = "", second = ""] = ghPositionals(invocation.args);
    if (
      (first === "workflow" && second === "run") ||
      (first === "run" && second === "rerun") ||
      (first === "release" && second === "create")
    )
      semantics.releaseTrigger = true;
    if (
      (first === "run" && ["view", "watch"].includes(second)) ||
      (first === "release" && second === "view")
    )
      semantics.releaseVerification = true;
    if (first === "repo" && second === "list") semantics.repositoryList = true;
  }
  return semantics;
}

/** Git requirements come from executable tool calls, never conversation text. */
export function gitOperationsRequiredByCalls(
  calls: ReadonlyArray<{ name: string; input: Record<string, unknown> }>,
) {
  const operations = new Set<GitOperation>();
  for (const call of calls) {
    if (!COMMAND_TOOLS.has(call.name)) continue;
    const command = String(call.input.command ?? "");
    const semantics = commandSemantics(command);
    if (semantics.commit) operations.add("commit");
    if (semantics.push) operations.add("push");
    if (semantics.releaseTrigger) operations.add("release");
  }
  return operations;
}

export function isNotGitRepositoryOutput(value: string) {
  return /not a git repository|outside (?:a )?git repository|不是\s*(?:一个\s*)?git\s*(?:仓库|存储库)|(?:当前|该|这个|工作区|目录).{0,20}(?:未初始化|没有).{0,8}git|no git repository/i.test(
    value,
  );
}

export function missingRequestedGitOperations(
  requested: ReadonlySet<GitOperation>,
  evidence: ReadonlySet<GitOperation>,
) {
  return [...requested].filter((operation) => !evidence.has(operation));
}

export function unavailableGitOperations(history: VerificationHistoryItem[]) {
  const calls = new Map<
    string,
    { id: string; name: string; input: Record<string, unknown> }
  >();
  for (const item of history)
    if (item.kind === "calls")
      for (const call of item.calls) calls.set(call.id, call);

  const operations = new Set<GitOperation>();
  for (const item of history) {
    if (item.kind !== "result") continue;
    const call = calls.get(item.callId);
    if (!call) continue;
    const command = COMMAND_TOOLS.has(call.name)
      ? String(call.input.command ?? "")
      : "";
    const semantics = commandSemantics(command);
    if (!call.name.startsWith("git_") && !semantics.git) continue;
    let output = "";
    try {
      const result = JSON.parse(item.content) as {
        data?: { output?: unknown };
      };
      output = String(result.data?.output ?? "");
    } catch {
      continue;
    }
    if (isNotGitRepositoryOutput(output)) {
      operations.add("commit");
      operations.add("push");
      operations.add("release");
      continue;
    }
    if (
      /no such remote|does not appear to be a git repository|(?:未配置|没有).{0,12}(?:远端|remote)/i.test(
        output,
      )
    ) {
      operations.add("push");
      operations.add("release");
    }
    if (
      /could not determine.{0,20}repository|no repositories found|未找到.{0,20}(?:github|仓库)|无法确定.{0,20}(?:仓库|发布目标)/i.test(
        output,
      ) ||
      (semantics.repositoryList && output.trim() === "[]")
    ) {
      operations.add("push");
      operations.add("release");
    }
    if (
      /workflow not found|no workflows found|未找到.{0,16}(?:工作流|workflow|actions)/i.test(
        output,
      )
    )
      operations.add("release");
  }
  return operations;
}

export function successfulGitEvidence(history: VerificationHistoryItem[]) {
  const successfulCallIds = new Set<string>();
  for (const item of history) {
    if (item.kind !== "result") continue;
    try {
      const result = JSON.parse(item.content) as { success?: boolean };
      if (result.success) successfulCallIds.add(item.callId);
    } catch {
      // Legacy results cannot prove that a mutating command succeeded.
    }
  }
  const operations = new Set<GitOperation>();
  const calls = new Map<
    string,
    { id: string; name: string; input: Record<string, unknown> }
  >();
  for (const item of history) {
    if (item.kind !== "calls") continue;
    for (const call of item.calls) calls.set(call.id, call);
  }
  let sequence = 0;
  let lastReleaseTrigger = -1;
  let lastReleaseVerification = -1;
  for (const item of history) {
    if (item.kind !== "result") continue;
    sequence += 1;
    if (!successfulCallIds.has(item.callId)) continue;
    const call = calls.get(item.callId);
    const command =
      call && COMMAND_TOOLS.has(call.name)
        ? String(call.input.command ?? "")
        : "";
    const semantics = commandSemantics(command);
    if (semantics.commit) operations.add("commit");
    if (semantics.push) {
      operations.add("push");
      lastReleaseTrigger = sequence;
    }
    if (semantics.releaseTrigger) lastReleaseTrigger = sequence;
    if (semantics.releaseVerification) lastReleaseVerification = sequence;
  }
  if (lastReleaseTrigger >= 0 && lastReleaseVerification > lastReleaseTrigger)
    operations.add("release");
  return operations;
}

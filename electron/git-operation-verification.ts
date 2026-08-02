import { relevantVerificationRequestContent } from "./coding-operation-verification";

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

export function isNotGitRepositoryOutput(value: string) {
  return /not a git repository|outside (?:a )?git repository|不是\s*(?:一个\s*)?git\s*(?:仓库|存储库)|(?:当前|该|这个|工作区|目录).{0,20}(?:未初始化|没有).{0,8}git|no git repository/i.test(
    value,
  );
}

export function requestedGitOperations(history: VerificationHistoryItem[]) {
  const content = relevantVerificationRequestContent(history);
  const operations = new Set<GitOperation>();
  const asksForStatus =
    /(?:是否|有没有|是不是|成功了吗|完成了吗|提交了吗|推送了吗|发布了吗|触发了吗|了没|了吗)[？?]?|\?$/i.test(
      content.trim(),
    );
  const explicitRequest =
    /(?:帮我|请(?!问)|麻烦|要你|开始|继续|把).{0,30}(?:提交|推送|发布|触发|commit|push|release)/i.test(
      content,
    );
  if (asksForStatus && !explicitRequest) return operations;
  if (/提交|\bcommit\b/i.test(content)) operations.add("commit");
  if (/提交.{0,6}(?:到|至)\s*(?:GitHub|远端)|推送|\bpush\b/i.test(content))
    operations.add("push");
  if (/打包|发布|触发.{0,8}(?:Actions|工作流)|\brelease\b/i.test(content))
    operations.add("release");
  return operations;
}

export function missingRequestedGitOperations(
  requested: ReadonlySet<GitOperation>,
  evidence: ReadonlySet<GitOperation>,
) {
  return [...requested].filter((operation) => !evidence.has(operation));
}

export function claimedGitOperations(text: string) {
  const operations = new Set<GitOperation>();
  if (
    /(?:已|成功).{0,12}(?:提交|commit)|提交\s*[:：]\s*`?[0-9a-f]{7,40}/i.test(
      text,
    )
  )
    operations.add("commit");
  if (/(?:已|成功).{0,12}(?:推送|push)|(?:分支|标签).{0,10}已推送/i.test(text))
    operations.add("push");
  if (
    /(?:已|成功).{0,12}(?:触发|启动).{0,12}(?:打包|发布|Actions|工作流)|(?:Release|Actions).{0,12}(?:运行中|已创建|已触发)/i.test(
      text,
    )
  )
    operations.add("release");
  return operations;
}

export function claimedUnavailableGitOperations(text: string) {
  const operations = new Set<GitOperation>();
  if (
    /not a git repository|(?:不是|并非).{0,12}git\s*(?:仓库|项目)|(?:没有|未初始化).{0,10}git\s*(?:仓库|项目)|(?:目录|工作区).{0,16}(?:不能|无法).{0,8}(?:提交|commit)/i.test(
      text,
    )
  ) {
    operations.add("commit");
    operations.add("push");
    operations.add("release");
  }
  if (
    /(?:未配置|没有|找不到|未找到|无法确定).{0,24}(?:github\s*仓库|远端仓库|remote|发布目标)|无法.{0,12}(?:推送|push)/i.test(
      text,
    )
  ) {
    operations.add("push");
    operations.add("release");
  }
  if (
    /(?:没有|未配置|找不到|未找到).{0,20}(?:actions|工作流|workflow)|无法.{0,12}(?:发布|触发|打包)/i.test(
      text,
    )
  )
    operations.add("release");
  return operations;
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
    if (!call.name.startsWith("git_") && !/\b(?:git|gh)\b/i.test(command))
      continue;
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
      (/\bgh\s+repo\s+list\b/i.test(command) && output.trim() === "[]")
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
    if (/\bgit\s+commit\b/i.test(command)) operations.add("commit");
    if (/\bgit\s+push\b/i.test(command)) {
      operations.add("push");
      lastReleaseTrigger = sequence;
    }
    if (
      /\bgh\s+(?:workflow\s+run|run\s+rerun|release\s+create)\b/i.test(command)
    )
      lastReleaseTrigger = sequence;
    if (/\bgh\s+(?:run\s+(?:view|watch)|release\s+view)\b/i.test(command))
      lastReleaseVerification = sequence;
  }
  if (lastReleaseTrigger >= 0 && lastReleaseVerification > lastReleaseTrigger)
    operations.add("release");
  return operations;
}

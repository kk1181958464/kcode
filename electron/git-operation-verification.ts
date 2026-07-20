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

type VerificationMessage = Extract<
  VerificationHistoryItem,
  { kind: "message" }
>;

export function requestedGitOperations(history: VerificationHistoryItem[]) {
  const latestUserMessage = [...history]
    .reverse()
    .find(
      (item): item is VerificationMessage =>
        item.kind === "message" && item.role === "user",
    );
  const content = latestUserMessage?.content ?? "";
  const operations = new Set<GitOperation>();
  if (/提交|\bcommit\b/i.test(content)) operations.add("commit");
  if (/提交.{0,6}(?:到|至)\s*(?:GitHub|远端)|推送|\bpush\b/i.test(content))
    operations.add("push");
  if (/打包|发布|触发.{0,8}(?:Actions|工作流)|\brelease\b/i.test(content))
    operations.add("release");
  return operations;
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
  for (const item of history) {
    if (item.kind !== "calls") continue;
    for (const call of item.calls) {
      if (!successfulCallIds.has(call.id)) continue;
      const command =
        call.name === "run_command" ? String(call.input.command ?? "") : "";
      if (/\bgit\s+commit\b/i.test(command)) operations.add("commit");
      if (/\bgit\s+push\b/i.test(command)) operations.add("push");
      if (
        /\bgh\s+(?:run\s+(?:list|view|watch)|release\s+(?:view|list))\b/i.test(
          command,
        )
      )
        operations.add("release");
    }
  }
  return operations;
}

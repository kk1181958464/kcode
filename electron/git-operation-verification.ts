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

const CONTINUATION_REQUEST =
  /^(?:好|好的|可以|行|继续|继续吧|开始|开始吧|执行吧|就这么做|按(?:你|上面|这个).{0,12}做|都弄|都改|全部(?:做|弄|改|修改))(?:了|吧|啊|呀)?[。！!，,\s]*$/i;

function relevantRequestContent(history: VerificationHistoryItem[]) {
  const messages = history.filter(
    (item): item is VerificationMessage => item.kind === "message",
  );
  let latestIndex = messages.length - 1;
  while (latestIndex >= 0 && messages[latestIndex].role !== "user")
    latestIndex -= 1;
  const latest = messages[latestIndex]?.content ?? "";
  if (!CONTINUATION_REQUEST.test(latest.trim())) return latest;
  const previous = messages
    .slice(Math.max(0, latestIndex - 2), latestIndex)
    .map((message) => message.content)
    .join("\n");
  return previous ? `${previous}\n${latest}` : latest;
}

export function requestedGitOperations(history: VerificationHistoryItem[]) {
  const content = relevantRequestContent(history);
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
      call?.name === "run_command" ? String(call.input.command ?? "") : "";
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

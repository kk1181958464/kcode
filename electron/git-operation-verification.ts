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
  const asksForInformation =
    /(?:为什么|为何|怎么会|怎么就|怎么回事|哪个|哪些|什么原因|是否|有没有|是不是|成功了吗|完成了吗|提交了吗|推送了吗|发布了吗|触发了吗|了没|了吗)[？?]?|\?$/i.test(
      content.trim(),
    );
  const explicitRequest =
    /(?:帮我|请(?!问)|麻烦|要你|开始|继续|把).{0,30}(?:提交|推送|发布|触发|commit|push|release)/i.test(
      content,
    );
  if (asksForInformation && !explicitRequest) return operations;

  const commitRequested =
    /\bgit\s+commit\b|\bcommit\b/i.test(content) ||
    /(?:提交|commit).{0,10}(?:(?:到|至)\s*)?(?:GitHub|GitLab|Gitee|远端(?:仓库)?|Git\s*仓库|代码仓库)/i.test(
      content,
    ) ||
    /(?:提交|commit)(?:一下|这些)?\s*(?:代码|改动|修改|变更|源码|项目)/i.test(
      content,
    ) ||
    /(?:代码|改动|修改|变更|源码|项目).{0,12}(?:提交|commit)/i.test(content);
  const pushRequested =
    /\bgit\s+push\b/i.test(content) ||
    /(?:提交|推送|push).{0,12}(?:(?:到|至)\s*)?(?:GitHub|GitLab|Gitee|远端(?:仓库)?|Git\s*仓库|代码仓库)/i.test(
      content,
    ) ||
    /(?:代码|改动|修改|变更|源码|项目|分支|标签).{0,12}(?:推送|push)/i.test(
      content,
    ) ||
    /(?:推送|push).{0,12}(?:代码|改动|修改|变更|源码|项目|分支|标签|origin|main|master)/i.test(
      content,
    ) ||
    /\bcommit\b.{0,16}\bpush\b/i.test(content);
  const releaseRequested =
    /(?:触发|启动|重跑|重新运行).{0,16}(?:(?:GitHub\s*)?(?:Actions|工作流)|(?:发布|打包)(?:流程|任务|工作流)?)/i.test(
      content,
    ) ||
    /(?:(?:GitHub\s*)?(?:Actions|工作流)).{0,16}(?:触发|启动|重跑|重新运行)/i.test(
      content,
    ) ||
    /(?:创建|发布).{0,10}(?:GitHub\s*)?(?:Release|版本)|(?:版本).{0,10}发布|\brelease\b/i.test(
      content,
    ) ||
    /\bgh\s+(?:workflow\s+run|run\s+rerun|release\s+create)\b/i.test(content);

  if (commitRequested) operations.add("commit");
  if (pushRequested) operations.add("push");
  if (releaseRequested) operations.add("release");
  return operations;
}

export function missingRequestedGitOperations(
  requested: ReadonlySet<GitOperation>,
  evidence: ReadonlySet<GitOperation>,
) {
  return [...requested].filter((operation) => !evidence.has(operation));
}

export function claimedGitOperations(text: string) {
  const proseText = text
    .replace(/```[\s\S]*?```/g, "")
    .replace(
      /(?:如果|若|假如|一旦|\bif\b|\bwhen\b)[^。！？!?\n]{0,160}[。！？!?]?/gi,
      "",
    );
  const assertedText = proseText.replace(
    /(?:未|没有|尚未|无法|不能|并未).{0,10}(?:提交|推送|发布|触发|启动|commit|push|release)|\b(?:not|never|did not|could not|unable to)\b[^.!?\n]{0,40}\b(?:commit|push|release|trigger)\b/gi,
    "",
  );
  const operations = new Set<GitOperation>();
  if (
    /(?:已|成功).{0,12}(?:提交|commit)|(?:我|我们)(?:已经|已)?(?:提交|commit)(?:了|完成)|提交\s*[:：]\s*`?[0-9a-f]{7,40}/i.test(
      assertedText,
    )
  )
    operations.add("commit");
  if (
    /(?:已|成功).{0,12}(?:推送|push)|(?:我|我们|并|随后|然后|同时)(?:已经|已)?(?:推送|push)(?:了|完成)|(?:推送|push)(?:了|完成)|(?:分支|标签).{0,10}已推送/i.test(
      assertedText,
    )
  )
    operations.add("push");
  if (
    /(?:已|成功).{0,12}(?:触发|启动).{0,12}(?:打包|发布|Actions|工作流)|(?:我|我们|并|随后|然后|同时)(?:已经|已)?(?:触发|启动)(?:了)?.{0,12}(?:打包|发布|Actions|工作流)|(?:Release|Actions).{0,12}(?:运行中|已创建|已触发)/i.test(
      assertedText,
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

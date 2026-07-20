import type { AgentActivity, ChatMessage, ContextLedger } from "./types";
export type { ContextLedger } from "./types";

export type CompactableContext = {
  messages: ChatMessage[];
  activities: AgentActivity[];
  contextSummary?: string;
  compactedMessageCount?: number;
  contextLedger?: ContextLedger;
  imageSemantics?: Record<string, string>;
};

export const AGENT_STATIC_TOKENS = 5_000;
export const emptyLedger = (): ContextLedger => ({
  goals: [],
  decisions: [],
  changedFiles: [],
  validations: [],
  failures: [],
  pending: [],
  connections: [],
});
const uniqueRecent = (items: string[], limit = 32) =>
  [...new Set(items.filter(Boolean))].slice(-limit);

export const estimateMessageTokens = (items: ChatMessage[]) =>
  Math.ceil(
    items.reduce(
      (total, item) =>
        total +
        item.content.length +
        (item.images?.reduce(
          (size, image) => size + Math.min(image.size, 750_000),
          0,
        ) ?? 0) /
          750,
      0,
    ) / 3,
  );

export function compactConversation(
  task: CompactableContext,
  contextWindow: number,
  force = false,
) {
  const alreadyCompacted = task.compactedMessageCount ?? 0;
  const recentBudget = Math.max(4_000, Math.floor(contextWindow * 0.3));
  let recentTokens = 0;
  let compactUntil = task.messages.length;
  for (
    let index = task.messages.length - 1;
    index >= alreadyCompacted;
    index--
  ) {
    const messageTokens = estimateMessageTokens([task.messages[index]]);
    if (recentTokens > 0 && recentTokens + messageTokens > recentBudget) break;
    recentTokens += messageTokens;
    compactUntil = index;
  }
  compactUntil = Math.min(
    compactUntil,
    Math.max(alreadyCompacted, task.messages.length - 2),
  );
  if (
    force &&
    compactUntil <= alreadyCompacted &&
    task.messages.length - alreadyCompacted > 2
  )
    compactUntil = task.messages.length - 2;
  if (compactUntil <= alreadyCompacted) return undefined;

  const older = task.messages.slice(alreadyCompacted, compactUntil);
  const previous = task.contextSummary ? `${task.contextSummary}\n\n` : "";
  const goals: string[] = [],
    decisions: string[] = [],
    results: string[] = [],
    errors: string[] = [],
    pending: string[] = [];
  for (const message of older) {
    const role =
      message.role === "user"
        ? "用户"
        : `模型${message.model ? `(${message.model})` : ""}`;
    const text = message.content.replace(/\s+/g, " ").trim();
    const semantics = message.images
      ?.map((image) => task.imageSemantics?.[image.id])
      .filter(Boolean)
      .join("；");
    const imageNote = message.images?.length
      ? ` [图片语义：${semantics || `${message.images.length} 张图片，尚无描述`}]`
      : "";
    const line = `- ${role}: ${text.slice(0, 700)}${text.length > 700 ? "…" : ""}${imageNote}`;
    if (/失败|错误|报错|异常|error|failed/i.test(text)) errors.push(line);
    else if (/完成|通过|已修改|已添加|已修复|构建|测试/i.test(text))
      results.push(line);
    else if (message.role === "user") goals.push(line);
    else if (/建议|决定|采用|应该|需要|方案/i.test(text)) decisions.push(line);
    else pending.push(line);
  }
  const latestActivities = new Map<string, AgentActivity>();
  for (const activity of task.activities.filter((item) => item.completedAt))
    latestActivities.set(
      `${activity.tool}:${activity.path ?? activity.command ?? activity.title}`,
      activity,
    );
  const dedupedActivities = [...latestActivities.values()].slice(-24);
  const activityLines = dedupedActivities.map(
    (activity) =>
      `- ${activity.title}${activity.path ? ` ${activity.path}` : ""}: ${activity.status}${activity.errorSummary ? `，${activity.errorSummary}` : ""}`,
  );
  const ledger = task.contextLedger ?? emptyLedger();
  const changedFiles = dedupedActivities
    .filter(
      (activity) =>
        activity.status === "success" &&
        activity.path &&
        ["apply_patch", "write_file", "move_path", "delete_path"].includes(
          activity.tool,
        ),
    )
    .map((activity) => activity.path!);
  const validations = dedupedActivities
    .filter(
      (activity) =>
        activity.tool === "diagnostics" ||
        /测试|构建|检查/.test(activity.title),
    )
    .map((activity) => `${activity.title}: ${activity.status}`);
  // Connections are durable facts: a session opened earlier stays usable across
  // rounds, so their coordinates must survive compaction verbatim (never lumped
  // into the truncated summary text). Activity inputs are already redacted, so
  // host/port/username are safe to keep while passwords never appear here.
  const connections = task.activities
    .filter(
      (activity) =>
        activity.status === "success" &&
        [
          "ssh_connect",
          "mysql_connect",
          "mysql_connect_via_ssh",
          "sqlserver_connect",
          "sqlserver_connect_via_ssh",
          "mongodb_connect",
          "mongodb_connect_via_ssh",
        ].includes(activity.tool),
    )
    .map((activity) => {
      const input = (activity.input ?? {}) as Record<string, unknown>;
      return `${activity.tool} ${JSON.stringify(input)}`;
    });
  const nextLedger: ContextLedger = {
    goals: uniqueRecent([...ledger.goals, ...goals]),
    decisions: uniqueRecent([...ledger.decisions, ...decisions]),
    changedFiles: uniqueRecent([...ledger.changedFiles, ...changedFiles], 64),
    validations: uniqueRecent([...ledger.validations, ...validations]),
    failures: uniqueRecent([...ledger.failures, ...errors]),
    pending: uniqueRecent([...ledger.pending, ...pending]),
    connections: uniqueRecent(
      [...(ledger.connections ?? []), ...connections],
      16,
    ),
  };
  const sections = [
    nextLedger.connections.length
      ? `## 已建立的连接（会话仍可用，无需重新询问凭据）\n${nextLedger.connections.map((item) => `- ${item}`).join("\n")}`
      : "",
    goals.length ? `## 目标与需求\n${goals.join("\n")}` : "",
    decisions.length ? `## 关键决定\n${decisions.join("\n")}` : "",
    [...results, ...activityLines].length
      ? `## 文件、工具与验证\n${[...results, ...activityLines].join("\n")}`
      : "",
    errors.length ? `## 错误与限制\n${errors.join("\n")}` : "",
    pending.length ? `## 其他上下文与待办\n${pending.join("\n")}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
  const contextSummary = `${previous}${sections}`.slice(-40_000);
  if (
    !contextSummary.trim() ||
    (!nextLedger.goals.length &&
      !nextLedger.changedFiles.length &&
      !nextLedger.pending.length &&
      !nextLedger.connections.length)
  )
    return undefined;
  return {
    contextSummary,
    compactedMessageCount: compactUntil,
    contextLedger: nextLedger,
  };
}

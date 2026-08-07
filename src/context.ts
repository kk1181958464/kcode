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
export const CONTEXT_COMPACT_WARNING_RATIO = 0.85;
export const CONTEXT_AUTO_COMPACT_RATIO = 0.92;
export const CONTEXT_FORCE_COMPACT_RATIO = 0.99;
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
const summaryTokenLimit = (contextWindow: number) =>
  Math.max(3_000, Math.min(16_000, Math.floor(contextWindow * 0.1)));
const trimSummary = (text: string, contextWindow: number) => {
  const limit = summaryTokenLimit(contextWindow) * 3;
  if (text.length <= limit) return text;
  return boundedContextSource(text, limit);
};

// Single source of truth for the "chars ≈ tokens" heuristic (chars / 3),
// reused instead of scattering the `/ 3` literal across call sites.
export const estimateTextTokens = (text: string) =>
  Math.ceil((text?.length ?? 0) / 3);

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

const sensitiveConnectionKey =
  /password|passphrase|secret|token|api.?key|private.?key|credential|cookie|authorization/i;

export function redactSensitiveText(text: string) {
  return text
    .replace(
      /-----BEGIN [^-\r\n]*PRIVATE KEY-----[\s\S]*?-----END [^-\r\n]*PRIVATE KEY-----/gi,
      "[私钥已隐藏]",
    )
    .replace(
      /((?:password|passphrase|secret|token|api.?key|private.?key|credential|cookie|authorization)["']?\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;}\]]+)/gi,
      (_match, prefix: string, value: string) => {
        const quote = value.startsWith('"')
          ? '"'
          : value.startsWith("'")
            ? "'"
            : "";
        return `${prefix}${quote}[已隐藏]${quote}`;
      },
    )
    .replace(/([a-z][a-z\d+.-]*:\/\/[^:\s/@]+):[^@\s/]+@/gi, "$1:[已隐藏]@");
}

function redactConnectionValue(value: unknown, key = ""): unknown {
  if (sensitiveConnectionKey.test(key)) return "[已隐藏]";
  if (Array.isArray(value))
    return value.map((item) => redactConnectionValue(item));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(
        ([childKey, item]) => [childKey, redactConnectionValue(item, childKey)],
      ),
    );
  return value;
}

export function boundedContextSource(source: string, maxChars = 120_000) {
  if (source.length <= maxChars) return source;
  const marker = "\n\n[中间较早内容因长度限制已省略]\n\n";
  const available = Math.max(0, maxChars - marker.length);
  const headLength = Math.floor(available * 0.4);
  return `${source.slice(0, headLength)}${marker}${source.slice(-(available - headLength))}`;
}

export function contextSummarySource(
  task: CompactableContext,
  compactUntil: number,
  contextWindow: number,
) {
  const alreadyCompacted = task.compactedMessageCount ?? 0;
  const transcript = task.messages
    .slice(alreadyCompacted, compactUntil)
    .map((message) => {
      const role = message.role === "user" ? "用户" : "模型";
      const imageNotes = message.images
        ?.map((image) => task.imageSemantics?.[image.id] || image.name)
        .filter(Boolean)
        .join("；");
      return [
        `### ${role}${message.model ? ` (${message.model})` : ""}`,
        message.content.trim() || "[无文字内容]",
        imageNotes ? `图片：${imageNotes}` : "",
      ]
        .filter(Boolean)
        .join("\n");
    })
    .join("\n\n");
  const source = [
    task.contextSummary?.trim()
      ? `## 既有压缩摘要\n${redactSensitiveText(task.contextSummary.trim())}`
      : "",
    transcript ? `## 本次待压缩原始对话\n${transcript}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
  const sourceLimit = Math.min(
    120_000,
    Math.max(24_000, summaryTokenLimit(contextWindow) * 12),
  );
  return boundedContextSource(redactSensitiveText(source), sourceLimit);
}

function repeatedLineRatio(text: string) {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length >= 8);
  if (lines.length < 6) return 0;
  return 1 - new Set(lines).size / lines.length;
}

export function acceptModelContextSummary<
  T extends { summary: string; ledger: ContextLedger },
>(
  local: {
    contextSummary: string;
    contextLedger: ContextLedger;
    compactedMessageCount: number;
  },
  model: T,
  contextWindow: number,
) {
  const summary = redactSensitiveText(model.summary.trim());
  const hardLimit = summaryTokenLimit(contextWindow) * 3;
  const growthLimit = Math.max(12_000, local.contextSummary.length * 2.5);
  if (
    !summary ||
    summary.length > hardLimit ||
    summary.length > growthLimit ||
    repeatedLineRatio(summary) > 0.3
  )
    return undefined;
  const ledger = Object.fromEntries(
    (Object.keys(emptyLedger()) as (keyof ContextLedger)[]).map((key) => [
      key,
      uniqueRecent(
        [...(local.contextLedger[key] ?? []), ...(model.ledger[key] ?? [])],
        key === "changedFiles" ? 64 : key === "connections" ? 16 : 32,
      ),
    ]),
  ) as ContextLedger;
  return { ...model, summary, ledger };
}

export function compactConversation(
  task: CompactableContext,
  contextWindow: number,
  force = false,
) {
  const alreadyCompacted = task.compactedMessageCount ?? 0;
  const recentBudget = Math.max(
    6_000,
    Math.min(48_000, Math.floor(contextWindow * 0.22)),
  );
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
  const previous = task.contextSummary?.trim()
    ? `## 既有压缩摘要\n${trimSummary(task.contextSummary.trim(), contextWindow)}`
    : "";
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
    const text = redactSensitiveText(
      message.content.replace(/\s+/g, " ").trim(),
    );
    const semantics = message.images
      ?.map((image) => task.imageSemantics?.[image.id])
      .filter(Boolean)
      .join("；");
    const imageNote = message.images?.length
      ? ` [图片语义：${semantics || `${message.images.length} 张图片，尚无描述`}]`
      : "";
    const line = `- ${role}: ${text.slice(0, 520)}${text.length > 520 ? "…" : ""}${imageNote}`;
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
  // Connection coordinates are durable, but activity inputs can originate from
  // old data created before runtime redaction. Sanitize again at the persistence
  // boundary so summaries never become a credential store.
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
      return `${activity.tool} ${JSON.stringify(redactConnectionValue(input))}`;
    });
  const nextLedger: ContextLedger = {
    goals: uniqueRecent([...ledger.goals, ...goals]),
    decisions: uniqueRecent([...ledger.decisions, ...decisions]),
    changedFiles: uniqueRecent([...ledger.changedFiles, ...changedFiles], 64),
    validations: uniqueRecent([...ledger.validations, ...validations]),
    failures: uniqueRecent([...ledger.failures, ...errors]),
    pending: uniqueRecent([...ledger.pending, ...pending]),
    connections: uniqueRecent(
      [...(ledger.connections ?? []), ...connections].map(redactSensitiveText),
      16,
    ),
  };
  const sectionGoals = uniqueRecent(goals, 24);
  const sectionDecisions = uniqueRecent(decisions, 20);
  const sectionResults = uniqueRecent([...results, ...activityLines], 36);
  const sectionErrors = uniqueRecent(errors, 20);
  const sectionPending = uniqueRecent(pending, 18);
  const sections = [
    previous,
    nextLedger.connections.length
      ? `## 已建立的连接（会话仍可用，无需重新询问凭据）\n${nextLedger.connections.map((item) => `- ${item}`).join("\n")}`
      : "",
    sectionGoals.length ? `## 目标与需求\n${sectionGoals.join("\n")}` : "",
    sectionDecisions.length
      ? `## 关键决定\n${sectionDecisions.join("\n")}`
      : "",
    sectionResults.length
      ? `## 文件、工具与验证\n${sectionResults.join("\n")}`
      : "",
    sectionErrors.length ? `## 错误与限制\n${sectionErrors.join("\n")}` : "",
    sectionPending.length
      ? `## 其他上下文与待办\n${sectionPending.join("\n")}`
      : "",
  ]
    .filter(Boolean)
    .join("\n\n");
  const contextSummary = trimSummary(
    redactSensitiveText(sections),
    contextWindow,
  );
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

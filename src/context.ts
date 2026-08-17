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

// Codex keeps a bounded set of real user messages next to the handoff summary.
// KCode additionally reserves part of that budget for connection details because
// an SSH/database session may need to be recreated in a later request.
export const COMPACTION_RETAINED_USER_MAX_TOKENS = 20_000;
const COMPACTION_RETAINED_USER_MIN_TOKENS = 2_000;
const COMPACTION_CONNECTION_MAX_TOKENS = 8_000;

const concreteCredentialAssignment =
  /(?:用户名|账号|密码|口令|密钥|私钥|访问令牌|令牌|username|password|passphrase|private[ _-]?key|api[ _-]?key|access[ _-]?token|token)\s*(?:[:：=]|是|为)\s*(?:"[^"\r\n]+"|'[^'\r\n]+'|`[^`\r\n]+`|[^\s,，;；]+)/i;
const concreteConnectionAssignment =
  /(?:ssh|sftp|服务器(?:地址)?|主机(?:地址)?|IP\s*地址|端口|host(?:name)?|ip(?:\s*address)?|port)\s*(?:[:：=]|是|为)\s*(?:"[^"\r\n]+"|'[^'\r\n]+'|`[^`\r\n]+`|[^\s,，;；]+)/i;
const connectionUri =
  /\b(?:ssh|sftp|mysql|mongodb(?:\+srv)?|postgres(?:ql)?|redis):\/\/[^\s]+/i;
const sshTarget =
  /\b(?:ssh|sftp)\b[^\r\n]{0,120}(?:[\w.-]+@)?(?:\d{1,3}\.){3}\d{1,3}/i;
const privateKeyBlock =
  /-----BEGIN [^-\r\n]*PRIVATE KEY-----[\s\S]*?-----END [^-\r\n]*PRIVATE KEY-----/i;

export function containsDurableConnectionDetails(text: string) {
  return (
    concreteCredentialAssignment.test(text) ||
    concreteConnectionAssignment.test(text) ||
    connectionUri.test(text) ||
    sshTarget.test(text) ||
    privateKeyBlock.test(text)
  );
}

function retainedUserTokenBudget(contextWindow?: number) {
  if (!contextWindow) return COMPACTION_RETAINED_USER_MAX_TOKENS;
  return Math.max(
    COMPACTION_RETAINED_USER_MIN_TOKENS,
    Math.min(
      COMPACTION_RETAINED_USER_MAX_TOKENS,
      Math.floor(contextWindow * 0.08),
    ),
  );
}

function truncateRetainedMessage(message: ChatMessage, maxTokens: number) {
  return {
    ...message,
    content: boundedContextSource(message.content, Math.max(1, maxTokens) * 3),
    images: undefined,
    contextAttachments: undefined,
  };
}

/**
 * Select real user messages from the already compacted prefix. Newest messages
 * fill the general budget, while concrete connection/credential messages get a
 * reserved budget so an old SSH target is not displaced by later conversation.
 */
export function retainedCompactedUserMessages(
  messages: ChatMessage[],
  compactUntil: number,
  contextWindow?: number,
) {
  if (compactUntil <= 0) return [];
  const candidates = messages
    .slice(0, Math.min(compactUntil, messages.length))
    .map((message, index) => ({ message, index }))
    .filter(
      (item) =>
        item.message.role === "user" && Boolean(item.message.content.trim()),
    );
  if (!candidates.length) return [];

  const totalBudget = retainedUserTokenBudget(contextWindow);
  const connectionBudget = Math.min(
    COMPACTION_CONNECTION_MAX_TOKENS,
    Math.max(1_000, Math.floor(totalBudget * 0.4)),
  );
  const selected = new Map<
    string,
    { message: ChatMessage; index: number; tokens: number }
  >();
  let connectionRemaining = connectionBudget;

  for (const item of [...candidates].reverse()) {
    if (!containsDurableConnectionDetails(item.message.content)) continue;
    const tokens = estimateMessageTokens([item.message]);
    if (tokens <= connectionRemaining) {
      selected.set(item.message.id, { ...item, tokens });
      connectionRemaining -= tokens;
      continue;
    }
    if (connectionRemaining > 0) {
      const message = truncateRetainedMessage(
        item.message,
        connectionRemaining,
      );
      selected.set(item.message.id, {
        message,
        index: item.index,
        tokens: estimateMessageTokens([message]),
      });
      connectionRemaining = 0;
    }
    break;
  }

  let remaining = Math.max(
    0,
    totalBudget -
      [...selected.values()].reduce((total, item) => total + item.tokens, 0),
  );
  for (const item of [...candidates].reverse()) {
    if (selected.has(item.message.id) || remaining <= 0) continue;
    const tokens = estimateMessageTokens([item.message]);
    if (tokens <= remaining) {
      selected.set(item.message.id, { ...item, tokens });
      remaining -= tokens;
      continue;
    }
    const message = truncateRetainedMessage(item.message, remaining);
    selected.set(item.message.id, {
      message,
      index: item.index,
      tokens: estimateMessageTokens([message]),
    });
    remaining = 0;
  }

  return [...selected.values()]
    .sort((left, right) => left.index - right.index)
    .map(({ message }) => ({
      ...message,
      images: undefined,
      contextAttachments: undefined,
    }));
}

/**
 * This block is assembled only for the outgoing model request. It is never
 * stored in the redacted summary or fact ledger; the source messages already
 * exist in the task history. Packing the retained messages into the first
 * request item also lets the runtime compactor preserve the whole checkpoint.
 */
export function retainedCompactionContext(
  messages: ChatMessage[],
  compactUntil: number,
  contextWindow?: number,
) {
  const retained = retainedCompactedUserMessages(
    messages,
    compactUntil,
    contextWindow,
  );
  if (!retained.length) return "";
  const payload = JSON.stringify(
    retained.map((message) => ({
      sourceMessageId: message.id,
      createdAt: message.createdAt,
      content: message.content,
    })),
  ).replace(/<\/retained_user_messages>/gi, "<\\/retained_user_messages>");
  return `<retained_user_messages>\n这些是压缩检查点保留的真实用户消息，仅用于延续当前任务。后出现的值覆盖先前值；连接参数可直接复用，不要向用户重复索取，也不要在回复中复述密码、令牌或私钥。\n${payload}\n</retained_user_messages>`;
}

const sensitiveConnectionKey =
  /password|passphrase|secret|token|api.?key|private.?key|credential|cookie|authorization/i;

export function redactSensitiveText(text: string) {
  return text
    .replace(
      /-----BEGIN [^-\r\n]*PRIVATE KEY-----[\s\S]*?-----END [^-\r\n]*PRIVATE KEY-----/gi,
      "[私钥已隐藏]",
    )
    .replace(
      /((?:密码|口令|密钥|私钥|访问令牌|令牌|password|passphrase|secret|token|api.?key|private.?key|credential|cookie|authorization)["']?\s*(?:[:：=]|是|为)\s*)("[^"]*"|'[^']*'|`[^`]*`|[^\s,，;；}\]]+)/gi,
      (_match, prefix: string, value: string) => {
        const quote = value.startsWith('"')
          ? '"'
          : value.startsWith("'")
            ? "'"
            : value.startsWith("`")
              ? "`"
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
  const semanticKeys = new Set<keyof ContextLedger>([
    "goals",
    "decisions",
    "pending",
  ]);
  const ledger = Object.fromEntries(
    (Object.keys(emptyLedger()) as (keyof ContextLedger)[]).map((key) => [
      key,
      uniqueRecent(
        semanticKeys.has(key)
          ? [...(local.contextLedger[key] ?? []), ...(model.ledger[key] ?? [])]
          : [...(local.contextLedger[key] ?? [])],
        key === "changedFiles" ? 64 : key === "connections" ? 16 : 32,
      ),
    ]),
  ) as ContextLedger;
  const authoritativeSummary = [
    ledger.goals.length
      ? `## 当前目标\n${ledger.goals.map((item) => `- ${item}`).join("\n")}`
      : "",
    ledger.decisions.length
      ? `## 关键决定\n${ledger.decisions.map((item) => `- ${item}`).join("\n")}`
      : "",
    ledger.changedFiles.length
      ? `## 已验证文件改动\n${ledger.changedFiles.map((item) => `- ${item}`).join("\n")}`
      : "",
    ledger.validations.length
      ? `## 已执行验证\n${ledger.validations.map((item) => `- ${item}`).join("\n")}`
      : "",
    ledger.failures.length
      ? `## 已记录失败\n${ledger.failures.map((item) => `- ${item}`).join("\n")}`
      : "",
    ledger.connections.length
      ? `## 已建立连接\n${ledger.connections.map((item) => `- ${item}`).join("\n")}`
      : "",
    ledger.pending.length
      ? `## 待办与未验证上下文\n${ledger.pending.map((item) => `- ${item}`).join("\n")}`
      : "",
  ]
    .filter(Boolean)
    .join("\n\n");
  return {
    ...model,
    summary: trimSummary(authoritativeSummary || local.contextSummary, contextWindow),
    ledger,
  };
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
    conversationNotes: string[] = [];
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
    if (message.role === "user") goals.push(line);
    else conversationNotes.push(line);
  }
  const latestActivities = new Map<string, AgentActivity>();
  for (const activity of task.activities.filter((item) => item.completedAt))
    latestActivities.set(
      `${activity.tool}:${activity.path ?? activity.command ?? activity.title}`,
      activity,
    );
  const dedupedActivities = [...latestActivities.values()].slice(-24);
  const activityLine = (activity: AgentActivity) =>
    `- ${activity.title}${activity.path ? ` ${activity.path}` : ""}: ${activity.status}${activity.errorSummary ? `，${activity.errorSummary}` : ""}`;
  const successfulActivityLines = dedupedActivities
    .filter(
      (activity) =>
        activity.status === "success" || activity.status === "completed",
    )
    .map(activityLine);
  const failedActivityLines = dedupedActivities
    .filter(
      (activity) =>
        activity.status === "failed" || activity.status === "denied",
    )
    .map(
      (activity) =>
        `- ${activity.title}${activity.path ? ` ${activity.path}` : ""}: ${activity.errorSummary || activity.status}`,
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
        activity.status === "success" &&
        (activity.tool === "diagnostics" ||
          activity.operationEvidence?.includes("validate")),
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
    decisions: uniqueRecent([...ledger.decisions]),
    changedFiles: uniqueRecent([...ledger.changedFiles, ...changedFiles], 64),
    validations: uniqueRecent([...ledger.validations, ...validations]),
    failures: uniqueRecent([...ledger.failures, ...failedActivityLines]),
    pending: uniqueRecent([...ledger.pending, ...conversationNotes]),
    connections: uniqueRecent(
      [...(ledger.connections ?? []), ...connections].map(redactSensitiveText),
      16,
    ),
  };
  const sectionGoals = uniqueRecent(goals, 24);
  const sectionDecisions = uniqueRecent(nextLedger.decisions, 20);
  const sectionResults = uniqueRecent(successfulActivityLines, 36);
  const sectionErrors = uniqueRecent(failedActivityLines, 20);
  const sectionPending = uniqueRecent(conversationNotes, 18);
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
      ? `## 未验证对话记录与待办\n${sectionPending.join("\n")}`
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

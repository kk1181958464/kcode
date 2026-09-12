import type { AgentToolName, ContextLedger, ContextSummaryResult, ImageAttachment, ModelRequest } from "../src/types";
import { effectiveOpenAiProtocol } from "./protocol-fallback";
import { boundedContextSource, containsDurableProtocolDetails, redactSensitiveText } from "../src/context";
import { pendingOperationLabel } from "./agent-completion";
import { structuredToolEvidenceSummary } from "./coding-operation-verification";
import { summarizeContextWithProvider, summaryModelForProvider, type ProviderWithKey } from "./gateway";
import { resolveModelContextWindow } from "../src/types";
import { effectiveRuntimePromptTokens } from "./runtime-context-budget";

import type { ToolCall, StructuredToolResult, HistoryItem } from "./agent-types";
export type { HistoryItem } from "./agent-types";
function redactedToolInput(call: ToolCall) { return { ...call.input }; }

export function hasImageAttachments(history: HistoryItem[]) {
  return history.some(
    (item) => item.kind === "message" && Boolean(item.images?.length),
  );
}

export function historyWithoutImages(history: HistoryItem[]): HistoryItem[] {
  return history.map((item) =>
    item.kind === "message" && item.images?.length
      ? { ...item, images: undefined }
      : item,
  );
}

const MAX_RETAINED_RUNTIME_IMAGE_BYTES = 1_000_000;
const RUNTIME_IMAGE_REMOVED_MARKER = "<runtime_image_context_removed>";
const MAX_RETAINED_RUNTIME_PROTOCOL_CHARS = 96_000;
const MAX_RETAINED_RUNTIME_PROTOCOL_MESSAGES = 8;
const RUNTIME_RETAINED_PROTOCOL_CONTEXT_MARKER =
  "<runtime_retained_protocol_context>";
const RUNTIME_RETAINED_PROTOCOL_CONTEXT_END =
  "</runtime_retained_protocol_context>";

/**
 * A protocol document is evidence, not ordinary progress narration. Runtime
 * compaction must keep it intact because endpoints, payload fields and status
 * paths are often located well after the first few hundred characters.
 */
export const isRuntimeProtocolMessage = containsDurableProtocolDetails;

function boundedRuntimeProtocolText(source: string, maxChars: number) {
  if (maxChars <= 0) return "";
  if (source.length <= maxChars) return source;
  const marker =
    "\n\n[协议正文中间部分因运行时预算限制省略，首尾字段仍保留]\n\n";
  if (maxChars <= marker.length) return source.slice(0, maxChars);
  const available = Math.max(0, maxChars - marker.length);
  const headLength = Math.floor(available * 0.45);
  return `${source.slice(0, headLength)}${marker}${source.slice(-(
    available - headLength
  ))}`;
}

function runtimeProtocolBody(content: string) {
  const start = content.indexOf(RUNTIME_RETAINED_PROTOCOL_CONTEXT_MARKER);
  if (start < 0) return content;
  const bodyStart =
    start + RUNTIME_RETAINED_PROTOCOL_CONTEXT_MARKER.length;
  const end = content.lastIndexOf(RUNTIME_RETAINED_PROTOCOL_CONTEXT_END);
  if (end <= bodyStart) return content;
  return content.slice(bodyStart, end).trim();
}

function runtimeProtocolKey(content: string) {
  return runtimeProtocolBody(content).replace(/\s+/g, " ").trim();
}

function isRetainedRuntimeProtocolBlock(content: string) {
  return (
    content.includes(RUNTIME_RETAINED_PROTOCOL_CONTEXT_MARKER) &&
    content.includes(RUNTIME_RETAINED_PROTOCOL_CONTEXT_END)
  );
}

function retainedRuntimeProtocolMessages(
  older: HistoryItem[],
  firstMessage?: Extract<HistoryItem, { kind: "message" }>,
) {
  const candidates: {
    item: Extract<HistoryItem, { kind: "message" }>;
    index: number;
  }[] = older.flatMap((item, index) =>
    item.kind === "message" &&
    item !== firstMessage &&
    item.role === "user" &&
    isRuntimeProtocolMessage(item.content)
      ? [{ item, index }]
      : [],
  );
  if (!candidates.length) return [];

  const selected: {
    item: Extract<HistoryItem, { kind: "message" }>;
    index: number;
  }[] = [];
  const selectedProtocolKeys = new Set<string>();
  let remaining = MAX_RETAINED_RUNTIME_PROTOCOL_CHARS;
  for (const candidate of [...candidates].reverse()) {
    if (
      selected.length >= MAX_RETAINED_RUNTIME_PROTOCOL_MESSAGES ||
      remaining <= 0
    )
      break;
    const source = candidate.item.content;
    const key = runtimeProtocolKey(source);
    if (!key || selectedProtocolKeys.has(key)) continue;
    selectedProtocolKeys.add(key);
    const sourceBody = runtimeProtocolBody(source);
    const maxBodyChars = Math.min(32_000, remaining);
    const body = boundedRuntimeProtocolText(sourceBody, maxBodyChars);
    if (!body.trim()) continue;
    const content =
      isRetainedRuntimeProtocolBlock(source) &&
      sourceBody.length <= maxBodyChars
        ? source
        : `${RUNTIME_RETAINED_PROTOCOL_CONTEXT_MARKER}\n${body.replace(
            new RegExp(RUNTIME_RETAINED_PROTOCOL_CONTEXT_END, "gi"),
            "<\\/runtime_retained_protocol_context>",
          )}\n${RUNTIME_RETAINED_PROTOCOL_CONTEXT_END}`;
    selected.push({
      item: {
        ...candidate.item,
        images: undefined,
        content,
      },
      index: candidate.index,
    });
    remaining -= body.length;
  }
  return selected
    .sort((left, right) => left.index - right.index);
}

function runtimeImageBytes(image: ImageAttachment) {
  if (Number.isFinite(image.size) && image.size > 0) return image.size;
  const comma = image.dataUrl.indexOf(",");
  const base64Length = comma >= 0 ? image.dataUrl.length - comma - 1 : 0;
  return Math.ceil(base64Length * 0.75);
}

function withoutRuntimeImages(
  item: Extract<HistoryItem, { kind: "message" }>,
): Extract<HistoryItem, { kind: "message" }> {
  if (!item.images?.length) return item;
  if (item.content.includes(RUNTIME_IMAGE_REMOVED_MARKER))
    return { ...item, images: undefined };
  const count = item.images.length;
  return {
    ...item,
    images: undefined,
    content: `${item.content}\n\n${RUNTIME_IMAGE_REMOVED_MARKER} ${count} 张较早图片附件已从运行上下文移除；保留文字上下文和附件计数，不再在后续每轮重复发送图片数据。`,
  };
}

export function compactEvidenceCall(call: ToolCall) {
  const input: Record<string, unknown> = {};
  for (const key of [
    "command",
    "path",
    "from",
    "to",
    "kind",
    "processId",
    "operation",
    "reason",
    "localPath",
    "remotePath",
  ]) {
    if (call.input[key] !== undefined)
      input[key] = String(call.input[key]).slice(0, 4_000);
  }
  return { id: call.id, name: call.name, input };
}

function pendingObligationLines(pending: Iterable<string> = []) {
  return [...new Set([...pending].map(String).filter(Boolean))];
}

function pendingObligationBlock(pending: Iterable<string> = []) {
  const items = pendingObligationLines(pending);
  if (!items.length) return "";
  return `未完成义务（压缩后仍必须用原生工具完成，不得仅凭摘要声称已完成）：\n${items
    .map((operation) => `- ${pendingOperationLabel(operation)} (${operation})`)
    .join("\n")}\n\n`;
}

function isRuntimeCompactionContent(content: string) {
  return (
    content.includes("<runtime_compaction>") ||
    content.includes(RUNTIME_MODEL_COMPACTION_MARKER)
  );
}

function extractRuntimePendingObligations(content: string) {
  const tagged = content.match(
    /<runtime_pending_obligations>\s*([\s\S]*?)\s*<\/runtime_pending_obligations>/i,
  );
  if (!tagged) return [];
  try {
    const parsed = JSON.parse(tagged[1]) as unknown;
    if (Array.isArray(parsed)) return pendingObligationLines(parsed);
  } catch {
    /* Invalid structured payload is not recovered from surrounding prose. */
  }
  return [];
}

function extractHandoffSummaryText(content: string) {
  const modelStart = content.indexOf(RUNTIME_MODEL_COMPACTION_MARKER);
  if (modelStart >= 0) {
    const bodyStart = modelStart + RUNTIME_MODEL_COMPACTION_MARKER.length;
    const evidenceStart = content.indexOf(
      RUNTIME_VERIFIED_EVIDENCE_MARKER,
      bodyStart,
    );
    const end = content.indexOf(RUNTIME_MODEL_COMPACTION_END, bodyStart);
    const bodyEnd =
      evidenceStart >= 0 ? evidenceStart : end >= 0 ? end : content.length;
    return content
      .slice(bodyStart, bodyEnd)
      .replace(/未完成义务[\s\S]*?(?:\n\n|$)/, "")
      .replace(/\s+/g, " ")
      .trim();
  }
  const fallbackStart = content.indexOf("<runtime_compaction>");
  if (fallbackStart < 0) return content.replace(/\s+/g, " ").trim();
  const bodyStart = fallbackStart + "<runtime_compaction>".length;
  const fallbackEnd = content.indexOf("</runtime_compaction>", bodyStart);
  return content
    .slice(bodyStart, fallbackEnd >= 0 ? fallbackEnd : content.length)
    .replace(/未完成义务[\s\S]*?(?:\n\n|$)/, "")
    .replace(/\s+/g, " ")
    .trim();
}

function previousHandoffFactParts(content: string) {
  const parts: string[] = [];
  const summary = extractHandoffSummaryText(content);
  if (summary)
    parts.push(`上次交接：${summary.slice(0, 1_200)}`);
  const evidence = content.match(
    /<runtime_verified_evidence>\s*([\s\S]*?)\s*<\/runtime_verified_evidence>/i,
  );
  if (evidence?.[1]?.trim())
    parts.push(`结构化证据：${evidence[1].trim().slice(0, 1_500)}`);
  return parts;
}

export function compactRuntimeHistory(
  history: HistoryItem[],
  force = false,
  activeConnections: Iterable<string> = [],
  recentItemCount = RUNTIME_COMPACTION_RECENT_ITEMS,
  preserveImageMessageId?: string,
  pendingOperations: Iterable<string> = [],
) {
  const retainedRecentCount = Math.max(
    1,
    Math.min(history.length, Math.floor(recentItemCount)),
  );
  if (history.length <= retainedRecentCount && !force) return false;
  const firstMessage = history.find(
    (item): item is Extract<HistoryItem, { kind: "message" }> =>
      item.kind === "message",
  );
  const recentStart = Math.max(0, history.length - retainedRecentCount);
  const recentSource = history.slice(recentStart);
  const firstMessageIndex = firstMessage ? history.indexOf(firstMessage) : -1;
  // Only the image attached to the request currently being sent is protected.
  // Guessing from recency would keep stale screenshots and eventually exhaust
  // the context window during long conversations.
  const preservedImageIndex = preserveImageMessageId
    ? history.findIndex(
        (item) =>
          item.kind === "message" &&
          item.id === preserveImageMessageId &&
          Boolean(item.images?.length),
      )
    : -1;
  const preservedImageMessage =
    preservedImageIndex >= 0 && history[preservedImageIndex]?.kind === "message"
      ? (history[preservedImageIndex] as Extract<HistoryItem, { kind: "message" }>)
      : undefined;
  const retainedImageIndexes = new Set<number>();
  const retainedOlderImageEntries: {
    item: Extract<HistoryItem, { kind: "message" }>;
    index: number;
  }[] = [];
  if (preservedImageMessage) {
    if (preservedImageIndex >= recentStart)
      retainedImageIndexes.add(preservedImageIndex - recentStart);
    else if (preservedImageIndex !== firstMessageIndex)
      retainedOlderImageEntries.push({
        item: preservedImageMessage,
        index: preservedImageIndex,
      });
  }
  if (!force) {
    let remainingImageBytes = MAX_RETAINED_RUNTIME_IMAGE_BYTES;
    for (let index = recentSource.length - 1; index >= 0; index -= 1) {
      const item = recentSource[index];
      if (item.kind !== "message" || !item.images?.length) continue;
      const imageBytes = item.images.reduce(
        (total, image) => total + runtimeImageBytes(image),
        0,
      );
      if (retainedImageIndexes.has(index)) {
        remainingImageBytes = Math.max(0, remainingImageBytes - imageBytes);
        continue;
      }
      if (imageBytes > remainingImageBytes) continue;
      retainedImageIndexes.add(index);
      remainingImageBytes -= imageBytes;
    }
  }
  const recent = recentSource.map((item, index): HistoryItem => {
    if (item.kind === "message" && item.images?.length) {
      if (retainedImageIndexes.has(index)) return item;
      return withoutRuntimeImages(item);
    }
    if (!force || item.kind !== "result") return item;
    try {
      const result = JSON.parse(item.content) as StructuredToolResult;
      return {
        ...item,
        content: JSON.stringify({
          ...result,
          data: {
            path: result.data?.path,
            command: result.data?.command,
            diff:
              typeof result.data?.diff === "string"
                ? result.data.diff.slice(0, 2_000)
                : undefined,
          },
          truncated: true,
        }),
      };
    } catch {
      return { ...item, content: item.content.slice(0, 2_000) };
    }
  });
  const older = history.slice(0, recentStart);
  const retainedProtocolEntries = retainedRuntimeProtocolMessages(
    older,
    firstMessage,
  );
  const retainedProtocolIndexes = new Set(
    retainedProtocolEntries.map(({ index }) => index),
  );
  const facts: string[] = [];
  const handoffFacts: string[] = [];
  for (const [index, item] of older.entries()) {
    if (item.kind === "message" && item !== firstMessage) {
      if (retainedProtocolIndexes.has(index)) continue;
      if (isRuntimeCompactionContent(item.content)) {
        handoffFacts.push(...previousHandoffFactParts(item.content));
        continue;
      }
      facts.push(
        `${item.role}: ${item.content.replace(/\s+/g, " ").slice(0, 500)}`,
      );
    }
    if (item.kind === "result") {
      try {
        const result = JSON.parse(item.content) as StructuredToolResult;
        const data = result.data ?? {};
        if (
          !result.success ||
          data.diff ||
          data.path ||
          data.changed !== undefined ||
          data.executed !== undefined ||
          data.exitCode !== undefined ||
          data.mutationAttempted !== undefined ||
          data.noChangeReported !== undefined ||
          data.userInputRequested !== undefined ||
          data.operationEvidence !== undefined ||
          data.browserOperationEvidence !== undefined
        )
          facts.push(
            `${result.summary}: ${JSON.stringify({ path: result.data?.path, diff: typeof result.data?.diff === "string" ? result.data.diff.slice(0, 1_000) : undefined, error: result.error })}`,
          );
      } catch {
        /* Ignore legacy unstructured results. */
      }
    }
  }
  const uniqueConnections = [...new Set(activeConnections)];
  const connectionBlock = uniqueConnections.length
    ? `已建立的连接（会话在本次运行内仍然可用，如需重连可复用以下凭据，不要向用户重复索取）：\n${uniqueConnections.join("\n")}\n\n`
    : "";
  const handoffBlock = handoffFacts.length
    ? `上次交接（压缩后仍有效，不得覆盖未完成义务）：\n${handoffFacts.join("\n")}\n\n`
    : "";
  const summary: HistoryItem = {
    kind: "message",
    role: "user",
    content: `<runtime_compaction>较早的 Agent 工具循环已压缩。${connectionBlock}${pendingObligationBlock(pendingOperations)}${handoffBlock}关键状态：\n${facts.slice(-80).join("\n")}</runtime_compaction>`,
  };
  const retainedSpecialByIndex = new Map<number, HistoryItem>(
    retainedProtocolEntries.map(({ index, item }) => [index, item]),
  );
  for (const { index, item } of retainedOlderImageEntries)
    retainedSpecialByIndex.set(index, item);
  const compactedFirstMessage = firstMessage
    ? firstMessageIndex === preservedImageIndex
      ? firstMessage
      : withoutRuntimeImages(firstMessage)
    : undefined;
  const nextHistory = [
    ...(compactedFirstMessage ? [compactedFirstMessage] : []),
    ...(older.length ? [summary] : []),
    ...[...retainedSpecialByIndex.entries()]
      .sort(([left], [right]) => left - right)
      .map(([, item]) => item),
    ...recent.filter(
      (_item, index) => recentStart + index !== firstMessageIndex,
    ),
  ];
  const changed =
    nextHistory.length !== history.length ||
    nextHistory.some((item, index) => item !== history[index]);
  if (!changed) return false;
  history.splice(0, history.length, ...nextHistory);
  return true;
}

const RUNTIME_COMPACTION_RECENT_ITEMS = 8;
const RUNTIME_COMPACTION_MIN_RECENT_ITEMS = 2;
const RUNTIME_COMPACTION_SOURCE_MAX_CHARS = 480_000;
const RUNTIME_COMPACTION_ITEM_MAX_CHARS = 48_000;
const RUNTIME_COMPACTION_TIMEOUT_MS = 45_000;
const RUNTIME_MODEL_COMPACTION_MARKER = "<runtime_model_compaction>";
const RUNTIME_MODEL_COMPACTION_END = "</runtime_model_compaction>";
const RUNTIME_VERIFIED_EVIDENCE_MARKER = "<runtime_verified_evidence>";
const RUNTIME_VERIFIED_EVIDENCE_END = "</runtime_verified_evidence>";

function runtimeCompactionJson(value: unknown) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function runtimeCompactionMessageText(content: string) {
  const withoutInternalBlocks = content
    .replace(/<runtime_(?:model_)?compaction>[\s\S]*?<\/runtime_(?:model_)?compaction>/gi, "")
    .replace(/<runtime_retained_protocol_context>[\s\S]*?<\/runtime_retained_protocol_context>/gi, "")
    .trim();
  return redactSensitiveText(withoutInternalBlocks);
}

function runtimeCompactionItemSource(item: HistoryItem) {
  if (item.kind === "message") {
    if (isRuntimeCompactionContent(item.content)) {
      const parts = previousHandoffFactParts(item.content);
      const previousPending = extractRuntimePendingObligations(item.content);
      return `### 上次运行交接\n${[
        ...parts,
        ...(previousPending.length
          ? [pendingObligationBlock(previousPending).trim()]
          : []),
      ].join("\n")}`;
    }
    const images = item.images?.length
      ? `\n[图片附件：${item.images.length} 个，仅保留名称：${item.images
          .map((image) => image.name)
          .join("、")}]`
      : "";
    return `### ${item.role === "user" ? "用户" : "模型"}\n${redactSensitiveText(item.content)}${images}`;
  }
  if (item.kind === "calls") {
    return `### 工具调用\n${redactSensitiveText(
      boundedContextSource(
        runtimeCompactionJson(
          item.calls.map((call) => ({
            id: call.id,
            name: call.name,
            input: redactedToolInput(call),
          })),
        ),
        RUNTIME_COMPACTION_ITEM_MAX_CHARS,
      ),
    )}`;
  }
  return `### 工具结果 (${item.callId})\n${boundedContextSource(
    redactSensitiveText(item.content),
    RUNTIME_COMPACTION_ITEM_MAX_CHARS,
  )}`;
}

function boundedRuntimeSourcePart(source: string, maxChars: number) {
  if (source.length <= maxChars) return source;
  // Keep the record boundary readable even when the available budget is very
  // small. The normal path uses a head/tail marker; this branch is only for a
  // pathological number of records where every record must get a small slot.
  if (maxChars < 160) return source.slice(0, Math.max(0, maxChars));
  return boundedContextSource(source, maxChars);
}

/**
 * Pack records independently instead of clipping one giant concatenated
 * transcript. This lets the summarizer see the beginning and end of every
 * older turn, while the structured evidence block below remains authoritative
 * for exact tool outcomes.
 */
function packRuntimeCompactionRecords(records: string[], maxChars: number) {
  if (!records.length || maxChars <= 0) return "";
  const separator = "\n\n";
  const separatorBudget = Math.max(0, records.length - 1) * separator.length;
  const available = Math.max(0, maxChars - separatorBudget);
  const perRecord = Math.floor(available / records.length);
  if (perRecord <= 0) return "";
  return records
    .map((record) => boundedRuntimeSourcePart(record, perRecord))
    .join(separator);
}

function runtimeCompactionSourceLimit(
  request: ModelRequest,
  provider: ProviderWithKey,
) {
  const selectedModel = provider.models.find(
    (model) => model.modelId === request.modelId,
  );
  const summaryProtocol =
    provider.protocol === "openai-responses" &&
    (selectedModel?.supportsResponses === false ||
      effectiveOpenAiProtocol(provider.id, provider.protocol, request.modelId) ===
        "openai-chat")
      ? "openai-chat"
      : provider.protocol;
  const summaryModel = summaryModelForProvider(
    provider,
    request.modelId,
    summaryProtocol,
  );
  const summaryConfig = provider.models.find(
    (model) => model.modelId === summaryModel,
  );
  const taskWindow = request.contextWindow ?? 128_000;
  const summaryWindow = resolveModelContextWindow(
    summaryModel,
    summaryConfig?.contextWindow,
  );
  // Leave room for the handoff instructions and the generated JSON response.
  // The upper bound avoids sending an unexpectedly huge compaction request to
  // a small third-party relay, while still allowing large-context providers to
  // receive substantially more than the old fixed 120k-character slice.
  return Math.max(
    12_000,
    Math.min(
      RUNTIME_COMPACTION_SOURCE_MAX_CHARS,
      Math.floor(Math.min(taskWindow, summaryWindow) * 0.22 * 3),
    ),
  );
}

/**
 * Build the input for the semantic compactor. This is a transport guard only:
 * the model receives all older records until the provider-safe limit, packed at
 * record boundaries rather than by clipping one concatenated string. Verified
 * tool evidence is appended separately so a long narrative cannot hide a
 * mutation, failure, or transfer.
 */
export function buildRuntimeCompactionSource(
  history: HistoryItem[],
  activeConnections: Iterable<string> = [],
  maxChars = RUNTIME_COMPACTION_SOURCE_MAX_CHARS,
  recentItemCount = RUNTIME_COMPACTION_RECENT_ITEMS,
  pendingOperations: Iterable<string> = [],
) {
  const retainedRecentCount = Math.max(
    1,
    Math.min(history.length, Math.floor(recentItemCount)),
  );
  const older = history.slice(0, Math.max(0, history.length - retainedRecentCount));
  const records: string[] = [];
  const previousHandoffs: string[] = [];
  for (const item of older) {
    if (item.kind === "message" && isRuntimeCompactionContent(item.content))
      previousHandoffs.push(runtimeCompactionItemSource(item));
    else records.push(runtimeCompactionItemSource(item));
  }
  const evidence = structuredToolEvidenceSummary(older);
  const connections = [...new Set([...activeConnections].map((item) => redactSensitiveText(item)))]
    .filter(Boolean);
  const safeMaxChars = Math.max(
    12_000,
    Math.min(RUNTIME_COMPACTION_SOURCE_MAX_CHARS, Math.floor(maxChars)),
  );
  const prefix = [
    "<runtime_compaction_source>",
    "以下是即将从运行上下文移出的较早记录。请用模型生成可继续执行的语义交接摘要，不要只截取开头或机械拼接句子。工具结果中的成功、失败、文件和传输信息是事实；没有工具证据的模型描述必须标记为未验证。",
  ].join("\n\n");
  const closing = "</runtime_compaction_source>";
  const separator = "\n\n";
  const wrapperBudget =
    prefix.length + closing.length + separator.length * 3;
  const contentBudget = Math.max(0, safeMaxChars - wrapperBudget);
  const evidenceBudget = Math.max(160, Math.floor(contentBudget * 0.38));
  const evidenceBlock = boundedRuntimeSourcePart(
    `${RUNTIME_VERIFIED_EVIDENCE_MARKER}\n${runtimeCompactionJson(evidence)}\n${RUNTIME_VERIFIED_EVIDENCE_END}`,
    evidenceBudget,
  );
  const connectionLabel = "已建立连接（不含秘密）：\n";
  const connectionBudget = Math.max(160, Math.floor(contentBudget * 0.18));
  const connectionPayload = packRuntimeCompactionRecords(
    connections.map((item) => `- ${item}`),
    Math.max(0, connectionBudget - connectionLabel.length),
  );
  const connectionBlock = connectionPayload
    ? `${connectionLabel}${connectionPayload}`
    : "";
  const pendingBlock = pendingObligationBlock(pendingOperations).trim();
  const previousHandoffBlock = previousHandoffs.join(separator);
  const fixedLength = [
    prefix,
    evidenceBlock,
    connectionBlock,
    pendingBlock,
    previousHandoffBlock,
    closing,
  ]
    .filter(Boolean)
    .join(separator).length;
  const transcriptBudget = Math.max(
    0,
    safeMaxChars - fixedLength - (records.length ? separator.length : 0),
  );
  const transcript = packRuntimeCompactionRecords(records, transcriptBudget);
  const source = [
    prefix,
    transcript,
    evidenceBlock,
    connectionBlock,
    pendingBlock,
    previousHandoffBlock,
    closing,
  ]
    .filter(Boolean)
    .join(separator);
  const overflow = [
    prefix,
    evidenceBlock,
    connectionBlock,
    pendingBlock,
    previousHandoffBlock,
    closing,
  ]
    .filter(Boolean)
    .join(separator);
  return redactSensitiveText(source.length <= safeMaxChars ? source : overflow);
}

function runtimeCompactionUserText(content: string) {
  return runtimeCompactionMessageText(content)
    .replace(/<[^>]+>[\s\S]*?<\/[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Runtime-owned facts passed to the model as a non-authoritative fallback ledger. */
export function buildRuntimeCompactionLedger(
  history: HistoryItem[],
  evidenceHistory: HistoryItem[] = history,
  activeConnections: Iterable<string> = [],
  pendingOperations: Iterable<string> = [],
): ContextLedger {
  const evidence = structuredToolEvidenceSummary(evidenceHistory);
  const goals = history
    .filter(
      (item): item is Extract<HistoryItem, { kind: "message" }> =>
        item.kind === "message" &&
        item.role === "user" &&
        !item.content.includes("<runtime_"),
    )
    .map((item) => runtimeCompactionUserText(item.content))
    .filter(Boolean)
    .map((item) => item.slice(-4_000));
  const validations: string[] = [];
  const failures: string[] = [];
  for (const item of evidenceHistory) {
    if (item.kind !== "result") continue;
    try {
      const result = JSON.parse(item.content) as StructuredToolResult;
      const data = result.data ?? {};
      const operationEvidence = Array.isArray(data.operationEvidence)
        ? data.operationEvidence.map(String)
        : [String(data.operationEvidence ?? "")];
      if (operationEvidence.includes("validate"))
        validations.push(result.summary || "已执行验证");
      if (!result.success)
        failures.push(result.error?.message || result.summary || "工具执行失败");
    } catch {
      // Legacy unstructured results are still present in the source transcript.
    }
  }
  const unique = (items: string[], limit: number) =>
    [...new Set(items.map((item) => redactSensitiveText(item).trim()).filter(Boolean))].slice(-limit);
  return {
    goals: unique(goals, 16),
    decisions: [],
    changedFiles: unique(evidence.changedFiles, 64),
    validations: unique(validations, 32),
    failures: unique(failures, 32),
    pending: unique(
      pendingObligationLines(pendingOperations).map(
        (operation) => `${pendingOperationLabel(operation)} (${operation})`,
      ),
      32,
    ),
    connections: unique([...activeConnections], 16),
  };
}

function runtimeCompactionSummaryContent(
  result: ContextSummaryResult,
  evidenceHistory: HistoryItem[],
  pendingOperations: Iterable<string> = [],
) {
  const summary = redactSensitiveText(result.summary.trim()).replace(
    new RegExp(RUNTIME_MODEL_COMPACTION_END, "gi"),
    "<\\/runtime_model_compaction>",
  );
  const evidence = structuredToolEvidenceSummary(evidenceHistory);
  const pending = pendingObligationLines(pendingOperations);
  const pendingBlock = pendingObligationBlock(pending).trim();
  return [
    RUNTIME_MODEL_COMPACTION_MARKER,
    "以下为模型生成的语义交接摘要。它用于延续上下文；真实执行事实以紧随其后的结构化工具证据为准。摘要不得把未完成义务写成已完成。",
    summary,
    RUNTIME_VERIFIED_EVIDENCE_MARKER,
    runtimeCompactionJson(evidence),
    RUNTIME_VERIFIED_EVIDENCE_END,
    ...(pendingBlock ? [pendingBlock] : []),
    ...(pending.length
      ? [
          "<runtime_pending_obligations>",
          runtimeCompactionJson(pending),
          "</runtime_pending_obligations>",
        ]
      : []),
    RUNTIME_MODEL_COMPACTION_END,
  ].join("\n");
}

function replaceRuntimeCompactionSummary(
  history: HistoryItem[],
  result: ContextSummaryResult,
  evidenceHistory: HistoryItem[],
  pendingOperations: Iterable<string> = [],
) {
  const index = history.findIndex(
    (item) =>
      item.kind === "message" && item.content.includes("<runtime_compaction>"),
  );
  if (index < 0) return false;
  const item = history[index];
  if (item.kind !== "message") return false;
  history[index] = {
    ...item,
    content: runtimeCompactionSummaryContent(
      result,
      evidenceHistory,
      pendingOperations,
    ),
    images: undefined,
  };
  return true;
}

export type RuntimeCompactionStrategy = "model" | "fallback" | "none";
export type RuntimeContextSummaryArgs = {
  requestId: string;
  taskId: string;
  request: ModelRequest;
  provider: ProviderWithKey;
  source: string;
  ledger: ContextLedger;
  signal: AbortSignal;
};
export type RuntimeContextSummarizer = (
  args: RuntimeContextSummaryArgs,
) => Promise<ContextSummaryResult>;
export type RuntimeCompactionResult = {
  changed: boolean;
  strategy: RuntimeCompactionStrategy;
  modelId?: string;
  summary?: string;
  usage?: { input: number; output: number };
  error?: string;
};

function boundedRuntimeModelSummary(
  result: ContextSummaryResult,
  contextWindow?: number,
) {
  const maxChars = Math.min(
    40_000,
    Math.max(6_000, Math.floor((contextWindow ?? 128_000) * 0.12 * 3)),
  );
  return {
    ...result,
    summary: boundedContextSource(redactSensitiveText(result.summary), maxChars),
  };
}

function runtimeSummaryLooksUsable(
  summary: unknown,
  contextWindow?: number,
): summary is string {
  if (typeof summary !== "string") return false;
  const normalized = summary.trim();
  const maxChars = Math.min(
    80_000,
    Math.max(6_000, Math.floor((contextWindow ?? 128_000) * 0.18 * 3)),
  );
  if (!normalized || normalized.length > maxChars) return false;
  const lines = normalized
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length >= 12);
  if (lines.length < 8) return true;
  return 1 - new Set(lines).size / lines.length <= 0.45;
}

export async function defaultRuntimeContextSummarizer(
  args: RuntimeContextSummaryArgs,
): Promise<ContextSummaryResult> {
  return summarizeContextWithProvider(
    {
      taskId: args.taskId,
      providerId: args.provider.id,
      modelId: args.request.modelId,
      source: args.source,
      ledger: args.ledger,
    },
    args.provider,
    { signal: args.signal, timeoutMs: RUNTIME_COMPACTION_TIMEOUT_MS },
  );
}

function runtimeCompactionRecentItemCount(
  history: HistoryItem[],
  contextWindow: number | undefined,
  force: boolean,
) {
  const maximum = Math.min(
    RUNTIME_COMPACTION_RECENT_ITEMS,
    Math.max(1, history.length),
  );
  if (
    !contextWindow ||
    history.length <= RUNTIME_COMPACTION_MIN_RECENT_ITEMS ||
    effectiveRuntimePromptTokens(history, 0) <
      contextWindow * (force ? 0.9 : 0.92)
  )
    return maximum;
  // Under pressure, keep the latest two to three protocol items and let the
  // model summarize the rest. This also handles a short history containing one
  // unusually large tool result, which the old fixed-eight rule skipped.
  return Math.max(
    RUNTIME_COMPACTION_MIN_RECENT_ITEMS,
    Math.min(maximum, Math.ceil(maximum * 0.35)),
  );
}

/**
 * Compact runtime history with a model-generated handoff first. The local
 * compactor is deliberately kept as an emergency path for provider errors,
 * malformed summaries, cancellation, and hard context pressure.
 */
export async function compactRuntimeHistoryWithModel(
  history: HistoryItem[],
  options: {
    requestId: string;
    request: ModelRequest;
    provider: ProviderWithKey;
    evidenceHistory?: HistoryItem[];
    force?: boolean;
    activeConnections?: Iterable<string>;
    preserveImageMessageId?: string;
    pendingOperations?: Iterable<string>;
    signal?: AbortSignal;
    summarize?: RuntimeContextSummarizer;
  },
): Promise<RuntimeCompactionResult> {
  const force = options.force ?? false;
  const activeConnections = [...(options.activeConnections ?? [])];
  const pendingOperations = [...(options.pendingOperations ?? [])];
  const recentItemCount = runtimeCompactionRecentItemCount(
    history,
    options.request.contextWindow,
    force,
  );
  if (history.length <= recentItemCount && !force)
    return { changed: false, strategy: "none" };
  const evidenceHistory = options.evidenceHistory ?? history;
  const source = buildRuntimeCompactionSource(
    history,
    activeConnections,
    runtimeCompactionSourceLimit(options.request, options.provider),
    recentItemCount,
    pendingOperations,
  );
  const ledger = buildRuntimeCompactionLedger(
    history,
    evidenceHistory,
    activeConnections,
    pendingOperations,
  );
  // A custom provider resolver is commonly used by embedders/tests without a
  // network-capable provider. In that case the caller must explicitly opt in
  // to a summarizer; the production path below always supplies one.
  const summarizer = options.summarize;
  if (!summarizer) {
    const fallbackChanged = compactRuntimeHistory(
      history,
      force,
      activeConnections,
      recentItemCount,
      options.preserveImageMessageId,
      pendingOperations,
    );
    return {
      changed: fallbackChanged,
      strategy: fallbackChanged ? "fallback" : "none",
    };
  }
  try {
    if (options.signal?.aborted) throw new Error("上下文压缩已取消");
    const result = await summarizer({
      requestId: options.requestId,
      taskId: options.request.taskId ?? options.requestId,
      request: options.request,
      provider: options.provider,
      source,
      ledger,
      signal: options.signal ?? new AbortController().signal,
    });
    if (
      !result.modelGenerated ||
      !runtimeSummaryLooksUsable(result.summary, options.request.contextWindow)
    )
      throw new Error("模型未返回有效的上下文摘要");
    const boundedResult = boundedRuntimeModelSummary(
      result,
      options.request.contextWindow,
    );
    const nextHistory = [...history];
    if (
      !compactRuntimeHistory(
        nextHistory,
        force,
        activeConnections,
        recentItemCount,
        options.preserveImageMessageId,
        pendingOperations,
      ) ||
      !replaceRuntimeCompactionSummary(
        nextHistory,
        boundedResult,
        evidenceHistory,
        pendingOperations,
      )
    )
      return { changed: false, strategy: "none" };
    history.splice(0, history.length, ...nextHistory);
    return {
      changed: true,
      strategy: "model",
      modelId: boundedResult.modelId ?? options.request.modelId,
      summary: boundedResult.summary,
      usage: boundedResult.usage,
    };
  } catch (error) {
    const fallbackChanged = compactRuntimeHistory(
      history,
      force,
      activeConnections,
      recentItemCount,
      options.preserveImageMessageId,
      pendingOperations,
    );
    return {
      changed: fallbackChanged,
      strategy: fallbackChanged ? "fallback" : "none",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}


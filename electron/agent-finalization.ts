import path from "node:path";
import {
  type AgentActivity,
  type AgentCompletionResult,
  type AgentPlanRequirement,
  type AgentEvent,
  type AgentPlanStepStatus,
  type AgentToolName,
} from "../src/types";
import { UpstreamHttpError } from "./request-guard";
import {
  missingRequestedGitOperations,
  successfulGitEvidence,
  type GitOperation,
  unavailableGitOperations,
} from "./git-operation-verification";
import {
  hasRequestedUserInputEvidence,
  hasVerifiedNoChangeReport,
  isInspectionCommand,
  isValidationCommand,
  missingVerifiedCodingOperations,
  structuredToolEvidenceSummary,
  successfulCodingEvidence,
  successfulToolNames,
  type CodingOperation,
} from "./coding-operation-verification";
import {
  missingRequestedBrowserOperations,
  successfulBrowserEvidence,
  type BrowserOperation,
} from "./browser-operation-verification";
import { buildAgentCompletionResult } from "./agent-completion";
import { SseStreamTimeoutError } from "./sse-stream";
import type {
  StructuredToolResult,
  ToolCall,
  ToolResult,
  HistoryItem,
} from "./agent-types";

export function blockedVerificationEvents(
  textOffset: number,
  message: string,
  result?: AgentCompletionResult,
): AgentEvent[] {
  return [
    {
      type: "final_response",
      textOffset,
      startedAt: Date.now(),
      phase: "final_answer",
    },
    { type: "text", delta: message, phase: "final_answer" },
    // A runtime hard-stop is a PAUSE, not a request for user input. Only the
    // native request_user_input tool maps to the "待补充" (blocked) badge.
    { type: "done", outcome: "paused", result },
  ];
}

export function codingEvidenceWithBaseline(
  history: HistoryItem[],
  baseline: ReadonlySet<CodingOperation>,
) {
  const evidence = successfulCodingEvidence(history);
  for (const operation of baseline) evidence.add(operation);
  return evidence;
}

const ACTIONABLE_PLAN_REQUIREMENTS = new Set<AgentPlanRequirement>([
  "modify",
  "execute",
  "validate",
  "connect",
  "upload",
  "download",
]);

export const MAX_PLAN_RECOVERY_NUDGES = 3;

const OPERATIONAL_PROGRESS_TOOLS = new Set<AgentToolName>([
  "ssh_upload_file",
  "ssh_download_file",
  "start_process",
  "stop_process",
  "browser_open",
  "browser_click",
  "browser_type",
  "browser_fill_credential",
  "browser_record_start",
  "browser_record_stop",
  "mcp_call_tool",
]);

export function toolProducedOperationalProgress(
  call: ToolCall,
  activity: AgentActivity,
  resultEvidence: Pick<
    ToolResult,
    "changed" | "mutationAttempted" | "operationEvidence"
  >,
) {
  if (activity.status !== "success") return false;
  if (
    resultEvidence.changed === true ||
    resultEvidence.mutationAttempted === true ||
    Boolean(activity.diff) ||
    Boolean(activity.additions) ||
    Boolean(activity.deletions)
  )
    return true;
  if (call.name === "run_command" || call.name === "ssh_run") {
    const purpose = String(call.input.purpose ?? "").trim();
    // A validation result is evidence, but it does not change the world. It
    // must not keep an unchanged polling loop alive indefinitely.
    if (purpose === "inspect" || purpose === "validate") return false;
    if (purpose === "modify") return true;
    // Explicit execute intent covers builds, deployments, and other commands
    // whose success may not produce a local diff.
    if (purpose === "execute") return true;
    const command = String(call.input.command ?? "");
    return !isInspectionCommand(command) && !isValidationCommand(command);
  }
  if (call.name === "diagnostics") return false;
  if (OPERATIONAL_PROGRESS_TOOLS.has(call.name)) return true;
  return false;
}

export function firstPendingRequiredPlanStep(
  steps: readonly string[],
  _statuses: readonly AgentPlanStepStatus[] | undefined,
  requirements: readonly AgentPlanRequirement[][],
  evidence: ReadonlySet<CodingOperation> = new Set(),
) {
  return firstPlanStepMissingEvidence(steps, _statuses, requirements, evidence);
}

export function firstPlanStepMissingEvidence(
  steps: readonly string[],
  _statuses: readonly AgentPlanStepStatus[] | undefined,
  requirements: readonly AgentPlanRequirement[][],
  evidence: ReadonlySet<CodingOperation>,
) {
  if (requirements.length !== steps.length) return -1;
  return steps.findIndex((_, index) =>
    requirements[index]?.some(
      (requirement) =>
        ACTIONABLE_PLAN_REQUIREMENTS.has(requirement) &&
        !evidence.has(requirement as CodingOperation),
    ),
  );
}

export function hasActionablePlanRequirements(
  requirements: readonly AgentPlanRequirement[][],
) {
  return requirements.some((step) =>
    step.some((requirement) => ACTIONABLE_PLAN_REQUIREMENTS.has(requirement)),
  );
}

export function planRequirementRecoveryLabel(
  missingOperations: readonly CodingOperation[],
) {
  return missingOperations.length
    ? `仍缺少 ${missingOperations.join("、")} 的成功工具证据`
    : "结构化计划中仍有需要执行的步骤";
}

export function buildPausedCompletionResult({
  evidenceHistory,
  baselineCodingEvidence,
  requestedCodingEvidenceOps,
  requestedBrowserOps,
  requestedGitOps,
  plannerExecutionPending,
  planRequirementsPending = false,
  planPending = false,
  planSteps,
  planStatuses,
  planRequirements,
  pauseReason,
}: {
  evidenceHistory: HistoryItem[];
  baselineCodingEvidence: ReadonlySet<CodingOperation>;
  requestedCodingEvidenceOps: Set<CodingOperation>;
  requestedBrowserOps: Set<BrowserOperation>;
  requestedGitOps: Set<GitOperation>;
  plannerExecutionPending: boolean;
  planRequirementsPending?: boolean;
  planPending?: boolean;
  planSteps?: readonly string[];
  planStatuses?: readonly AgentPlanStepStatus[];
  planRequirements?: readonly AgentPlanRequirement[][];
  /** Soften the incomplete notice when pausing for a stream safety boundary. */
  pauseReason?: "stream-timeout" | "empty-turn" | "other";
}): AgentCompletionResult {
  const codingEvidence = codingEvidenceWithBaseline(
    evidenceHistory,
    baselineCodingEvidence,
  );
  const browserEvidence = successfulBrowserEvidence(evidenceHistory);
  const gitEvidence = successfulGitEvidence(evidenceHistory);
  const unavailableGitEvidence = unavailableGitOperations(evidenceHistory);
  const missingCodingEvidence = missingVerifiedCodingOperations(
    requestedCodingEvidenceOps,
    codingEvidence,
    evidenceHistory,
  );
  // Prefer evidence over plan statuses: a step whose requires[] are already
  // satisfied must not keep plan:pending on a stream-timeout pause just
  // because the model never called update_plan to flip statuses.
  const evidencePlanPending =
    planSteps && planRequirements
      ? firstPendingRequiredPlanStep(
          planSteps,
          planStatuses,
          planRequirements,
          codingEvidence,
        ) >= 0
      : planPending;
  const requestedOperations = [
    ...[...requestedCodingEvidenceOps].map(
      (operation) => `coding:${operation}`,
    ),
    ...[...requestedBrowserOps].map((operation) => `browser:${operation}`),
    ...[...requestedGitOps].map((operation) => `git:${operation}`),
    ...(plannerExecutionPending ? ["agent:spawn_executor"] : []),
    ...(planRequirementsPending ? ["plan:requirements"] : []),
    ...(evidencePlanPending ? ["plan:pending"] : []),
  ];
  const observedOperations = [
    ...[...codingEvidence].map((operation) => `coding:${operation}`),
    ...[...browserEvidence].map((operation) => `browser:${operation}`),
    ...[...gitEvidence].map((operation) => `git:${operation}`),
    ...(successfulToolNames(evidenceHistory).has("spawn_agent")
      ? ["agent:spawn_executor"]
      : []),
  ];
  const missingOperations = [
    ...missingCodingEvidence
      .filter((operation) => operation !== "inspect")
      .map((operation) => `coding:${operation}`),
    ...missingRequestedBrowserOperations(
      requestedBrowserOps,
      browserEvidence,
    ).map((operation) => `browser:${operation}`),
    ...missingRequestedGitOperations(requestedGitOps, gitEvidence)
      .filter((operation) => !unavailableGitEvidence.has(operation))
      .map((operation) => `git:${operation}`),
    ...(plannerExecutionPending ? ["agent:spawn_executor"] : []),
    ...(planRequirementsPending ? ["plan:requirements"] : []),
    ...(evidencePlanPending ? ["plan:pending"] : []),
  ];
  const result = buildAgentCompletionResult({
    requestedOperations,
    observedOperations,
    missingOperations,
    evidence: structuredToolEvidenceSummary(evidenceHistory),
    waitingForUser: hasRequestedUserInputEvidence(evidenceHistory),
    verifiedNoChange: hasVerifiedNoChangeReport(evidenceHistory),
  });
  const hasMissing = missingOperations.length > 0;
  const streamTimeoutNotice =
    pauseReason === "stream-timeout"
      ? hasMissing
        ? "本轮因单轮安全边界暂停。已有工具结果和实际改动已保留；点击“继续”可从当前未完成步骤恢复。"
        : "本轮因单轮安全边界暂停。已有工具结果和实际改动已保留；点击“继续”可从当前状态恢复。"
      : undefined;
  return {
    ...result,
    // Paused runs stay "incomplete" for the Continue affordance, but the
    // missingOperations ledger (and stream-timeout notice) must not falsely
    // claim plan/modify gaps when codingEvidence already satisfies requires.
    kind: result.kind === "blocked" ? "blocked" : "incomplete",
    notice:
      streamTimeoutNotice ??
      (hasMissing ? result.notice : undefined) ??
      "任务因连续无新进展而暂停，已有执行记录和实际改动已保留。",
  };
}

export function isFinalizationReasoningFailure(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return /收尾阶段持续只有思考内容|连续只输出思考内容|持续没有正文或工具调用|模型单轮响应超过安全时限/.test(
    message,
  );
}

export function isModelTurnTimeout(error: unknown) {
  if (error instanceof SseStreamTimeoutError)
    return (
      error.timeoutKind === "meaningful" || error.timeoutKind === "absolute"
    );
  const message = error instanceof Error ? error.message : String(error);
  return /连续只输出思考内容|持续只有思考内容|模型单轮响应超过安全时限/.test(
    message,
  );
}

/** Absolute wall-clock turn limit — always pause; never auto-continue. */
export function isAbsoluteModelTurnTimeout(error: unknown) {
  if (error instanceof SseStreamTimeoutError)
    return error.timeoutKind === "absolute";
  const message = error instanceof Error ? error.message : String(error);
  return /模型单轮响应超过安全时限|超过 \d+ 秒安全时限/.test(message);
}

/**
 * Meaningful/reasoning-only idle watchdog (or the Error raised after the
 * in-stream one-shot recovery). Eligible for one outer auto-continue when
 * prior tool evidence exists and structured work remains.
 */
export function isMeaningfulModelTurnTimeout(error: unknown) {
  if (isAbsoluteModelTurnTimeout(error)) return false;
  if (error instanceof SseStreamTimeoutError)
    return error.timeoutKind === "meaningful";
  const message = error instanceof Error ? error.message : String(error);
  return /连续只输出思考内容|持续只有思考内容|没有形成新的正文或工具调用|持续没有正文或工具调用/.test(
    message,
  );
}

export function modelTurnTimeoutKind(
  error: unknown,
): "meaningful" | "absolute" | "other" {
  if (isAbsoluteModelTurnTimeout(error)) return "absolute";
  if (isMeaningfulModelTurnTimeout(error) || isModelTurnTimeout(error))
    return "meaningful";
  return "other";
}

export function hasRecoverableToolEvidence(history: HistoryItem[]) {
  return [...successfulToolNames(history)].some(
    (tool) => tool !== "get_context_remaining",
  );
}

export function streamFailurePauseMessage(error: unknown) {
  if (
    error instanceof SseStreamTimeoutError &&
    error.timeoutKind === "absolute"
  )
    return `模型单轮响应超过 ${Math.round(error.timeoutMs / 1_000)} 秒安全时限，已暂停等待。已有工具结果和实际文件修改均已保留；点击“继续”后会从当前状态恢复。`;
  if (isModelTurnTimeout(error))
    return "模型本轮持续思考但没有形成新的正文或工具调用，已达到单轮安全边界并暂停。已有工具结果和实际文件修改均已保留；点击“继续”后会从当前状态恢复。";
  const cause =
    error instanceof UpstreamHttpError
      ? `上游返回 ${error.status}`
      : "上游连接暂时不可用";
  return `${cause}，多次自动重连后仍未恢复。任务已安全暂停，已有工具结果均已保留，已经发生的实际文件修改不会丢失；点击“继续”后会从未完成的步骤恢复，不会重做已确认成功的步骤。`;
}

function evidencePathKey(value: string) {
  return value.replace(/\\/g, "/").toLowerCase();
}

function markdownLocalFileLink(filePath: string) {
  const normalized = filePath.replace(/\\/g, "/");
  const href = normalized
    .split("/")
    .map((segment, index) =>
      index === 0 && /^[a-z]:$/i.test(segment)
        ? segment
        : encodeURIComponent(segment),
    )
    .join("/");
  const label = path.posix.basename(normalized).replace(/([\\[\]])/g, "\\$1");
  return `[${label}](${href})`;
}

function markdownCodePath(filePath: string) {
  return `\`${filePath.replace(/`/g, "'")}\``;
}

function finalizationEvidenceHighlights(history: HistoryItem[]) {
  const calls = new Map<string, ToolCall>();
  for (const item of history)
    if (item.kind === "calls")
      for (const call of item.calls) calls.set(call.id, call);
  let validationCount = 0;
  let commandCount = 0;
  const validationTargets = new Set<string>();
  const downloads = new Map<
    string,
    { localPath: string; remotePath?: string }
  >();
  const uploads = new Map<string, { remotePath: string; localPath?: string }>();
  const transferPaths = new Set<string>();
  for (const item of history) {
    if (item.kind !== "result") continue;
    let result: StructuredToolResult;
    try {
      result = JSON.parse(item.content) as StructuredToolResult;
    } catch {
      continue;
    }
    if (result.success !== true) continue;
    const call = calls.get(item.callId);
    if (!call) continue;
    if (call.name === "ssh_download_file") {
      const localPath = String(
        result.data?.path ?? call.input.localPath ?? "",
      ).trim();
      const remotePath = String(call.input.remotePath ?? "").trim();
      if (localPath) {
        downloads.set(evidencePathKey(localPath), {
          localPath,
          remotePath: remotePath || undefined,
        });
        transferPaths.add(evidencePathKey(localPath));
      }
    } else if (call.name === "ssh_upload_file") {
      const remotePath = String(
        result.data?.path ?? call.input.remotePath ?? "",
      ).trim();
      const localPath = String(call.input.localPath ?? "").trim();
      if (remotePath) {
        uploads.set(evidencePathKey(remotePath), {
          remotePath,
          localPath: localPath || undefined,
        });
        transferPaths.add(evidencePathKey(remotePath));
      }
    }
    if (["run_command", "ssh_run", "diagnostics"].includes(call.name))
      commandCount += 1;
    const operationEvidence = Array.isArray(result.data?.operationEvidence)
      ? result.data.operationEvidence
      : [];
    if (
      call.name === "diagnostics" ||
      operationEvidence.includes("validate") ||
      (call.name === "run_command" &&
        isValidationCommand(String(call.input.command ?? ""))) ||
      (call.name === "ssh_run" &&
        isValidationCommand(String(call.input.command ?? "")))
    ) {
      validationCount += 1;
      const target = String(
        call.input.path ?? call.input.file_path ?? "",
      ).trim();
      if (target) validationTargets.add(target.slice(-180));
    }
  }
  return {
    commandCount,
    validationCount,
    validationTargets: [...validationTargets].slice(-6),
    downloads: [...downloads.values()],
    uploads: [...uploads.values()],
    transferPaths,
  };
}

export function runtimeFinalizationFallback(
  evidenceHistory: HistoryItem[],
  evidenceComplete: boolean,
  externalWorkAbandoned = false,
) {
  const summary = structuredToolEvidenceSummary(evidenceHistory);
  const highlights = finalizationEvidenceHighlights(evidenceHistory);
  const changedFiles = summary.changedFiles.filter(
    (file) => !highlights.transferPaths.has(evidencePathKey(file)),
  );
  const visibleChangedFiles = changedFiles.slice(0, 5);
  const lines = [
    evidenceComplete && !externalWorkAbandoned
      ? "本轮请求对应的执行证据已收集，以下摘要只依据实际工具记录。"
      : "本轮已安全暂停，以下仅列出已经确认的执行结果。",
    `执行记录：共 ${summary.toolCalls} 项工具，成功 ${summary.successfulTools} 项${summary.failedTools ? `，失败或停止 ${summary.failedTools} 项` : ""}。`,
  ];
  if (highlights.downloads.length) {
    const visibleDownloads = highlights.downloads.slice(0, 5);
    lines.push(
      `下载完成：${highlights.downloads.length} 个文件已保存到本地。`,
      ...visibleDownloads.map(
        (download) =>
          `- ${markdownLocalFileLink(download.localPath)}${download.remotePath ? `（来自 ${markdownCodePath(download.remotePath)}）` : ""}`,
      ),
    );
    if (highlights.downloads.length > visibleDownloads.length)
      lines.push(
        `- 还有 ${highlights.downloads.length - visibleDownloads.length} 个下载文件`,
      );
  }
  if (highlights.uploads.length) {
    const visibleUploads = highlights.uploads.slice(0, 5);
    lines.push(
      `上传完成：${highlights.uploads.length} 个文件已发送到远程。`,
      ...visibleUploads.map(
        (upload) =>
          `- ${markdownCodePath(upload.remotePath)}${upload.localPath ? `（来自 ${markdownLocalFileLink(upload.localPath)}）` : ""}`,
      ),
    );
    if (highlights.uploads.length > visibleUploads.length)
      lines.push(
        `- 还有 ${highlights.uploads.length - visibleUploads.length} 个上传文件`,
      );
  }
  if (changedFiles.length) {
    lines.push(
      `实际改动：${changedFiles.length} 个文件（+${summary.additions} -${summary.deletions}）。`,
      ...visibleChangedFiles.map((file) => `- ${file}`),
    );
    if (changedFiles.length > visibleChangedFiles.length)
      lines.push(
        `- 还有 ${changedFiles.length - visibleChangedFiles.length} 个文件`,
      );
  } else if (!highlights.downloads.length && !highlights.uploads.length)
    lines.push("实际改动：未检测到已确认的文件变更。");
  if (highlights.commandCount)
    lines.push(`命令与验证：已执行 ${highlights.commandCount} 项命令。`);
  if (highlights.validationCount) {
    lines.push(`已确认验证：${highlights.validationCount} 项。`);
    for (const target of highlights.validationTargets)
      lines.push(`- ${target}`);
  }
  if (externalWorkAbandoned)
    lines.push(
      "子任务：部分子 Agent 因连续等待没有新进展已停止；未收到的结果不会被视为成功。",
    );
  if (!evidenceComplete)
    lines.push(
      "尚未确认：本轮要求的全部成功执行证据。点击“继续”可从当前记录恢复。",
    );
  else lines.push("模型未返回额外说明，本轮结论已根据上述结构化执行记录生成。");
  return lines.join("\n");
}

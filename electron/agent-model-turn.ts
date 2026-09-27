import { emitAgentTerminalEvents } from "./agent-terminal";
import {
  type AgentActivity,
  type AgentEvent,
  type ModelRequest,
} from "../src/types";
import { isUnsupportedImageInputError } from "../src/model-capabilities";
import { isRetryableStreamError } from "./request-guard";
import {
  shouldRequireCodingTool,
  type CodingOperation,
} from "./coding-operation-verification";
import { MODEL_TURN_HTTP_ATTEMPTS } from "./model-stream-retry";
import { ModelAttemptBudget } from "./model-attempt-budget";
import { effectiveRuntimePromptTokens } from "./runtime-context-budget";
import { browserIsOpen } from "./browser";
import { listSubagents, subagentProgressToken } from "./subagents";
import type { AgentFinalizationMode } from "./agent-run-budget";
import {
  EMPTY_TURN_FORCE_TOOL_CONTENT,
  EMPTY_TURN_RETRY_CONTENT,
  emptyTurnRecovery,
  REASONING_ONLY_FORCE_TOOL_CONTENT,
  REASONING_ONLY_RETRY_CONTENT,
  shouldForceToolAfterEmptyRecovery,
  streamTimeoutRecovery,
  STREAM_TIMEOUT_RECOVERY_LIMIT,
  STREAM_TIMEOUT_RECOVERY_CONTENT,
  STREAM_TRANSPORT_RECOVERY_CONTENT,
  type RoundEvidenceSnapshot,
} from "./agent-round-policy";
import type {
  Turn,
  ModelTurnRuntime,
  HistoryItem,
  ModelStreamFn,
} from "./agent-types";
import {
  codingEvidenceWithBaseline,
  runtimeFinalizationFallback,
  isRecoverableFinalizationError,
  buildPausedCompletionResult,
  streamFailurePauseMessage,
  blockedVerificationEvents,
  isModelTurnTimeout,
  modelTurnTimeoutKind,
  hasRecoverableToolEvidence,
} from "./agent-finalization";

import type { RunState } from "./agent-run-state";

export interface AgentModelTurnContext {
  root: string;
  requestId: string;
  request: ModelRequest;
  signal: AbortSignal;
  run: RunState;
  history: HistoryItem[];
  evidenceHistory: HistoryItem[];
  baselineCodingEvidence: ReadonlySet<CodingOperation>;
  browserSessionId: string;
  modelRuntime: ModelTurnRuntime;
  usage: Turn["usage"];
  streamTurn: ModelStreamFn;
  finalizationMode: AgentFinalizationMode | undefined;
  roundStartSnapshot: RoundEvidenceSnapshot;
  requestContainsImages: boolean;
  toolsEnabled: boolean;
  hasUncollectedAgentWork: boolean;
  hasActiveUncollectedAgentWork: boolean;
  collectStoppedSubagents: () => Promise<{
    activities: AgentActivity[];
    usageDelta: Turn["usage"];
  }>;
}

export type AgentModelTurnResult =
  | { action: "continue" }
  | { action: "stop" }
  | {
      action: "ready";
      turn: Turn;
      streamedText: string;
      turnTextStartOffset: number;
      bufferModelText: boolean;
      usedRuntimeFinalizationFallback: boolean;
    };

/** Resolve one model round; the caller owns the outer continue/stop decisions. */
export async function* resolveAgentModelTurn(
  context: AgentModelTurnContext,
): AsyncGenerator<AgentEvent, AgentModelTurnResult> {
  const {
    root,
    requestId,
    request,
    signal,
    run,
    history,
    evidenceHistory,
    baselineCodingEvidence,
    browserSessionId,
    modelRuntime,
    usage,
    streamTurn,
    finalizationMode,
    roundStartSnapshot,
    requestContainsImages,
    toolsEnabled,
    hasUncollectedAgentWork,
    hasActiveUncollectedAgentWork,
    collectStoppedSubagents,
  } = context;
  const {
    plannerExecutionPending,
    planRequirementsPending,
    pendingRequiredPlanStep,
    actionablePlanPending,
    evidenceComplete,
  } = roundStartSnapshot;
  let turn: Turn | undefined,
    streamedText = "",
    streamedReasoning = "";
  const turnTextStartOffset = run.timelineTextLength;
  const resetTurnTextEvent = (
    replacement?: string,
    reason: "stream_retry" | "runtime_verification" = "runtime_verification",
  ): AgentEvent => ({
    type: "text_reset",
    textOffset: turnTextStartOffset,
    replacement,
    reason,
  });
  const bufferModelText =
    browserIsOpen(browserSessionId) ||
    run.requestedBrowserOps.size > 0 ||
    run.requestedGitOps.size > 0 ||
    run.requestedCodingEvidenceOps.size > 0 ||
    listSubagents(requestId).some((agent) => !agent.collected);
  if (
    requestContainsImages &&
    modelRuntime.omitImageInputs &&
    !run.imageFallbackNoticeSent
  ) {
    run.imageFallbackNoticeSent = true;
    yield {
      type: "progress",
      message:
        "当前模型不支持图片输入，已跳过图片附件，继续根据文字和工作区内容处理…",
    };
  }
  let imageRetryAttempted = false;
  let usedRuntimeFinalizationFallback = false;
  const turnAttemptBudget = new ModelAttemptBudget(MODEL_TURN_HTTP_ATTEMPTS);
  for (;;) {
    try {
      for await (const event of streamTurn({
        root,
        requestId,
        request,
        history,
        signal,
        toolsEnabled: finalizationMode ? false : toolsEnabled,
        requireToolCall: finalizationMode
          ? false
          : run.forceToolCall ||
            actionablePlanPending ||
            shouldRequireCodingTool(
              request.modelId,
              run.requestedCodingEvidenceOps,
              codingEvidenceWithBaseline(
                evidenceHistory,
                baselineCodingEvidence,
              ),
              evidenceHistory,
            ),
        runtime: modelRuntime,
        attemptBudget: turnAttemptBudget,
      })) {
        if (event.type === "complete") turn = event.turn;
        else if (event.type === "reasoning") {
          streamedReasoning += event.delta;
          yield { type: "reasoning", delta: event.delta };
        } else if (event.type === "progress")
          yield { type: "progress", message: event.message };
        else if (event.type === "reasoning_reset") {
          streamedReasoning = "";
          yield { type: "reasoning_reset" };
        } else if (event.type === "text_reset") {
          // Upstream broke mid-answer and is being retried. A divergent retry
          // carries its replacement prefix in the reset event so the renderer
          // never observes an empty intermediate answer.
          streamedText = event.replacement ?? "";
          if (!bufferModelText) {
            run.timelineTextLength = turnTextStartOffset + streamedText.length;
            yield resetTurnTextEvent(streamedText, "stream_retry");
          }
        } else {
          streamedText += event.delta;
          if (!bufferModelText) {
            run.timelineTextLength += event.delta.length;
            yield { type: "text", delta: event.delta, phase: "unknown" };
          }
        }
      }
      break;
    } catch (error) {
      if (
        finalizationMode &&
        !signal.aborted &&
        isRecoverableFinalizationError(error)
      ) {
        usedRuntimeFinalizationFallback = true;
        if (streamedText && !bufferModelText) {
          run.timelineTextLength = turnTextStartOffset;
          yield resetTurnTextEvent();
        }
        streamedText = "";
        streamedReasoning = "";
        yield { type: "reasoning_reset" };
        yield {
          type: "progress",
          message:
            "模型未能生成收尾正文，已停止继续请求并根据结构化工具记录生成结论…",
        };
        turn = {
          text: runtimeFinalizationFallback(
            evidenceHistory,
            evidenceComplete,
            run.externalWorkAbandoned,
          ),
          calls: [],
          rawCalls: [],
          usage: { input: 0, output: 0, cached: 0 },
          finishReason: "runtime_finalization",
        };
        break;
      }
      const canRetryWithoutImages =
        requestContainsImages &&
        !imageRetryAttempted &&
        !modelRuntime.omitImageInputs &&
        !turn &&
        !streamedText &&
        !streamedReasoning &&
        isUnsupportedImageInputError(error);
      if (!canRetryWithoutImages) {
        // Retryable gateway/transport failures (including a first-round
        // disconnect with no tool evidence yet) must pause instead of
        // failing the task. Auth and invalid-request errors still throw.
        // Meaningful/reasoning-only timeouts with prior tool progress and
        // unfinished structured work, and transport stream interrupts after
        // tools already succeeded, share an outer auto-continue budget;
        // absolute wall-clock still pauses immediately.
        if (
          !signal.aborted &&
          (isRetryableStreamError(error) || isModelTurnTimeout(error))
        ) {
          const isTimeout = isModelTurnTimeout(error);
          const timeoutKind = isTimeout
            ? modelTurnTimeoutKind(error)
            : ("transport" as const);
          const unfinishedWork =
            actionablePlanPending ||
            !evidenceComplete ||
            plannerExecutionPending ||
            roundStartSnapshot.missingActionCodingOperations.length > 0;
          const timeoutRecovery = streamTimeoutRecovery({
            timeoutKind,
            finalizationMode,
            hasRecoverableToolEvidence:
              hasRecoverableToolEvidence(evidenceHistory),
            unfinishedWork,
            streamTimeoutRecoveries: run.budgets.streamTimeoutRecoveries,
          });
          if (timeoutRecovery.action === "auto-continue") {
            run.budgets.streamTimeoutRecoveries += 1;
            const recoveryCount = run.budgets.streamTimeoutRecoveries;
            yield {
              type: "progress",
              message: isTimeout
                ? `模型本轮持续思考已达单轮安全边界，正在基于已有工具结果自动继续（${recoveryCount}/${STREAM_TIMEOUT_RECOVERY_LIMIT}）…`
                : `上游响应流中断，正在基于已有工具结果自动继续（${recoveryCount}/${STREAM_TIMEOUT_RECOVERY_LIMIT}）…`,
            };
            history.push({
              kind: "message",
              role: "user",
              content: isTimeout
                ? STREAM_TIMEOUT_RECOVERY_CONTENT
                : STREAM_TRANSPORT_RECOVERY_CONTENT,
            });
            // Refresh round snapshots and budgets in the outer run loop.
            return { action: "continue" };
          }
          const pausedCompletionResult = buildPausedCompletionResult({
            evidenceHistory,
            userInputEvidenceStart: run.userInputEvidenceStart,
            baselineCodingEvidence,
            requestedCodingEvidenceOps: run.requestedCodingEvidenceOps,
            requestedBrowserOps: run.requestedBrowserOps,
            requestedGitOps: run.requestedGitOps,
            plannerExecutionPending,
            planRequirementsPending,
            planPending: pendingRequiredPlanStep >= 0,
            planSteps: run.plan.steps,
            planStatuses: run.plan.statuses,
            planRequirements: run.plan.requirements,
            pauseReason: isModelTurnTimeout(error) ? "stream-timeout" : "other",
          });
          const finished = yield* emitAgentTerminalEvents(
            requestId,
            signal,
            run,
            blockedVerificationEvents(
              run.timelineTextLength,
              streamFailurePauseMessage(error),
              pausedCompletionResult,
            ),
          );
          return { action: finished ? "stop" : "continue" };
        }
        throw error;
      }
      imageRetryAttempted = true;
      modelRuntime.omitImageInputs = true;
      if (!run.imageFallbackNoticeSent) {
        run.imageFallbackNoticeSent = true;
        yield {
          type: "progress",
          message:
            "上游模型不接受图片输入，已自动跳过图片附件并用文字上下文重试…",
        };
      }
    }
  }
  if (!turn) throw new Error("模型流结束但没有完成结果");
  if (turn.reasoningContent && !streamedReasoning.trim())
    yield { type: "reasoning", delta: turn.reasoningContent };
  if (!usedRuntimeFinalizationFallback) {
    run.lastPromptTokens = effectiveRuntimePromptTokens(
      history,
      turn.usage.input,
    );
    usage.input += turn.usage.input;
    usage.output += turn.usage.output;
    usage.cached += turn.usage.cached;
    // input/output/cached accumulate across rounds for billing; promptTokens is
    // the latest round's prompt size, i.e. the real current context occupancy.
    yield { type: "usage", ...usage, promptTokens: run.lastPromptTokens };
  }
  if (!turn.text.trim() && !turn.calls.length && finalizationMode) {
    usedRuntimeFinalizationFallback = true;
    if (streamedReasoning.trim() || turn.reasoningContent?.trim()) {
      streamedReasoning = "";
      yield { type: "reasoning_reset" };
    }
    yield {
      type: "progress",
      message:
        "收尾模型没有返回正文，已停止重复请求，正在根据已确认的工具记录生成结论…",
    };
    turn = {
      text: runtimeFinalizationFallback(
        evidenceHistory,
        evidenceComplete,
        run.externalWorkAbandoned,
      ),
      calls: [],
      rawCalls: [],
      usage: { input: 0, output: 0, cached: 0 },
      finishReason: "runtime_finalization",
    };
  }
  if (finalizationMode && turn.calls.length) {
    // Tool definitions are intentionally removed in the finalization turn.
    // A relay can still echo a stale function call, but executing it would
    // reopen the very loop this bounded turn is supposed to close.
    usedRuntimeFinalizationFallback = true;
    if (streamedReasoning.trim() || turn.reasoningContent?.trim()) {
      streamedReasoning = "";
      yield { type: "reasoning_reset" };
    }
    yield {
      type: "progress",
      message:
        "收尾阶段收到额外工具调用，已忽略并根据已确认的工具记录生成结论…",
    };
    turn = {
      text: runtimeFinalizationFallback(
        evidenceHistory,
        evidenceComplete,
        run.externalWorkAbandoned,
      ),
      calls: [],
      rawCalls: [],
      usage: { input: 0, output: 0, cached: 0 },
      finishReason: "runtime_finalization",
    };
  }
  if (!turn.text.trim() && !turn.calls.length) {
    const recovery = emptyTurnRecovery({
      hasText: Boolean(turn.text.trim()),
      hasCalls: Boolean(turn.calls.length),
      hasReasoning: Boolean(turn.reasoningContent?.trim()),
      reasoningOnlyTurns: run.budgets.reasoningOnlyTurns,
      emptyTurns: run.budgets.emptyTurns,
      hasUncollectedAgentWork,
      externalWorkAbandoned: run.externalWorkAbandoned,
      hasRecoverableToolEvidence: hasRecoverableToolEvidence(evidenceHistory),
    });
    if (recovery?.action === "retry-reasoning") {
      const priorRetries = run.budgets.reasoningOnlyTurns;
      run.budgets.reasoningOnlyTurns += 1;
      run.budgets.unproductiveTurns += 1;
      const forceTool = shouldForceToolAfterEmptyRecovery({
        toolsEnabled: Boolean(toolsEnabled && !finalizationMode),
        hasRecoverableToolEvidence: hasRecoverableToolEvidence(evidenceHistory),
        actionablePlanPending,
        hasRequestedCodingOps: run.requestedCodingEvidenceOps.size > 0,
        hasUncollectedAgentWork,
        priorEmptyOrReasoningRetries: priorRetries,
      });
      if (forceTool) run.forceToolCall = true;
      yield {
        type: "progress",
        message: forceTool
          ? "上游本轮只返回内部思考，正在强制下一轮调用工具继续执行…"
          : "上游本轮只返回内部思考，正在要求它结束本轮并输出正文或调用工具…",
      };
      history.push({
        kind: "message",
        role: "user",
        content: forceTool
          ? REASONING_ONLY_FORCE_TOOL_CONTENT
          : REASONING_ONLY_RETRY_CONTENT,
      });
      return { action: "continue" };
    }
    if (recovery?.action === "abandon-subagents") {
      run.externalWorkAbandoned = hasActiveUncollectedAgentWork;
      run.repetitionFinalizationPending = "repetition-stalled";
      yield {
        type: "progress",
        message: hasActiveUncollectedAgentWork
          ? "模型连续只返回内部思考，且子 Agent 没有新进展，已停止未完成的子任务并汇总已有结果…"
          : "模型连续只返回内部思考，已先收集已完成子 Agent 的结果，正在生成结论…",
      };
      const stopped = await collectStoppedSubagents();
      for (const childActivity of stopped.activities)
        yield {
          type: "activity",
          activity: { ...childActivity, requestId, round: run.round },
        };
      if (
        stopped.usageDelta.input ||
        stopped.usageDelta.output ||
        stopped.usageDelta.cached
      ) {
        usage.input += stopped.usageDelta.input;
        usage.output += stopped.usageDelta.output;
        usage.cached += stopped.usageDelta.cached;
        yield { type: "usage", ...usage, promptTokens: run.lastPromptTokens };
      }
      run.lastSubagentProgress = subagentProgressToken(requestId);
      return { action: "continue" };
    }
    if (
      recovery?.action === "pause-reasoning" ||
      recovery?.action === "pause-empty"
    ) {
      const pausedCompletionResult = buildPausedCompletionResult({
        evidenceHistory,
        userInputEvidenceStart: run.userInputEvidenceStart,
        baselineCodingEvidence,
        requestedCodingEvidenceOps: run.requestedCodingEvidenceOps,
        requestedBrowserOps: run.requestedBrowserOps,
        requestedGitOps: run.requestedGitOps,
        plannerExecutionPending,
        planRequirementsPending,
        planPending: pendingRequiredPlanStep >= 0,
        planSteps: run.plan.steps,
        planStatuses: run.plan.statuses,
        planRequirements: run.plan.requirements,
        pauseReason: "empty-turn",
      });
      const finished = yield* emitAgentTerminalEvents(
        requestId,
        signal,
        run,
        blockedVerificationEvents(
          run.timelineTextLength,
          recovery.action === "pause-empty"
            ? "模型连续返回空响应，已安全暂停；已有工具结果和实际文件修改均已保留。点击“继续”后会从当前状态恢复。"
            : "模型连续只返回内部思考，已安全暂停；已有工具结果和实际文件修改均已保留。点击“继续”后会从当前状态恢复。",
          pausedCompletionResult,
        ),
      );
      return { action: finished ? "stop" : "continue" };
    }
    if (recovery?.action === "error-reasoning") {
      const finished = yield* emitAgentTerminalEvents(requestId, signal, run, [
        {
          type: "error",
          message:
            "模型连续只返回内部思考，已停止继续请求。请重试或切换模型通道。",
        },
      ]);
      return { action: finished ? "stop" : "continue" };
    }
    if (recovery?.action === "retry-empty") {
      const priorRetries = run.budgets.emptyTurns;
      run.budgets.emptyTurns += 1;
      run.budgets.unproductiveTurns += 1;
      const forceTool = shouldForceToolAfterEmptyRecovery({
        toolsEnabled: Boolean(toolsEnabled && !finalizationMode),
        hasRecoverableToolEvidence: hasRecoverableToolEvidence(evidenceHistory),
        actionablePlanPending,
        hasRequestedCodingOps: run.requestedCodingEvidenceOps.size > 0,
        hasUncollectedAgentWork,
        priorEmptyOrReasoningRetries: priorRetries,
      });
      if (forceTool) run.forceToolCall = true;
      yield {
        type: "progress",
        message: forceTool
          ? `上游返回空响应，正在强制调用工具继续（第 ${run.budgets.emptyTurns} 次）…`
          : `上游返回空响应，正在自动恢复（第 ${run.budgets.emptyTurns} 次尝试）…`,
      };
      history.push({
        kind: "message",
        role: "user",
        content: forceTool
          ? EMPTY_TURN_FORCE_TOOL_CONTENT
          : EMPTY_TURN_RETRY_CONTENT,
      });
      return { action: "continue" };
    }
    const finished = yield* emitAgentTerminalEvents(requestId, signal, run, [
      {
        type: "error",
        message:
          "模型连续返回空响应，KCode 无法确认任务已完成。请重试或更换模型通道。",
      },
    ]);
    return { action: finished ? "stop" : "continue" };
  }
  run.budgets.emptyTurns = 0;
  run.budgets.reasoningOnlyTurns = 0;
  return {
    action: "ready",
    turn,
    streamedText,
    turnTextStartOffset,
    bufferModelText,
    usedRuntimeFinalizationFallback,
  };
}

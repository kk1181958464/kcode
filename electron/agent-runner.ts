import { initializeAgentRun } from "./agent-run-setup";
import { resolveAgentModelTurn } from "./agent-model-turn";
import { executeAgentToolTurn } from "./agent-tool-turn";
import { emitAgentTerminalEvents } from "./agent-terminal";
import { randomUUID } from "node:crypto";
import {
  type AgentActivity,
  type AgentEvent,
  type ModelRequest,
} from "../src/types";
import {
  dedupeExecutionNarrative,
  executionNarrativePreview,
  nextExecutionNarrative,
} from "../src/execution-narrative";
import {
  successfulGitEvidence,
  unavailableGitOperations,
} from "./git-operation-verification";
import {
  hasRequestedUserInputEvidence,
  hasVerifiedNoChangeReport,
  structuredToolEvidenceSummary,
  successfulToolNames,
} from "./coding-operation-verification";
import { successfulBrowserEvidence } from "./browser-operation-verification";
import { buildAgentCompletionResult } from "./agent-completion";
import { effectiveRuntimePromptTokens } from "./runtime-context-budget";
import { agentHooks } from "./agent-hooks";
import { turnSteeringQueue } from "./turn-steering";
import {
  collectFinishedSubagentResults,
  drainSubagentMessages,
  listSubagents,
  stopSubagentsForParent,
  subagentProgressToken,
} from "./subagents";
import {
  agentFinalizationMode,
  EXTERNAL_WAIT_MAX_DURATION_MS,
  EXTERNAL_WAIT_STALL_ROUNDS,
  externalWaitLimitReached,
  type AgentFinalizationMode,
} from "./agent-run-budget";
import { resetRunStateAfterSteering } from "./agent-run-state";
import {
  applyRoundStallCounters,
  applyRunCompletionNotices,
  autoContinueProgressMessage,
  autoContinueVerificationContent,
  buildRoundEvidenceSnapshot,
  classifyToolRoundProgress,
  completionOperationKeys,
  finalizationHistoryContent,
  finalizationProgressMessage,
  nextExternalWaitStall,
  noToolAutoContinue,
  planRecoveryContent,
  REPETITION_RECOVERY_CONTENT,
  roundStallDecision,
  runDoneOutcome,
  stallFinalizeProgressMessage,
} from "./agent-round-policy";
import type { RunAgentDeps } from "./agent-types";
import { compactRuntimeHistoryWithModel } from "./runtime-compaction";
import { decideRuntimeCompaction } from "./runtime-compaction-policy";
import { defaultStreamTurn } from "./model-stream-runner";
import { pendingUserInputMessage } from "./agent-input";
import { subagentActivityHistory } from "./agent-evidence";
import {
  codingEvidenceWithBaseline,
  MAX_PLAN_RECOVERY_NUDGES,
} from "./agent-finalization";

export async function* runAgent(
  requestId: string,
  request: ModelRequest,
  signal: AbortSignal,
  deps: RunAgentDeps = {},
): AsyncGenerator<AgentEvent> {
  turnSteeringQueue.open(requestId);
  try {
    yield* runAgentSession(requestId, request, signal, deps);
  } finally {
    turnSteeringQueue.clear(requestId);
  }
}

async function* runAgentSession(
  requestId: string,
  request: ModelRequest,
  signal: AbortSignal,
  deps: RunAgentDeps,
): AsyncGenerator<AgentEvent> {
  const streamTurn = deps.streamTurn ?? defaultStreamTurn;
  const runStartedAt = Date.now();
  const {
    root,
    browserSessionId,
    baselineCodingEvidence,
    recoveredBrowserEvidence,
    recoveredGitEvidence,
    history,
    run,
    evidenceHistory,
    turnDiffTracker,
    fileReadCache,
    stopHooks,
    conversationWriter,
    toolStats,
    activeConnectionFacts,
    plannerCoordinator,
    runtimeSkillInstructions,
    modelRuntime,
    refreshRuntimeWorkspaceBinding,
    runtimeContextSummarizer,
    requestContainsImages,
    usage,
  } = await initializeAgentRun(requestId, request, signal, deps);
  const toolsEnabled = true;
  const browserEvidenceWithRecovery = () => {
    const evidence = successfulBrowserEvidence(evidenceHistory);
    for (const operation of recoveredBrowserEvidence) evidence.add(operation);
    return evidence;
  };
  const gitEvidenceWithRecovery = () => {
    const evidence = successfulGitEvidence(evidenceHistory);
    for (const operation of recoveredGitEvidence) evidence.add(operation);
    return evidence;
  };
  const collectStoppedSubagents = async () => {
    await stopSubagentsForParent(requestId, false);
    const results = collectFinishedSubagentResults(requestId);
    const transcripts = results
      .filter((result) => result.transcript.trim())
      .map((result) => ({
        name: result.name,
        status: result.status,
        transcript: result.transcript.slice(-2_000),
      }));
    if (transcripts.length)
      history.push({
        kind: "message",
        role: "user",
        content: `<subagent_partial_results>${JSON.stringify(transcripts)}</subagent_partial_results>`,
      });
    const activities = results.flatMap((result) => result.activityRecords);
    for (const activity of activities)
      evidenceHistory.push(...subagentActivityHistory(activity));
    const usageDelta = results.reduce(
      (total, result) => ({
        input: total.input + result.usageDelta.input,
        output: total.output + result.usageDelta.output,
        cached: total.cached + result.usageDelta.cached,
      }),
      { input: 0, output: 0, cached: 0 },
    );
    return { activities, usageDelta };
  };
  while (!signal.aborted) {
    const pendingParentInstructions = drainSubagentMessages(requestId);
    const pendingSteering = turnSteeringQueue.drain(requestId);
    if (pendingSteering.length) {
      // Steering is a new user turn inside the same running request. Append it
      // before computing completion requirements so the old goal cannot keep
      // forcing operations (for example an earlier upload) after the user has
      // switched to an informational question.
      for (const message of pendingSteering)
        history.push({
          kind: "message",
          role: "user",
          content: `<user_steer>${message}</user_steer>`,
        });
      resetRunStateAfterSteering(
        run,
        subagentProgressToken(requestId),
        evidenceHistory.length,
      );
      modelRuntime.activeSkills = runtimeSkillInstructions();
    }
    const codingEvidenceAtRoundStart = codingEvidenceWithBaseline(
      evidenceHistory,
      baselineCodingEvidence,
    );
    const browserEvidenceAtRoundStart = browserEvidenceWithRecovery();
    const gitEvidenceAtRoundStart = gitEvidenceWithRecovery();
    const unavailableGitAtRoundStart =
      unavailableGitOperations(evidenceHistory);
    const successfulToolsAtRoundStart = successfulToolNames(evidenceHistory);
    const currentSubagents = listSubagents(requestId);
    const hasUncollectedAgentWork = currentSubagents.some(
      (agent) => !agent.collected,
    );
    const hasActiveUncollectedAgentWork = currentSubagents.some(
      (agent) =>
        !agent.collected &&
        (agent.status === "running" || agent.status === "stopping"),
    );
    const roundStartSnapshot = buildRoundEvidenceSnapshot({
      plannerCoordinator,
      plan: run.plan,
      requestedCodingEvidenceOps: run.requestedCodingEvidenceOps,
      requestedBrowserOps: run.requestedBrowserOps,
      requestedGitOps: run.requestedGitOps,
      codingEvidence: codingEvidenceAtRoundStart,
      browserEvidence: browserEvidenceAtRoundStart,
      gitEvidence: gitEvidenceAtRoundStart,
      unavailableGit: unavailableGitAtRoundStart,
      successfulTools: successfulToolsAtRoundStart,
      evidenceHistory,
      hasUncollectedAgentWork,
    });
    const plannerExecutionPending = roundStartSnapshot.plannerExecutionPending;
    const planRequirementsPending = roundStartSnapshot.planRequirementsPending;
    const actionablePlanPending = roundStartSnapshot.actionablePlanPending;
    const evidenceComplete = roundStartSnapshot.evidenceComplete;
    const finalizationBlockedByAgents =
      !run.externalWorkAbandoned && hasUncollectedAgentWork;
    const hasPendingInstructions =
      pendingParentInstructions.length > 0 || pendingSteering.length > 0;
    const finalizationMode: AgentFinalizationMode | undefined =
      run.repetitionFinalizationPending &&
      !hasPendingInstructions &&
      !finalizationBlockedByAgents
        ? run.repetitionFinalizationPending
        : agentFinalizationMode({
            agentRole: request.agentRole,
            agentDepth: request.agentDepth,
            completedRounds: run.round,
            elapsedMs: Date.now() - runStartedAt,
            evidenceComplete,
            hasPendingInstructions:
              hasPendingInstructions || finalizationBlockedByAgents,
          });
    const currentPromptTokens = effectiveRuntimePromptTokens(
      history,
      run.lastPromptTokens,
    );
    run.round += 1;
    yield {
      type: "progress",
      message:
        finalizationProgressMessage(finalizationMode, request.agentRole) ??
        nextExecutionNarrative(run.prevRound.activity, run.prevRound.failure),
    };
    const runtimeCompactionDecision = decideRuntimeCompaction({
      contextWindow: request.contextWindow,
      promptTokens: currentPromptTokens,
      lastCompactionTokens: run.lastRuntimeCompactionTokens,
    });
    const runtimeCompactionForced = runtimeCompactionDecision.forced;
    const shouldCompactRuntime = runtimeCompactionDecision.shouldCompact;
    if (shouldCompactRuntime) {
      const before = history.length;
      const compactionWindowId = `${requestId}:context:${run.round}`;
      yield {
        type: "context_compaction",
        phase: "started",
        windowId: compactionWindowId,
        beforeItems: before,
        promptTokens: currentPromptTokens,
        strategy: runtimeContextSummarizer ? "model" : "fallback",
      };
      await agentHooks.run(
        "BeforeCompact",
        {
          requestId,
          taskId: request.taskId,
          payload: { historyItems: before, promptTokens: currentPromptTokens },
        },
        signal,
      );
      const compactionResult = await compactRuntimeHistoryWithModel(history, {
        requestId,
        request,
        provider: modelRuntime.provider,
        evidenceHistory,
        force: runtimeCompactionForced,
        activeConnections: activeConnectionFacts.values(),
        preserveImageMessageId: request.currentMessageId,
        pendingOperations: completionOperationKeys({
          requestedCodingEvidenceOps: run.requestedCodingEvidenceOps,
          requestedBrowserOps: run.requestedBrowserOps,
          requestedGitOps: run.requestedGitOps,
          codingEvidence: codingEvidenceAtRoundStart,
          browserEvidence: browserEvidenceAtRoundStart,
          gitEvidence: gitEvidenceAtRoundStart,
          spawnedExecutor: successfulToolsAtRoundStart.has("spawn_agent"),
          snapshot: roundStartSnapshot,
        }).missingOperations,
        plan: run.plan.steps.length
          ? {
              steps: run.plan.steps,
              statuses: run.plan.statuses,
              cursor: run.plan.cursor,
            }
          : undefined,
        signal,
        summarize: runtimeContextSummarizer,
      });
      const compactedPromptTokens = effectiveRuntimePromptTokens(history, 0);
      yield {
        type: "context_compaction",
        phase: "completed",
        windowId: compactionWindowId,
        beforeItems: before,
        afterItems: history.length,
        promptTokens: compactedPromptTokens,
        changed: compactionResult.changed,
        strategy: compactionResult.strategy,
        modelId: compactionResult.modelId,
      };
      if (compactionResult.usage) {
        usage.input += compactionResult.usage.input;
        usage.output += compactionResult.usage.output;
        yield {
          type: "usage",
          ...usage,
          promptTokens: compactedPromptTokens,
        };
      }
      run.lastRuntimeCompactionTokens = compactedPromptTokens;
      if (compactionResult.changed) {
        const modelCompacted = compactionResult.strategy === "model";
        const activity: AgentActivity = {
          id: randomUUID(),
          requestId,
          tool: "read_many_files",
          status: "success",
          title: modelCompacted ? "模型整理上下文" : "整理运行上下文",
          startedAt: Date.now(),
          completedAt: Date.now(),
          input: {},
          textOffset: run.timelineTextLength,
          narrative: modelCompacted
            ? "上下文接近预算，已让模型整理较早的对话和工具结果，并保留结构化执行证据后继续执行。"
            : "模型整理不可用，已使用安全兜底整理较早的运行记录，并保留结构化执行证据后继续执行。",
          output: modelCompacted
            ? `已由模型${compactionResult.modelId ? `（${compactionResult.modelId}）` : ""}生成交接摘要，并将 ${before} 条运行记录整理为 ${history.length} 条，Agent 将继续执行\n\n交接摘要：\n${compactionResult.summary?.slice(0, 12_000) ?? ""}`
            : `模型整理未成功（${(compactionResult.error ?? "未知原因").slice(0, 180)}），已将 ${before} 条运行记录安全整理为 ${history.length} 条，Agent 将继续执行`,
          round: run.round,
          progress: "advanced",
        };
        if (modelCompacted && compactionResult.summary)
          conversationWriter.systemInjection(
            "context_compaction",
            compactionResult.summary,
            40_000,
          );
        conversationWriter.compact(
          modelCompacted ? "model" : "fallback",
          Math.max(0, currentPromptTokens - compactedPromptTokens),
          compactedPromptTokens,
        );
        await agentHooks.run(
          "AfterCompact",
          {
            requestId,
            taskId: request.taskId,
            payload: {
              beforeItems: before,
              afterItems: history.length,
              promptTokens: currentPromptTokens,
              strategy: compactionResult.strategy,
            },
          },
          signal,
        );
        yield { type: "activity", activity };
        run.lastPromptTokens = 0;
      }
    }
    for (const message of pendingParentInstructions)
      history.push({
        kind: "message",
        role: "user",
        content: `<parent_instruction>${message}</parent_instruction>`,
      });
    if (finalizationMode)
      history.push({
        kind: "message",
        role: "user",
        content: finalizationHistoryContent(
          finalizationMode,
          request.agentRole,
          run.externalWorkAbandoned,
        ),
      });
    const modelTurn = yield* resolveAgentModelTurn({
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
    });
    if (modelTurn.action === "continue") continue;
    if (modelTurn.action === "stop") return;
    const {
      turn,
      streamedText,
      turnTextStartOffset,
      bufferModelText,
      usedRuntimeFinalizationFallback,
    } = modelTurn;
    const requestedUserInput = hasRequestedUserInputEvidence(
      evidenceHistory.slice(run.userInputEvidenceStart),
    );
    const browserEvidence = browserEvidenceWithRecovery();
    const gitEvidence = gitEvidenceWithRecovery();
    const codingEvidence = codingEvidenceWithBaseline(
      evidenceHistory,
      baselineCodingEvidence,
    );
    const completionKeys = completionOperationKeys({
      requestedCodingEvidenceOps: run.requestedCodingEvidenceOps,
      requestedBrowserOps: run.requestedBrowserOps,
      requestedGitOps: run.requestedGitOps,
      codingEvidence,
      browserEvidence,
      gitEvidence,
      spawnedExecutor: successfulToolsAtRoundStart.has("spawn_agent"),
      snapshot: roundStartSnapshot,
    });
    const requestedOperationKeys = completionKeys.requestedOperations;
    const observedOperationKeys = completionKeys.observedOperations;
    const missingOperationKeys = completionKeys.missingOperations;
    const waitingForUser = requestedUserInput;
    const completionResult = applyRunCompletionNotices(
      buildAgentCompletionResult({
        requestedOperations: requestedOperationKeys,
        observedOperations: observedOperationKeys,
        missingOperations: missingOperationKeys,
        evidence: structuredToolEvidenceSummary(evidenceHistory),
        waitingForUser,
        verifiedNoChange: hasVerifiedNoChangeReport(evidenceHistory),
      }),
      {
        usedRuntimeFinalizationFallback,
        evidenceComplete,
        externalWorkAbandoned: run.externalWorkAbandoned,
      },
    );
    if (!turn.calls.length) {
      const lateInstructions = drainSubagentMessages(requestId);
      const uncollectedAgents = finalizationBlockedByAgents
        ? listSubagents(requestId).filter((agent) => !agent.collected)
        : [];
      if (
        lateInstructions.length ||
        uncollectedAgents.length ||
        turnSteeringQueue.size(requestId)
      ) {
        if (turn.text)
          history.push({
            kind: "message",
            role: "assistant",
            content: turn.text,
            reasoningContent: turn.reasoningContent,
          });
        for (const message of lateInstructions)
          history.push({
            kind: "message",
            role: "user",
            content: `<parent_instruction>${message}</parent_instruction>`,
          });
        if (uncollectedAgents.length)
          history.push({
            kind: "message",
            role: "user",
            content: `<runtime_verification>仍有 ${uncollectedAgents.length} 个子 Agent 尚未收集结果。请调用 wait_agent 等待并汇总，或调用 stop_agent 停止后收集；不要在此之前结束任务。</runtime_verification>`,
          });
        continue;
      }
    }
    const roundNarrative = turn.calls.length
      ? executionNarrativePreview(
          dedupeExecutionNarrative(turn.text, run.prevRound.toolNarrative),
        )
      : "";
    if (turn.calls.length && roundNarrative)
      run.prevRound.toolNarrative = turn.text;
    const autoContinue = noToolAutoContinue({
      hasCalls: Boolean(turn.calls.length),
      finishReason: turn.finishReason,
      plannerCoordinator,
      finalizationMode,
      plannerExecutionPending,
      requestedUserInput,
      actionablePlanPending,
      autoContinues: run.budgets.autoContinues,
    });
    const {
      truncated,
      collaborationPlanPending,
      executionPlanPending,
      willAutoContinue,
    } = autoContinue;
    const stopHookResult =
      !finalizationMode && !turn.calls.length && !willAutoContinue
        ? stopHooks.evaluate({
            requestedOperations: requestedOperationKeys,
            observedOperations: observedOperationKeys,
            missingOperations: missingOperationKeys,
            retryCount: run.budgets.completionRetries,
            waitingForUser,
          })
        : { action: "allow" as const };
    if (stopHookResult.action === "continue") {
      run.budgets.completionRetries += 1;
      run.budgets.unproductiveTurns += 1;
      if (stopHookResult.forceToolCall !== false) run.forceToolCall = true;
      if (turn.text)
        history.push({
          kind: "message",
          role: "assistant",
          content: turn.text,
          reasoningContent: turn.reasoningContent,
        });
      history.push({
        kind: "message",
        role: "user",
        content: stopHookResult.inject,
      });
      continue;
    }
    if (!turn.calls.length && !willAutoContinue)
      yield {
        type: "final_response",
        textOffset: turnTextStartOffset,
        startedAt: Date.now(),
        phase: "final_answer",
      };
    if (turn.text) {
      history.push({
        kind: "message",
        role: "assistant",
        content: turn.text,
        reasoningContent: turn.reasoningContent,
      });
      // Coding runs buffer model text until the turn shape is known. Once the
      // turn contains tools, the text is a progress update and belongs in the
      // visible timeline before those activities. The final no-tool turn is
      // still the verified conclusion.
      if (turn.calls.length && bufferModelText && roundNarrative) {
        run.timelineTextLength += roundNarrative.length;
        yield { type: "text", delta: roundNarrative, phase: "commentary" };
      } else if (
        !turn.calls.length &&
        !willAutoContinue &&
        (bufferModelText || !streamedText)
      ) {
        run.timelineTextLength += turn.text.length;
        yield { type: "text", delta: turn.text, phase: "final_answer" };
      }
    }
    if (!turn.calls.length) {
      // A no-tool round normally finishes the turn. Only protocol-level
      // truncation and an unfinished structured collaboration plan trigger a
      // bounded continuation; assistant wording never does.
      if (willAutoContinue) {
        run.budgets.autoContinues += 1;
        yield {
          type: "progress",
          message: autoContinueProgressMessage({
            truncated,
            collaborationPlanPending,
            executionPlanPending,
            planRequirementsPending,
          }),
        };
        history.push({
          kind: "message",
          role: "user",
          content: autoContinueVerificationContent({
            truncated,
            collaborationPlanPending,
            planRequirementsPending,
            missingActionCodingOperations:
              roundStartSnapshot.missingActionCodingOperations,
          }),
        });
        continue;
      }
      const finished = yield* emitAgentTerminalEvents(requestId, signal, run, [
        {
          type: "done",
          outcome: runDoneOutcome({
            waitingForUser,
            finalizationMode,
            completionKind: completionResult.kind,
          }),
          result: completionResult,
        },
      ]);
      if (!finished) continue;
      return;
    }
    const toolTurn = yield* executeAgentToolTurn(
      {
        root,
        requestId,
        request,
        signal,
        run,
        history,
        evidenceHistory,
        baselineCodingEvidence,
        recoveredBrowserEvidence,
        recoveredGitEvidence,
        browserSessionId,
        plannerCoordinator,
        fileReadCache,
        turnDiffTracker,
        toolStats,
        conversationWriter,
        activeConnectionFacts,
        usage,
        refreshRuntimeWorkspaceBinding,
        runChildAgent: runAgent,
      },
      turn,
      roundNarrative,
    );
    const {
      roundFingerprints,
      roundAdvanced,
      roundOperationalProgress,
      roundWaitingOnExternalWork,
      roundPlanChanged,
      roundFailedActivity,
      pendingUserInput,
    } = toolTurn;
    let { roundExternalProgress } = toolTurn;
    const nextSubagentProgress = subagentProgressToken(requestId);
    roundExternalProgress ||= nextSubagentProgress !== run.lastSubagentProgress;
    run.lastSubagentProgress = nextSubagentProgress;
    const activeUncollectedSubagents = listSubagents(requestId).filter(
      (agent) =>
        !agent.collected &&
        (agent.status === "running" || agent.status === "stopping"),
    );
    const nextWait = nextExternalWaitStall({
      hasActiveUncollected: activeUncollectedSubagents.length > 0,
      progressed:
        roundAdvanced || roundOperationalProgress || roundExternalProgress,
      stalledRounds: run.externalWaitStallRounds,
      startedAt: run.externalWaitStartedAt,
    });
    run.externalWaitStallRounds = nextWait.stalledRounds;
    run.externalWaitStartedAt = nextWait.startedAt;
    if (
      activeUncollectedSubagents.length > 0 &&
      !run.externalWorkAbandoned &&
      !pendingUserInput &&
      externalWaitLimitReached({
        stalledRounds: run.externalWaitStallRounds,
        startedAt: run.externalWaitStartedAt,
      })
    ) {
      run.externalWorkAbandoned = true;
      run.repetitionFinalizationPending = "repetition-stalled";
      yield {
        type: "progress",
        message: `子 Agent 连续 ${EXTERNAL_WAIT_STALL_ROUNDS} 个等待周期（最长 ${Math.round(EXTERNAL_WAIT_MAX_DURATION_MS / 60_000)} 分钟）没有新进展，已停止未完成的子任务，正在汇总已收到的结果…`,
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
      continue;
    }
    const roundFingerprint = roundFingerprints.join("|");
    const codingEvidenceAfterRound = codingEvidenceWithBaseline(
      evidenceHistory,
      baselineCodingEvidence,
    );
    const browserEvidenceAfterRound = browserEvidenceWithRecovery();
    const gitEvidenceAfterRound = gitEvidenceWithRecovery();
    const unavailableGitAfterRound = unavailableGitOperations(evidenceHistory);
    const afterRoundSnapshot = buildRoundEvidenceSnapshot({
      plannerCoordinator,
      plan: run.plan,
      requestedCodingEvidenceOps: run.requestedCodingEvidenceOps,
      requestedBrowserOps: run.requestedBrowserOps,
      requestedGitOps: run.requestedGitOps,
      codingEvidence: codingEvidenceAfterRound,
      browserEvidence: browserEvidenceAfterRound,
      gitEvidence: gitEvidenceAfterRound,
      unavailableGit: unavailableGitAfterRound,
      successfulTools: successfulToolNames(evidenceHistory),
      evidenceHistory,
      hasUncollectedAgentWork: listSubagents(requestId).some(
        (agent) => !agent.collected,
      ),
    });
    if (pendingUserInput) {
      const afterRoundKeys = completionOperationKeys({
        requestedCodingEvidenceOps: run.requestedCodingEvidenceOps,
        requestedBrowserOps: run.requestedBrowserOps,
        requestedGitOps: run.requestedGitOps,
        codingEvidence: codingEvidenceAfterRound,
        browserEvidence: browserEvidenceAfterRound,
        gitEvidence: gitEvidenceAfterRound,
        spawnedExecutor:
          successfulToolNames(evidenceHistory).has("spawn_agent"),
        snapshot: afterRoundSnapshot,
      });
      const completionResult = buildAgentCompletionResult({
        requestedOperations: afterRoundKeys.requestedOperations,
        observedOperations: afterRoundKeys.observedOperations,
        missingOperations: afterRoundKeys.missingOperations,
        evidence: structuredToolEvidenceSummary(evidenceHistory),
        waitingForUser: true,
        verifiedNoChange: hasVerifiedNoChangeReport(evidenceHistory),
      });
      const finalMessage = pendingUserInputMessage(pendingUserInput);
      const finished = yield* emitAgentTerminalEvents(requestId, signal, run, [
        {
          type: "final_response",
          textOffset: run.timelineTextLength,
          startedAt: Date.now(),
          phase: "final_answer",
        },
        { type: "text", delta: finalMessage, phase: "final_answer" },
        {
          type: "done",
          outcome: "blocked",
          result: {
            ...completionResult,
            notice: "已停止自动执行。补充上述信息后，可从当前结果继续。",
          },
        },
      ]);
      if (!finished) continue;
      return;
    }
    const roundProgress = classifyToolRoundProgress({
      calls: turn.calls,
      roundAdvanced,
      roundOperationalProgress,
      roundExternalProgress,
      roundWaitingOnExternalWork,
      roundPlanChanged,
      roundFailed: Boolean(roundFailedActivity),
      roundFingerprint,
      noProgressFingerprints: run.noProgressFingerprints,
      planCompleted: afterRoundSnapshot.planCompleted,
      planStatusesCompleted: afterRoundSnapshot.planStatusesCompleted,
      evidenceComplete: afterRoundSnapshot.evidenceComplete,
      hasMutationEvidence: afterRoundSnapshot.hasMutationEvidence,
    });
    applyRoundStallCounters(run, roundProgress, {
      roundAdvanced,
      roundExternalProgress,
      roundWaitingOnExternalWork,
      roundPlanChanged,
      roundFingerprint,
    });
    if (signal.aborted) {
      yield* emitAgentTerminalEvents(requestId, signal, run, [
        {
          type: "error",
          message: "任务已停止",
        },
      ]);
      return;
    }
    const stallDecision = roundStallDecision({
      state: run,
      progress: roundProgress,
      snapshot: afterRoundSnapshot,
      plan: run.plan,
      roundFailed: Boolean(roundFailedActivity),
      pendingUserInput: Boolean(pendingUserInput),
      hasUncollectedAgentWork: listSubagents(requestId).some(
        (agent) => !agent.collected,
      ),
    });
    if (stallDecision.action === "finalize-completed-plan") {
      run.repetitionFinalizationPending = "evidence-complete";
      yield {
        type: "progress",
        message: "结构化计划和工具证据均已完成，正在生成最终结论…",
      };
      continue;
    }
    if (stallDecision.action === "plan-recovery") {
      run.budgets.planRecoveryNudges += 1;
      yield {
        type: "progress",
        message: `${stallDecision.pendingStepLabel}仍未取得真实执行结果，正在停止重复检查并要求模型立即执行（第 ${run.budgets.planRecoveryNudges}/${MAX_PLAN_RECOVERY_NUDGES} 次）…`,
      };
      history.push({
        kind: "message",
        role: "user",
        content: planRecoveryContent({
          pendingStepLabel: stallDecision.pendingStepLabel,
          planRequirementsPending: stallDecision.planRequirementsPending,
          missing: stallDecision.missing,
        }),
      });
      continue;
    }
    if (stallDecision.action === "finalize") {
      run.repetitionFinalizationPending = stallDecision.mode;
      yield {
        type: "progress",
        message: stallFinalizeProgressMessage({
          semanticStallReached: stallDecision.semanticStallReached,
          validationStallReached: stallDecision.validationStallReached,
          validationStallRounds: run.validationStallRounds,
          semanticStallRounds: run.semanticStallRounds,
          shouldFinalizeAvailableResult:
            stallDecision.shouldFinalizeAvailableResult,
        }),
      };
      continue;
    }
    if (stallDecision.action === "recover") {
      yield {
        type: "progress",
        message:
          "检测到连续重复操作，正在要求 Agent 保留现有结果并更换执行策略…",
      };
      history.push({
        kind: "message",
        role: "user",
        content: REPETITION_RECOVERY_CONTENT,
      });
      continue;
    }
  }
}

import { randomUUID } from "node:crypto";
import { approvalCache } from "./approval-cache";
import { TurnDiffTracker } from "./turn-diff-tracker";
import { buildTurnSummary, type ToolCallRecord } from "./tool-call-recorder";
import { createDefaultStopHooks } from "./stop-hooks";
import { turnDiffId } from "./synthetic-id";
import { fileHistory } from "./file-history";
import { FileReadCache } from "./file-read-cache";
import { getStaleFileHint } from "./stale-file-hint";
import {
  runHooks,
  collectInjections,
  isBlocked,
  getBlockReason,
} from "./hook-lifecycle";
import { ConversationWriter } from "./conversation-persist";
import { processLargeOutput } from "./output-spill";
import { resetToolStats } from "./tool-stats";
import { stat } from "node:fs/promises";
import path from "node:path";
import {
  type AgentActivity,
  type AgentEvent,
  type ModelRequest,
} from "../src/types";
import {
  imageInputSupport,
  isUnsupportedImageInputError,
} from "../src/model-capabilities";
import {
  activityExecutionNarrative,
  dedupeExecutionNarrative,
  executionNarrativePreview,
  nextExecutionNarrative,
} from "../src/execution-narrative";
import { resolvePermissionDecisionForCategories } from "../src/permissions";
import { isRecoverableGitHubError } from "./github-http";
import {
  buildRuntimeWorkspaceBindingInstruction,
  effectiveLocalWorkspacePath,
} from "./workspace-prompt";
import { isRetryableStreamError } from "./request-guard";
import { effectiveOpenAiProtocol } from "./protocol-fallback";
import {
  gitOperationsRequiredByCalls,
  successfulGitEvidence,
  type GitOperation,
  unavailableGitOperations,
} from "./git-operation-verification";
import {
  codingOperationsRequiredByCalls,
  compactOperationEvidenceResult,
  hasRequestedUserInputEvidence,
  hasVerifiedNoChangeReport,
  latestUserRequestContent,
  shouldRequireCodingTool,
  structuredToolEvidenceSummary,
  successfulToolNames,
  type CodingOperation,
} from "./coding-operation-verification";
import {
  browserOperationsRequiredByCalls,
  successfulBrowserEvidence,
  type BrowserOperation,
} from "./browser-operation-verification";
import { buildAgentCompletionResult } from "./agent-completion";
import { loadActiveSkillInstructions } from "./agent-skills";
import { executeWithProgress } from "./tool-executor";
import { MODEL_TURN_HTTP_ATTEMPTS } from "./model-stream-retry";
import { ModelAttemptBudget } from "./model-attempt-budget";
import { effectiveRuntimePromptTokens } from "./runtime-context-budget";
import { toolRegistry } from "./tool-registry";
import { agentHooks } from "./agent-hooks";
import { turnSteeringQueue } from "./turn-steering";
import { getProviderWithKey } from "./store";
import { bindBrowserRequest, browserIsOpen } from "./browser";
import { sshRemoteState } from "./ssh-remote";
import {
  activityCommandForCall,
  activityFingerprint,
  activityInputForCall,
  activityPathForCall,
  activityTitleForCall,
  approvalCommandForToolCall,
  buildStructuredToolResult,
  contextRemainingResult,
  isWaitingOnExternalProcessOutput,
  mutationSnapshotPaths,
  permissionCategoriesForToolCall,
  pickResultEvidence,
  progressOutputDelta,
  toolActivityCatchFailure,
  toolActivityOutcome,
  verificationLiveStatus,
  type ResultEvidence,
} from "./agent-activity-lifecycle";
import {
  claimSubagentMutation,
  closeSubagentMessageQueue,
  collectFinishedSubagentResults,
  drainSubagentMessages,
  listSubagents,
  stopSubagentsForParent,
  subagentProgressToken,
} from "./subagents";
import { isPlannerCoordinator } from "./collaboration";
import {
  agentFinalizationMode,
  EXTERNAL_WAIT_MAX_DURATION_MS,
  EXTERNAL_WAIT_STALL_ROUNDS,
  SUBAGENT_WAIT_SLICE_MS,
  externalWaitLimitReached,
  type AgentFinalizationMode,
} from "./agent-run-budget";
import {
  applyPlanUpdate,
  createRunState,
  resetRunStateAfterSteering,
} from "./agent-run-state";
import {
  applyRoundStallCounters,
  applyRunCompletionNotices,
  autoContinueProgressMessage,
  autoContinueVerificationContent,
  buildRoundEvidenceSnapshot,
  classifyToolRoundProgress,
  completionOperationKeys,
  EMPTY_TURN_RETRY_CONTENT,
  emptyTurnRecovery,
  finalizationHistoryContent,
  finalizationProgressMessage,
  nextExternalWaitStall,
  noToolAutoContinue,
  planRecoveryContent,
  REASONING_ONLY_RETRY_CONTENT,
  REPETITION_RECOVERY_CONTENT,
  roundStallDecision,
  runDoneOutcome,
  stallFinalizeProgressMessage,
  streamTimeoutRecovery,
  STREAM_TIMEOUT_RECOVERY_LIMIT,
  STREAM_TIMEOUT_RECOVERY_CONTENT,
  STREAM_TRANSPORT_RECOVERY_CONTENT,
} from "./agent-round-policy";
import type {
  PendingUserInput,
  ToolCall,
  ToolResult,
  Turn,
  ModelTurnRuntime,
  RunAgentDeps,
  HistoryItem,
} from "./agent-types";
import {
  compactRuntimeHistoryWithModel,
  defaultRuntimeContextSummarizer,
  hasImageAttachments,
  compactEvidenceCall,
} from "./runtime-compaction";
import { decideRuntimeCompaction } from "./runtime-compaction-policy";
import { defaultStreamTurn } from "./model-stream-runner";
import {
  redactedToolInput,
  normalizePendingUserInput,
  pendingUserInputMessage,
} from "./agent-input";
import {
  subagentActivityHistory,
  updateActiveConnectionFacts,
} from "./agent-evidence";
import {
  codingEvidenceWithBaseline,
  runtimeFinalizationFallback,
  isFinalizationReasoningFailure,
  buildPausedCompletionResult,
  streamFailurePauseMessage,
  blockedVerificationEvents,
  isModelTurnTimeout,
  modelTurnTimeoutKind,
  hasRecoverableToolEvidence,
  toolProducedOperationalProgress,
  MAX_PLAN_RECOVERY_NUDGES,
} from "./agent-finalization";
import { mutationPaths } from "./agent-command";
import { approvals, execute } from "./agent-tool-runtime";

export async function* runAgent(
  requestId: string,
  request: ModelRequest,
  signal: AbortSignal,
  deps: RunAgentDeps = {},
): AsyncGenerator<AgentEvent> {
  const streamTurn = deps.streamTurn ?? defaultStreamTurn;
  const getProvider = deps.getProvider ?? getProviderWithKey;
  const runStartedAt = Date.now();
  const executionRoot = path.resolve(request.workspacePath);
  if (!path.isAbsolute(request.workspacePath))
    throw new Error("工作区路径必须是绝对路径");
  const configuredLocalProjectPath = effectiveLocalWorkspacePath({
    executionRoot,
    localWorkspacePath: request.localWorkspacePath,
    remoteWorkspace: request.remoteWorkspace,
  });
  let localProjectPath: string | undefined;
  if (configuredLocalProjectPath) {
    if (request.remoteWorkspace && !path.isAbsolute(configuredLocalProjectPath))
      throw new Error("本地项目路径必须是绝对路径");
    const candidate = path.resolve(configuredLocalProjectPath);
    const localRootInfo = await stat(candidate).catch(() => undefined);
    if (!localRootInfo?.isDirectory())
      throw new Error(
        request.remoteWorkspace && request.localWorkspacePath
          ? `关联的本地项目目录不可用：${candidate}。请重新关联本地项目；SSH 远程目录仍可通过 ssh_* 工具访问。`
          : "工作区路径不是有效文件夹",
      );
    localProjectPath = candidate;
  }
  if (!localProjectPath) {
    const executionRootInfo = await stat(executionRoot).catch(() => undefined);
    if (!executionRootInfo?.isDirectory())
      throw new Error("工作区路径不是有效文件夹");
  }
  // A remote task keeps its app-managed cache in workspacePath, but local
  // tools must operate on the explicitly associated source directory.
  const root = localProjectPath ?? executionRoot;
  const browserSessionId =
    request.connectionSessionId || request.taskId || requestId;
  const baselineCodingEvidence = new Set<CodingOperation>();
  for (const operation of request.recoveryEvidence?.coding ?? [])
    baselineCodingEvidence.add(operation as CodingOperation);
  const recoveredBrowserEvidence = new Set<BrowserOperation>(
    request.recoveryEvidence?.browser ?? [],
  );
  const recoveredGitEvidence = new Set<GitOperation>(
    request.recoveryEvidence?.git ?? [],
  );
  let connectedRemoteWorkspace: ModelRequest["remoteWorkspace"];
  if (request.remoteWorkspace && request.connectionSessionId) {
    try {
      const remoteState = await sshRemoteState(
        browserSessionId,
        request.remoteWorkspace.id,
      );
      // A managed SSH workspace is connected before the model turn starts.
      // Treat that runtime fact as connection evidence so a redundant or
      // failed reconnect call cannot invalidate otherwise verified work.
      if (remoteState.connected) {
        baselineCodingEvidence.add("connect");
        connectedRemoteWorkspace =
          remoteState.profile ?? request.remoteWorkspace;
      }
    } catch {
      // The normal SSH tools will report the concrete connection failure.
    }
  } else if (!request.remoteWorkspace) {
    const remoteState = await sshRemoteState(browserSessionId).catch(
      () => undefined,
    );
    if (remoteState?.connected && remoteState.profile) {
      baselineCodingEvidence.add("connect");
      connectedRemoteWorkspace = remoteState.profile;
    }
  }
  bindBrowserRequest(browserSessionId, requestId);
  if (
    Buffer.byteLength(JSON.stringify(request.messages), "utf8") >
    24 * 1024 * 1024
  )
    throw new Error("对话、上下文与图片总大小超过 24 MB");
  const lastUserMessageIndex = request.messages.reduce(
    (latest, message, index) => (message.role === "user" ? index : latest),
    -1,
  );
  const history: HistoryItem[] = request.messages.map((m, index) => ({
    kind: "message",
    ...m,
    ...(request.currentMessageId && index === lastUserMessageIndex
      ? { id: request.currentMessageId }
      : {}),
  }));
  const run = createRunState({
    recoveryPlan: request.recoveryPlan,
    lastSubagentProgress: subagentProgressToken(requestId),
  });
  // Keep a compact, request-local proof ledger outside the model context.
  // Runtime history may be compacted during long tasks, but completion proof
  // must survive until the request actually finishes.
  const evidenceHistory: HistoryItem[] = [];
  const turnDiffTracker = new TurnDiffTracker(root);
  const fileReadCache = new FileReadCache();
  const stopHooks = createDefaultStopHooks();
  // Initialize conversation persistence (append-only JSONL)
  const conversationWriter = new ConversationWriter(
    requestId,
    root,
    request.modelId ?? "unknown",
    request.providerId ?? "unknown",
    request.taskId,
  );
  conversationWriter.start();
  // Fire SessionStart lifecycle hooks (non-blocking, best effort)
  runHooks("SessionStart", { workspaceRoot: root, requestId }).catch(() => {});
  // Tool stats tracking — reset per session
  const toolStats = resetToolStats();
  const activeConnectionFacts = new Map<string, string>();
  if (connectedRemoteWorkspace)
    activeConnectionFacts.set(
      "ssh",
      `ssh session ${connectedRemoteWorkspace.username}@${connectedRemoteWorkspace.host}:${connectedRemoteWorkspace.port}; remote project root ${connectedRemoteWorkspace.rootPath}; local project root ${localProjectPath ?? "none attached"}`,
    );
  const toolsEnabled = true;
  const latestUserRequest = latestUserRequestContent(history);
  const plannerCoordinator = isPlannerCoordinator(request);
  let activeSkillInstructions =
    await loadActiveSkillInstructions(latestUserRequest);
  const runtimeSkillInstructions = () =>
    [
      activeSkillInstructions,
      "Always answer the latest real user request. Earlier unfinished actions are context only: do not resume them or report their blockers as the current result unless the latest request explicitly says to continue/retry them or asks for their status. A new informational question supersedes an older action goal.",
      browserIsOpen(browserSessionId)
        ? "This task already has a live browser session. Start browser work with browser_snapshot to inspect the current page and obtain fresh element references. Do not ask the user for a URL or click target until browser_snapshot reports that the session is unavailable; the current page is the target unless the user explicitly says otherwise."
        : "",
    ]
      .filter(Boolean)
      .join("\n\n");
  const modelRuntime: ModelTurnRuntime = {
    provider: await getProvider(request.providerId),
    activeSkills: runtimeSkillInstructions(),
    workspaceBinding: connectedRemoteWorkspace
      ? buildRuntimeWorkspaceBindingInstruction(
          localProjectPath,
          connectedRemoteWorkspace,
        )
      : undefined,
  };
  const refreshRuntimeWorkspaceBinding = async (
    call: ToolCall,
    status: AgentActivity["status"],
  ) => {
    if (
      status !== "success" ||
      (call.name !== "ssh_connect" && call.name !== "ssh_set_workspace")
    )
      return;
    const state = await sshRemoteState(browserSessionId).catch(() => undefined);
    if (!state?.connected || !state.profile) return;
    const binding = buildRuntimeWorkspaceBindingInstruction(
      localProjectPath,
      state.profile,
    );
    activeConnectionFacts.set(
      "ssh",
      `${call.name} ${JSON.stringify(redactedToolInput(call))}; remote project root ${state.profile.rootPath}; local project root ${localProjectPath ?? "none attached"}`,
    );
    if (binding === modelRuntime.workspaceBinding) return;
    modelRuntime.workspaceBinding = binding;
    history.push({
      kind: "message",
      role: "user",
      content: binding,
    });
  };
  const runtimeContextSummarizer =
    deps.summarizeRuntimeContext ??
    (!deps.getProvider ? defaultRuntimeContextSummarizer : undefined);
  await agentHooks.run(
    "SessionStart",
    { requestId, taskId: request.taskId },
    signal,
  );
  const requestContainsImages = hasImageAttachments(history);
  const selectedRuntimeModel = modelRuntime.provider.models.find(
    (model) => model.modelId === request.modelId,
  );
  if (
    requestContainsImages &&
    selectedRuntimeModel &&
    imageInputSupport(
      selectedRuntimeModel,
      effectiveOpenAiProtocol(
        modelRuntime.provider.id,
        modelRuntime.provider.protocol,
        request.modelId,
      ),
    ) === "unsupported"
  )
    modelRuntime.omitImageInputs = true;
  const usage = { input: 0, output: 0, cached: 0 };
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
      resetRunStateAfterSteering(run, subagentProgressToken(requestId));
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
    const pendingRequiredPlanStep = roundStartSnapshot.pendingRequiredPlanStep;
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
    const runtimeCompactionGrowth = runtimeCompactionDecision.growth;
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
    let streamTimeoutAutoContinue = false;
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
            : actionablePlanPending ||
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
        if (finalizationMode && isFinalizationReasoningFailure(error)) {
          usedRuntimeFinalizationFallback = true;
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
              // Break the image-retry loop and continue the outer run loop so
              // round snapshots/budgets refresh like emptyTurnRecovery.
              streamTimeoutAutoContinue = true;
              break;
            }
            const pausedCompletionResult = buildPausedCompletionResult({
              evidenceHistory,
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
              pauseReason: isModelTurnTimeout(error)
                ? "stream-timeout"
                : "other",
            });
            for (const pausedEvent of blockedVerificationEvents(
              run.timelineTextLength,
              streamFailurePauseMessage(error),
              pausedCompletionResult,
            ))
              yield pausedEvent;
            return;
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
    if (streamTimeoutAutoContinue) continue;
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
        run.budgets.reasoningOnlyTurns += 1;
        yield {
          type: "progress",
          message:
            "上游本轮只返回内部思考，正在要求它结束本轮并输出正文或调用工具（仅自动重试一次）…",
        };
        history.push({
          kind: "message",
          role: "user",
          content: REASONING_ONLY_RETRY_CONTENT,
        });
        continue;
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
        continue;
      }
      if (
        recovery?.action === "pause-reasoning" ||
        recovery?.action === "pause-empty"
      ) {
        const pausedCompletionResult = buildPausedCompletionResult({
          evidenceHistory,
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
        for (const pausedEvent of blockedVerificationEvents(
          run.timelineTextLength,
          recovery.action === "pause-empty"
            ? "模型连续返回空响应，已安全暂停；已有工具结果和实际文件修改均已保留。点击“继续”后会从当前状态恢复。"
            : "模型连续只返回内部思考，已安全暂停；已有工具结果和实际文件修改均已保留。点击“继续”后会从当前状态恢复。",
          pausedCompletionResult,
        ))
          yield pausedEvent;
        return;
      }
      if (recovery?.action === "error-reasoning") {
        yield {
          type: "error",
          message:
            "模型连续只返回内部思考，已停止继续请求。请重试或切换模型通道。",
        };
        return;
      }
      if (recovery?.action === "retry-empty") {
        run.budgets.emptyTurns += 1;
        yield {
          type: "progress",
          message: `上游返回空响应，正在自动恢复（第 ${run.budgets.emptyTurns} 次尝试）…`,
        };
        history.push({
          kind: "message",
          role: "user",
          content: EMPTY_TURN_RETRY_CONTENT,
        });
        continue;
      }
      yield {
        type: "error",
        message:
          "模型连续返回空响应，KCode 无法确认任务已完成。请重试或更换模型通道。",
      };
      return;
    }
    run.budgets.emptyTurns = 0;
    run.budgets.reasoningOnlyTurns = 0;
    const requestedUserInput = hasRequestedUserInputEvidence(evidenceHistory);
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
      if (lateInstructions.length || uncollectedAgents.length) {
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
    let planSteps = run.plan.steps.length ? run.plan.steps : undefined;
    let planStep = planSteps
      ? Math.min(run.plan.cursor, planSteps.length - 1)
      : undefined;
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
    const { truncated, collaborationPlanPending, executionPlanPending, willAutoContinue } =
      autoContinue;
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
      closeSubagentMessageQueue(requestId);
      yield {
        type: "done",
        outcome: runDoneOutcome({
          waitingForUser,
          finalizationMode,
          completionKind: completionResult.kind,
        }),
        result: completionResult,
      };
      return;
    }
    // A productive round refreshes the auto-continue budget.
    run.budgets.autoContinues = 0;
    history.push({ kind: "calls", calls: turn.calls, rawCalls: turn.rawCalls });
    for (const operation of codingOperationsRequiredByCalls(turn.calls)) {
      run.requestedCodingEvidenceOps.add(operation);
      // A new attempt must be proven by this request. Keep a recovered
      // connection fact, but do not let an old mutation/command/transfer
      // satisfy a newly attempted operation that later fails.
      if (operation !== "connect") baselineCodingEvidence.delete(operation);
    }
    for (const operation of browserOperationsRequiredByCalls(turn.calls)) {
      run.requestedBrowserOps.add(operation);
      if (operation === "open") {
        recoveredBrowserEvidence.delete("open");
        recoveredBrowserEvidence.delete("verify");
      } else if (operation === "type" || operation === "click") {
        recoveredBrowserEvidence.delete(operation);
        recoveredBrowserEvidence.delete("verify");
      }
    }
    for (const operation of gitOperationsRequiredByCalls(turn.calls)) {
      run.requestedGitOps.add(operation);
      recoveredGitEvidence.delete(operation);
    }
    evidenceHistory.push({
      kind: "calls",
      calls: turn.calls.map(compactEvidenceCall),
      rawCalls: [],
    });
    const roundFingerprints: string[] = [];
    const turnRecords: ToolCallRecord[] = [];
    // One wait_agent may auto-continue across progress slices up to the
    // external-wait ceiling; keep the shared per-turn budget aligned with that.
    const roundWaitDeadline = Date.now() + EXTERNAL_WAIT_MAX_DURATION_MS;
    let roundAdvanced = false;
    let roundOperationalProgress = false;
    let roundWaitingOnExternalWork = false;
    let roundExternalProgress = false;
    let roundPlanChanged = false;
    let roundLastActivity: AgentActivity | undefined;
    let roundFailedActivity: AgentActivity | undefined;
    let pendingUserInput: PendingUserInput | undefined;
    for (const call of turn.calls) {
      const activityOptions = {
        plannerCoordinator,
        executorDisplayName: request.collaboration?.executor.displayName,
      };
      const activity: AgentActivity = {
        id: randomUUID(),
        requestId,
        tool: call.name,
        status: "running",
        title: activityTitleForCall(call, activityOptions),
        startedAt: Date.now(),
        input: activityInputForCall(call, activityOptions),
        agentRole: request.agentRole,
        providerId: request.providerId,
        modelId: request.modelId,
        reasoningEffort: request.reasoningEffort,
        textOffset: run.timelineTextLength,
        narrative: roundNarrative || undefined,
        planSteps,
        planStatuses: run.plan.statuses,
        planRequirements: run.plan.requirements,
        planStep: planStep,
        path: activityPathForCall(call),
        command: activityCommandForCall(call),
        round: run.round,
      };
      activity.narrative ||= activityExecutionNarrative(activity);
      const toolTrace = toolRegistry.start({
        requestId,
        activityId: activity.id,
        tool: call.name,
        args: activity.input,
        startedAt: activity.startedAt,
      });
      activity.toolCallId = toolTrace.callId;
      await agentHooks.run(
        "BeforeTool",
        {
          requestId,
          taskId: request.taskId,
          tool: call.name,
          activityId: activity.id,
          payload: activity.input,
        },
        signal,
      );
      const { decision, category } = resolvePermissionDecisionForCategories(
        request.permissionMode,
        request.permissionPolicy,
        permissionCategoriesForToolCall(call),
      );
      activity.permissionCategory = category;
      if (decision === "deny") {
        activity.status = "denied";
        activity.completedAt = Date.now();
        activity.output =
          request.permissionMode === "read-only"
            ? "只读模式已阻止此操作"
            : "当前权限策略已阻止此操作";
        toolRegistry.finish(toolTrace.callId, "denied");
        yield { type: "activity", activity };
        roundLastActivity = activity;
        roundFailedActivity = activity;
        history.push({
          kind: "result",
          callId: call.id,
          content: activity.output,
        });
        continue;
      }
      if (decision === "confirm") {
        // Check approval cache before prompting user
        const approvalCommand = approvalCommandForToolCall(call);
        const cachedDecision = approvalCommand
          ? approvalCache.check(
              approvalCommand,
              category ?? "runCommands",
              root,
            )
          : "prompt";
        if (cachedDecision === "allow") {
          // Auto-approved by cache — skip dialog
          activity.status = "running";
          toolRegistry.markRunning(toolTrace.callId);
          yield { type: "activity", activity };
        } else {
          activity.status = "waiting";
          toolRegistry.markWaiting(toolTrace.callId);
          yield { type: "activity", activity };
          const approvalKey = `${requestId}:${activity.id}`;
          const allowed = await new Promise<boolean>((resolve) => {
            approvals.set(approvalKey, resolve);
            signal.addEventListener("abort", () => resolve(false), {
              once: true,
            });
          });
          approvals.delete(approvalKey);
          if (!allowed) {
            activity.status = "denied";
            activity.completedAt = Date.now();
            activity.output = "用户拒绝了此操作";
            toolRegistry.finish(toolTrace.callId, "denied");
            yield { type: "activity", activity };
            roundLastActivity = activity;
            roundFailedActivity = activity;
            history.push({
              kind: "result",
              callId: call.id,
              content: activity.output,
            });
            continue;
          }
          activity.status = "running";
          toolRegistry.markRunning(toolTrace.callId);
          yield { type: "activity", activity };
        }
      } else yield { type: "activity", activity };
      let finishMutationClaim: ((committed: boolean) => void) | undefined;
      let resultEvidence: ResultEvidence = {};
      try {
        // Start tool timing for stats
        toolStats.startCall(call.id);
        // Run PreToolUse lifecycle hooks — may block tool execution
        const preToolResults = await runHooks("PreToolUse", {
          workspaceRoot: root,
          toolName: call.name,
          toolInput: call.input as Record<string, unknown>,
          requestId,
        });
        if (isBlocked(preToolResults)) {
          const reason = getBlockReason(preToolResults) || "被项目 Hook 阻止";
          activity.status = "denied";
          activity.completedAt = Date.now();
          activity.output = reason;
          toolRegistry.finish(toolTrace.callId, "denied");
          yield { type: "activity", activity };
          roundLastActivity = activity;
          roundFailedActivity = activity;
          history.push({
            kind: "result",
            callId: call.id,
            content: reason,
          });
          continue;
        }
        finishMutationClaim = claimSubagentMutation(
          requestId,
          root,
          mutationPaths(call),
        );
        turnDiffTracker.beforeTool(
          call.name,
          call.id,
          call.input as Record<string, unknown>,
        );
        // Snapshot files before mutation for undo support
        for (const snapshotPath of mutationSnapshotPaths(call)) {
          const abs = path.isAbsolute(snapshotPath)
            ? snapshotPath
            : path.join(root, snapshotPath);
          fileHistory(root, requestId).snapshot(abs);
        }
        // Lightweight admin tool: get_context_remaining — no external execution needed
        if (call.name === "get_context_remaining") {
          const { output: resultOutput } = contextRemainingResult(
            request.contextWindow ?? 128_000,
            effectiveRuntimePromptTokens(history, run.lastPromptTokens),
          );
          finishMutationClaim?.(true);
          turnDiffTracker.afterTool(
            call.name,
            call.id,
            call.input as Record<string, unknown>,
          );
          Object.assign(activity, {
            status: "success",
            completedAt: Date.now(),
            output: resultOutput,
          });
          toolRegistry.finish(toolTrace.callId, "success");
          history.push({
            kind: "result",
            callId: call.id,
            content: JSON.stringify({
              success: true,
              summary: resultOutput,
              data: {},
            }),
          });
          evidenceHistory.push({
            kind: "result",
            callId: call.id,
            content: JSON.stringify({
              success: true,
              summary: resultOutput,
              data: {},
            }),
          });
          yield { type: "activity", activity };
          roundLastActivity = activity;
          continue;
        }
        const execution = executeWithProgress((report) =>
          execute(
            root,
            requestId,
            browserSessionId,
            activity.id,
            call,
            request,
            signal,
            fileReadCache,
            runAgent,
            report,
            call.name === "wait_agent"
              ? Math.max(1, roundWaitDeadline - Date.now())
              : undefined,
          ),
        );
        let result: ToolResult;
        let lastProgressOutput = "";
        while (true) {
          const step = await execution.next();
          if (step.done) {
            result = step.value;
            break;
          }
          const nextOutput = step.value;
          toolRegistry.progress(toolTrace.callId, nextOutput);
          const liveStatus = verificationLiveStatus(nextOutput);
          if (liveStatus && !activity.liveStatus) {
            activity.liveStatus = liveStatus;
            yield { type: "activity", activity: { ...activity } };
          }
          const delta = progressOutputDelta(lastProgressOutput, nextOutput);
          if (delta) {
            yield {
              type: "activity_output",
              activityId: activity.id,
              mode: delta.mode,
              value: delta.value,
            };
            lastProgressOutput = nextOutput;
          }
          activity.output = nextOutput;
        }
        finishMutationClaim?.(true);
        turnDiffTracker.afterTool(
          call.name,
          call.id,
          call.input as Record<string, unknown>,
        );
        const childActivities = result.childActivities;
        const subagentUsage = result.subagentUsage;
        const subagentWait = result.subagentWait;
        const planUpdate = result.planUpdate;
        const {
          childActivities: _children,
          subagentUsage: _subagentUsage,
          subagentWait: _subagentWait,
          planUpdate: _planUpdate,
          ...activityResult
        } = result;
        if (planUpdate) {
          const applied = applyPlanUpdate(run, planUpdate);
          planSteps = applied.planSteps;
          planStep = applied.planStep;
          activity.planSteps = planSteps;
          activity.planStatuses = run.plan.statuses;
          activity.planRequirements = run.plan.requirements;
          activity.planStep = planStep;
          roundPlanChanged ||= applied.planChanged;
        }
        resultEvidence = pickResultEvidence(result);
        if (subagentWait) {
          roundExternalProgress ||= subagentWait.progressed;
        }
        const outcome = toolActivityOutcome(call, result, signal.aborted);
        Object.assign(activity, activityResult, {
          status: outcome.status,
          completedAt: Date.now(),
          errorSummary: outcome.errorSummary,
          liveStatus: undefined,
        });
        if (
          call.name === "request_user_input" &&
          activity.status === "success" &&
          result.userInputRequested === true
        )
          pendingUserInput = normalizePendingUserInput(call.input);
        toolRegistry.finish(
          toolTrace.callId,
          activity.status === "failed" ? "failed" : "success",
        );
        // Record tool execution for turn summary injection
        turnRecords.push({
          toolName: call.name,
          callId: call.id,
          primaryArg: String(
            (call.input as Record<string, unknown>).file_path ??
              (call.input as Record<string, unknown>).path ??
              (call.input as Record<string, unknown>).command ??
              (call.input as Record<string, unknown>).query ??
              "",
          ),
          success: activity.status === "success",
          exitCode: result.exitCode,
          error:
            activity.status === "failed" ? activity.errorSummary : undefined,
        });
        // Record tool stats
        toolStats.finishCall(
          call.id,
          call.name,
          activity.status === "success",
          {
            filePath:
              ((call.input as Record<string, unknown>).file_path as
                string | undefined) ??
              ((call.input as Record<string, unknown>).path as
                string | undefined),
            additions: activity.additions,
            deletions: activity.deletions,
          },
        );
        await agentHooks.run(
          "AfterTool",
          {
            requestId,
            taskId: request.taskId,
            tool: call.name,
            activityId: activity.id,
            payload: {
              status: activity.status,
              changed: resultEvidence.changed,
              executed: resultEvidence.executed,
            },
          },
          signal,
        );
        // Run PostToolUse lifecycle hooks
        const postToolResults = await runHooks("PostToolUse", {
          workspaceRoot: root,
          toolName: call.name,
          toolInput: call.input as Record<string, unknown>,
          toolResult: {
            success: activity.status === "success",
            output: activity.output,
          },
          requestId,
        });
        const postToolInjection = collectInjections(postToolResults);
        if (postToolInjection) {
          history.push({
            kind: "result",
            callId: call.id + "_hook",
            content: postToolInjection,
          });
        }
        for (const childActivity of childActivities ?? [])
          yield {
            type: "activity",
            activity: {
              ...childActivity,
              requestId,
              round: run.round,
            },
          };
        if (subagentUsage) {
          usage.input += subagentUsage.input;
          usage.output += subagentUsage.output;
          usage.cached += subagentUsage.cached;
          // Subagent tokens count toward billing only; they do not sit in the
          // parent's context, so promptTokens stays at the parent's last round.
          yield { type: "usage", ...usage, promptTokens: run.lastPromptTokens };
        }
      } catch (error) {
        finishMutationClaim?.(false);
        const failure = toolActivityCatchFailure(
          call,
          error,
          activity.output,
          signal.aborted,
        );
        activity.status = "failed";
        activity.recoverable = isRecoverableGitHubError(error) || undefined;
        activity.completedAt = Date.now();
        activity.output = failure.output;
        activity.errorSummary = failure.errorSummary;
        activity.liveStatus = undefined;
        toolRegistry.fail(toolTrace.callId, failure.failureOutput, failure.cancelled);
        await agentHooks.run(
          "AfterTool",
          {
            requestId,
            taskId: request.taskId,
            tool: call.name,
            activityId: activity.id,
            payload: { status: activity.status, error: failure.failureOutput },
          },
          signal,
        );
      }
      roundFingerprints.push(activityFingerprint(call, activity));
      roundWaitingOnExternalWork ||= isWaitingOnExternalProcessOutput(
        call,
        activity,
      );
      const advanced =
        resultEvidence.changed === true ||
        Boolean(activity.diff) ||
        Boolean(activity.additions) ||
        Boolean(activity.deletions);
      roundAdvanced ||= advanced;
      const operationalProgress = toolProducedOperationalProgress(
        call,
        activity,
        resultEvidence,
      );
      roundOperationalProgress ||= operationalProgress;
      activity.progress = operationalProgress ? "advanced" : "unchanged";
      yield { type: "activity", activity };
      roundLastActivity = activity;
      if (activity.status === "failed" || activity.status === "denied")
        roundFailedActivity = activity;
      // Spill large output to disk to preserve context tokens
      const spillResult = activity.output
        ? processLargeOutput(activity.output, {
            command: activity.command,
            toolName: call.name,
            callId: call.id,
            requestId,
          })
        : {
            spilled: false as const,
            summary: activity.output ?? "",
            originalSize: 0,
            lineCount: 0,
          };
      const effectiveOutput = spillResult.summary;
      const structured = buildStructuredToolResult({
        activity,
        resultEvidence,
        effectiveOutput,
      });
      updateActiveConnectionFacts(
        activeConnectionFacts,
        call,
        structured.success,
      );
      history.push({
        kind: "result",
        callId: call.id,
        content: JSON.stringify(structured),
      });
      await refreshRuntimeWorkspaceBinding(call, activity.status);
      evidenceHistory.push(
        compactOperationEvidenceResult(
          call.id,
          call.name,
          structured.success,
          structured.data,
        ),
      );
      // After command execution, detect files that became stale
      if (
        (call.name === "run_command" || call.name === "start_process") &&
        activity.status === "success"
      ) {
        const staleHint = getStaleFileHint(fileReadCache);
        if (staleHint) {
          history.push({
            kind: "result",
            callId: call.id,
            content: staleHint,
          });
        }
      }
    }
    // Finalize turn diff tracking — provides ground truth of file changes
    const turnDiff = turnDiffTracker.finalizeTurn();
    if (turnDiff.hasChanges) {
      roundAdvanced = true;
      evidenceHistory.push({
        kind: "result",
        callId: turnDiffId(run.round),
        content: JSON.stringify({
          success: true,
          summary: `Turn实际文件变更: ${turnDiff.changedFiles.join(", ")}`,
          data: { turnDiff: true, files: turnDiff.changedFiles.length },
        }),
      });
    }
    // Inject tool execution record into context for next round
    const turnSummary = buildTurnSummary(run.round, turnRecords, turnDiff);
    if (turnSummary) {
      history.push({
        kind: "message",
        role: "user",
        content: `<tool_execution_record>\n${turnSummary}\n</tool_execution_record>`,
      });
    }
    // Persist round events to JSONL
    for (const call of turn.calls) {
      conversationWriter.toolCall(call.id, call.name, redactedToolInput(call));
    }
    for (const rec of turnRecords) {
      conversationWriter.toolResult(
        rec.callId,
        rec.toolName,
        rec.success,
        rec.exitCode != null ? `exit ${rec.exitCode}` : undefined,
      );
    }
    run.prevRound.activity = roundLastActivity;
    run.prevRound.failure = roundFailedActivity;
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
        spawnedExecutor: successfulToolNames(evidenceHistory).has("spawn_agent"),
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
      closeSubagentMessageQueue(requestId);
      yield {
        type: "final_response",
        textOffset: run.timelineTextLength,
        startedAt: Date.now(),
        phase: "final_answer",
      };
      run.timelineTextLength += finalMessage.length;
      yield { type: "text", delta: finalMessage, phase: "final_answer" };
      yield {
        type: "done",
        outcome: "blocked",
        result: {
          ...completionResult,
          notice: "已停止自动执行。补充上述信息后，可从当前结果继续。",
        },
      };
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
      yield {
        type: "error",
        message: "任务已停止",
      };
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
  turnSteeringQueue.clear(requestId);
}

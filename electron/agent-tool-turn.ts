import { randomUUID } from "node:crypto";
import { approvalCache } from "./approval-cache";
import type { TurnDiffTracker } from "./turn-diff-tracker";
import { buildTurnSummary, type ToolCallRecord } from "./tool-call-recorder";
import { turnDiffId } from "./synthetic-id";
import { fileHistory } from "./file-history";
import type { FileReadCache } from "./file-read-cache";
import { getStaleFileHint } from "./stale-file-hint";
import {
  runHooks,
  collectInjections,
  isBlocked,
  getBlockReason,
} from "./hook-lifecycle";
import type { ConversationWriter } from "./conversation-persist";
import { processLargeOutput } from "./output-spill";
import path from "node:path";
import {
  type AgentActivity,
  type AgentEvent,
  type ModelRequest,
} from "../src/types";
import { activityExecutionNarrative } from "../src/execution-narrative";
import { resolvePermissionDecisionForCategories } from "../src/permissions";
import { isRecoverableGitHubError } from "./github-http";
import {
  gitOperationsRequiredByCalls,
  type GitOperation,
} from "./git-operation-verification";
import {
  codingOperationsRequiredByCalls,
  compactOperationEvidenceResult,
  clearFailedBaselineCodingEvidence,
  successfulCodingEvidence,
  type CodingOperation,
} from "./coding-operation-verification";
import {
  browserOperationsRequiredByCalls,
  type BrowserOperation,
} from "./browser-operation-verification";
import { executeWithProgress } from "./tool-executor";
import { effectiveRuntimePromptTokens } from "./runtime-context-budget";
import { toolRegistry } from "./tool-registry";
import { agentHooks } from "./agent-hooks";
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
import { claimSubagentMutation } from "./subagents";
import {
  isPlanConfirmGatedTool,
  isPlanConfirmMode,
  planRequiresUserGoAhead,
} from "./collaboration";
import { EXTERNAL_WAIT_MAX_DURATION_MS } from "./agent-run-budget";
import { applyPlanUpdate, type RunState } from "./agent-run-state";
import type {
  PendingUserInput,
  ToolCall,
  ToolResult,
  Turn,
  HistoryItem,
  AgentRunner,
} from "./agent-types";
import { compactEvidenceCall } from "./runtime-compaction";
import { redactedToolInput, normalizePendingUserInput } from "./agent-input";
import { updateActiveConnectionFacts } from "./agent-evidence";
import { toolProducedOperationalProgress } from "./agent-finalization";
import { mutationPaths } from "./agent-command";
import { execute } from "./agent-tool-runtime";
import { waitForAgentApproval } from "./agent-approval";

import type { ToolStatsTracker } from "./tool-stats";

/** Request-owned state and services; never import the parent runner here. */
export interface AgentToolTurnContext {
  root: string;
  requestId: string;
  request: ModelRequest;
  signal: AbortSignal;
  run: RunState;
  history: HistoryItem[];
  evidenceHistory: HistoryItem[];
  baselineCodingEvidence: Set<CodingOperation>;
  recoveredBrowserEvidence: Set<BrowserOperation>;
  recoveredGitEvidence: Set<GitOperation>;
  browserSessionId: string;
  plannerCoordinator: boolean;
  fileReadCache: FileReadCache;
  turnDiffTracker: TurnDiffTracker;
  toolStats: Pick<ToolStatsTracker, "startCall" | "finishCall">;
  conversationWriter: Pick<ConversationWriter, "toolCall" | "toolResult">;
  activeConnectionFacts: Map<string, string>;
  usage: Turn["usage"];
  refreshRuntimeWorkspaceBinding: (
    call: ToolCall,
    status: AgentActivity["status"],
  ) => Promise<void>;
  runChildAgent: AgentRunner;
}

export interface AgentToolTurnResult {
  roundFingerprints: string[];
  roundAdvanced: boolean;
  roundOperationalProgress: boolean;
  roundWaitingOnExternalWork: boolean;
  roundExternalProgress: boolean;
  roundPlanChanged: boolean;
  roundFailedActivity: AgentActivity | undefined;
  pendingUserInput: PendingUserInput | undefined;
}

/** Execute one batch, forwarding activity events before returning its evidence. */
export async function* executeAgentToolTurn(
  context: AgentToolTurnContext,
  turn: Turn,
  roundNarrative: string,
): AsyncGenerator<AgentEvent, AgentToolTurnResult> {
  const {
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
    runChildAgent,
  } = context;
  let planSteps = run.plan.steps.length ? run.plan.steps : undefined;
  let planStep = planSteps
    ? Math.min(run.plan.cursor, planSteps.length - 1)
    : undefined;
  // A productive round refreshes the auto-continue budget and clears the
  // empty/evidence force-tool latch — the model did issue calls this turn.
  run.budgets.autoContinues = 0;
  run.budgets.emptyTurns = 0;
  run.budgets.reasoningOnlyTurns = 0;
  run.budgets.unproductiveTurns = 0;
  run.budgets.completionRetries = 0;
  run.forceToolCall = false;
  history.push({ kind: "calls", calls: turn.calls, rawCalls: turn.rawCalls });
  for (const operation of codingOperationsRequiredByCalls(turn.calls)) {
    run.requestedCodingEvidenceOps.add(operation);
    // Recovered evidence is NOT invalidated here. A new attempt must be
    // proven by this request, but that can only be judged once the round's
    // tool results exist — see the deferred invalidation after turnRecords
    // below. Dropping it at call-registration time erased a previous run's
    // proven work whenever the round produced no result at all (permission
    // denial, abort, or a mid-round stream failure), so genuinely completed
    // work was reported as never done.
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
    if (signal.aborted) break;
    const activityOptions = {
      plannerCoordinator,
      executorDisplayName:
        request.collaboration?.mode === "planner-executor"
          ? request.collaboration.executor.displayName
          : undefined,
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
    if (
      isPlanConfirmMode(request) &&
      !run.planConfirmed &&
      isPlanConfirmGatedTool(call.name)
    ) {
      activity.status = "denied";
      activity.completedAt = Date.now();
      activity.output = planRequiresUserGoAhead(run.plan.requirements)
        ? "计划确认模式：请先等待用户确认执行计划"
        : "计划确认模式：变更前请先调用 update_plan 提交简短计划并等待用户确认";
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
        ? approvalCache.check(approvalCommand, category ?? "runCommands", root)
        : "prompt";
      if (cachedDecision === "allow") {
        // Auto-approved by cache — skip dialog
        activity.status = "running";
        toolRegistry.markRunning(toolTrace.callId);
        yield { type: "activity", activity };
      } else {
        activity.status = "waiting";
        toolRegistry.markWaiting(toolTrace.callId);
        const allowed = yield* waitForAgentApproval(requestId, activity, signal);
        if (!allowed) {
          activity.status = "denied";
          activity.completedAt = Date.now();
          activity.output = signal.aborted ? "操作已取消" : "用户拒绝了此操作";
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
        signal,
      });
      if (signal.aborted) throw new Error("任务已取消");
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
      await turnDiffTracker.beforeTool(
        call.name,
        call.id,
        call.input as Record<string, unknown>,
      );
      // Snapshot files before mutation for undo support
      for (const snapshotPath of mutationSnapshotPaths(call)) {
        const abs = path.isAbsolute(snapshotPath)
          ? snapshotPath
          : path.join(root, snapshotPath);
        await fileHistory(root, requestId).snapshot(abs);
      }
      // Lightweight admin tool: get_context_remaining — no external execution needed
      if (call.name === "get_context_remaining") {
        const { output: resultOutput } = contextRemainingResult(
          request.contextWindow ?? 128_000,
          effectiveRuntimePromptTokens(history, run.lastPromptTokens),
        );
        finishMutationClaim?.(true);
        await turnDiffTracker.afterTool(
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
          runChildAgent,
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
      await turnDiffTracker.afterTool(
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
        planUpdate &&
        outcome.status === "success" &&
        isPlanConfirmMode(request) &&
        !run.planConfirmed &&
        planRequiresUserGoAhead(run.plan.requirements) &&
        !signal.aborted
      ) {
        activity.status = "waiting";
        activity.completedAt = undefined;
        activity.liveStatus = "plan-confirm";
        activity.title = "待确认执行计划";
        toolRegistry.markWaiting(toolTrace.callId);
        const allowed = yield* waitForAgentApproval(requestId, activity, signal);
        if (allowed) {
          run.planConfirmed = true;
          activity.status = "success";
          activity.completedAt = Date.now();
          activity.liveStatus = undefined;
          activity.output = activity.output
            ? `${activity.output}；用户已确认计划，可以开始执行`
            : "用户已确认计划，可以开始执行";
        } else if (signal.aborted) {
          activity.status = "denied";
          activity.completedAt = Date.now();
          activity.liveStatus = undefined;
          activity.output = "计划确认已取消";
        } else {
          activity.status = "success";
          activity.completedAt = Date.now();
          activity.liveStatus = undefined;
          activity.output =
            "用户要求调整计划。请修订后再次调用 update_plan；在用户确认前不要执行变更。";
        }
        yield { type: "activity", activity };
      }
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
        error: activity.status === "failed" ? activity.errorSummary : undefined,
      });
      // Record tool stats
      toolStats.finishCall(call.id, call.name, activity.status === "success", {
        filePath:
          ((call.input as Record<string, unknown>).file_path as
            string | undefined) ??
          ((call.input as Record<string, unknown>).path as string | undefined),
        additions: activity.additions,
        deletions: activity.deletions,
      });
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
        signal,
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
      toolRegistry.fail(
        toolTrace.callId,
        failure.failureOutput,
        failure.cancelled,
      );
      // Thrown tool failures must still enter turnRecords so deferred
      // baseline invalidation can drop recovered evidence that this round
      // actually attempted and failed (otherwise a bad apply_patch leaves
      // coding:modify "proven" forever and the run reports changed).
      turnRecords.push({
        toolName: call.name,
        callId: call.id,
        primaryArg: String(
          (call.input as Record<string, unknown>).file_path ??
            (call.input as Record<string, unknown>).path ??
            (call.input as Record<string, unknown>).command ??
            (call.input as Record<string, unknown>).query ??
            (call.input as Record<string, unknown>).patch ??
            "",
        ),
        success: false,
        error: activity.errorSummary,
      });
      toolStats.finishCall(call.id, call.name, false, {});
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
      ? await processLargeOutput(activity.output, {
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
      const staleHint = await getStaleFileHint(fileReadCache);
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
  // Deferred baseline invalidation (see the call-registration loop above).
  // Only an operation that this round actually ATTEMPTED AND FAILED, and that
  // nothing in this run has since proven, loses its recovered evidence. A
  // successful or never-executed re-attempt leaves the earlier fact intact,
  // so a failed retry can no longer erase work that really was completed.
  const failedCallIds = new Set(
    turnRecords.filter((rec) => !rec.success).map((rec) => rec.callId),
  );
  if (failedCallIds.size) {
    clearFailedBaselineCodingEvidence(
      baselineCodingEvidence,
      codingOperationsRequiredByCalls(
        turn.calls.filter((call) => failedCallIds.has(call.id)),
      ),
      successfulCodingEvidence(evidenceHistory),
    );
  }
  run.prevRound.activity = roundLastActivity;
  run.prevRound.failure = roundFailedActivity;
  return {
    roundFingerprints,
    roundAdvanced,
    roundOperationalProgress,
    roundWaitingOnExternalWork,
    roundExternalProgress,
    roundPlanChanged,
    roundFailedActivity,
    pendingUserInput,
  };
}

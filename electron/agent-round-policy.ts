import type { AgentCompletionResult, AgentRole } from "../src/types";
import {
  missingRequestedGitOperations,
  type GitOperation,
} from "./git-operation-verification";
import {
  isValidationCommand,
  missingVerifiedCodingOperations,
  type CodingOperation,
} from "./coding-operation-verification";
import {
  missingRequestedBrowserOperations,
  type BrowserOperation,
} from "./browser-operation-verification";
import {
  firstPendingRequiredPlanStep,
  firstPlanStepMissingEvidence,
  hasActionablePlanRequirements,
  MAX_PLAN_RECOVERY_NUDGES,
  planRequirementRecoveryLabel,
} from "./agent-finalization";
import {
  SEMANTIC_STALL_ROUNDS,
  VALIDATION_STALL_ROUNDS,
  stallAction,
  type StallAction,
} from "./agent-stall-policy";
import type { AgentFinalizationMode } from "./agent-run-budget";
import type { RunPlan, RunState } from "./agent-run-state";
import type { HistoryItem, ToolCall } from "./agent-types";

const MUTATION_CODING_OPS = new Set<CodingOperation>([
  "modify",
  "upload",
  "download",
]);

export type RoundEvidenceSnapshot = {
  plannerExecutionPending: boolean;
  planRequirementsPending: boolean;
  pendingRequiredPlanStep: number;
  nextRequiredPlanStep: number;
  missingCodingOperations: CodingOperation[];
  missingActionCodingOperations: CodingOperation[];
  missingBrowserOperations: BrowserOperation[];
  missingGitOperations: GitOperation[];
  missingAvailableGitOperations: GitOperation[];
  actionablePlanPending: boolean;
  evidenceComplete: boolean;
  planCompleted: boolean;
  planStatusesCompleted: boolean;
  hasMutationEvidence: boolean;
};

export type CompletionOperationKeys = {
  requestedOperations: string[];
  observedOperations: string[];
  missingOperations: string[];
};

export type NoToolAutoContinue = {
  truncated: boolean;
  pausedOrIncomplete: boolean;
  collaborationPlanPending: boolean;
  executionPlanPending: boolean;
  willAutoContinue: boolean;
};

export type EmptyTurnRecovery =
  | { action: "retry-reasoning" }
  | { action: "abandon-subagents" }
  | { action: "pause-reasoning" }
  | { action: "error-reasoning" }
  | { action: "retry-empty"; attempt: number }
  | { action: "pause-empty" }
  | { action: "error-empty" };

export type ToolRoundProgress = {
  unchangedPlanMaintenanceRound: boolean;
  verificationOnlyRound: boolean;
  nonProgressRound: boolean;
  validationOnlyRound: boolean;
  repeatedNoProgressRound: boolean;
  distinctOperationalProgress: boolean;
  madeProgress: boolean;
};

export type RoundStallDecision =
  | { action: "continue" }
  | { action: "finalize-completed-plan" }
  | {
      action: "plan-recovery";
      pendingStepLabel: string;
      missing: CodingOperation[];
      planRequirementsPending: boolean;
    }
  | {
      action: "finalize";
      mode: AgentFinalizationMode;
      semanticStallReached: boolean;
      validationStallReached: boolean;
      shouldFinalizeAvailableResult: boolean;
    }
  | { action: "recover" };

export function buildRoundEvidenceSnapshot(input: {
  plannerCoordinator: boolean;
  plan: RunPlan;
  requestedCodingEvidenceOps: ReadonlySet<CodingOperation>;
  requestedBrowserOps: ReadonlySet<BrowserOperation>;
  requestedGitOps: ReadonlySet<GitOperation>;
  codingEvidence: ReadonlySet<CodingOperation>;
  browserEvidence: ReadonlySet<BrowserOperation>;
  gitEvidence: ReadonlySet<GitOperation>;
  unavailableGit: ReadonlySet<GitOperation>;
  successfulTools: ReadonlySet<string>;
  evidenceHistory: HistoryItem[];
  hasUncollectedAgentWork: boolean;
}): RoundEvidenceSnapshot {
  const plannerExecutionPending =
    input.plannerCoordinator &&
    input.plan.steps.length >= 2 &&
    !input.successfulTools.has("spawn_agent");
  const planRequirementsPending =
    input.plan.steps.length > 0 && !input.plan.requirementsDeclared;
  const nextRequiredPlanStep = firstPlanStepMissingEvidence(
    input.plan.steps,
    input.plan.statuses,
    input.plan.requirements,
    input.codingEvidence,
  );
  const pendingRequiredPlanStep = firstPendingRequiredPlanStep(
    input.plan.steps,
    input.plan.statuses,
    input.plan.requirements,
    input.codingEvidence,
  );
  const missingCodingOperations = missingVerifiedCodingOperations(
    input.requestedCodingEvidenceOps,
    input.codingEvidence,
    input.evidenceHistory,
  );
  const missingActionCodingOperations = missingCodingOperations.filter(
    (operation) => operation !== "inspect",
  );
  const missingBrowserOperations = missingRequestedBrowserOperations(
    input.requestedBrowserOps,
    input.browserEvidence,
  );
  const missingGitOperations = missingRequestedGitOperations(
    input.requestedGitOps,
    input.gitEvidence,
  );
  const missingAvailableGitOperations = missingGitOperations.filter(
    (operation) => !input.unavailableGit.has(operation),
  );
  const actionablePlanPending =
    planRequirementsPending ||
    (hasActionablePlanRequirements(input.plan.requirements) &&
      (missingActionCodingOperations.length > 0 ||
        pendingRequiredPlanStep >= 0));
  const evidenceComplete =
    missingCodingOperations.length === 0 &&
    missingBrowserOperations.length === 0 &&
    missingGitOperations.every((operation) =>
      input.unavailableGit.has(operation),
    ) &&
    !plannerExecutionPending &&
    !actionablePlanPending &&
    !input.hasUncollectedAgentWork;
  const planStatusesCompleted = Boolean(
    input.plan.steps.length > 0 &&
    input.plan.statuses?.length === input.plan.steps.length &&
    input.plan.statuses.every((status) => status === "completed"),
  );
  const planCompleted =
    input.plan.steps.length > 0 &&
    input.plan.requirementsDeclared &&
    nextRequiredPlanStep < 0;
  const hasMutationEvidence = [...MUTATION_CODING_OPS].some((operation) =>
    input.codingEvidence.has(operation),
  );
  return {
    plannerExecutionPending,
    planRequirementsPending,
    pendingRequiredPlanStep,
    nextRequiredPlanStep,
    missingCodingOperations,
    missingActionCodingOperations,
    missingBrowserOperations,
    missingGitOperations,
    missingAvailableGitOperations,
    actionablePlanPending,
    evidenceComplete,
    planCompleted,
    planStatusesCompleted,
    hasMutationEvidence,
  };
}

export function completionOperationKeys(input: {
  requestedCodingEvidenceOps: Iterable<CodingOperation>;
  requestedBrowserOps: Iterable<BrowserOperation>;
  requestedGitOps: Iterable<GitOperation>;
  codingEvidence: Iterable<CodingOperation>;
  browserEvidence: Iterable<BrowserOperation>;
  gitEvidence: Iterable<GitOperation>;
  spawnedExecutor: boolean;
  snapshot: Pick<
    RoundEvidenceSnapshot,
    | "plannerExecutionPending"
    | "planRequirementsPending"
    | "pendingRequiredPlanStep"
    | "missingActionCodingOperations"
    | "missingBrowserOperations"
    | "missingAvailableGitOperations"
  >;
}): CompletionOperationKeys {
  const { snapshot } = input;
  return {
    requestedOperations: [
      ...[...input.requestedCodingEvidenceOps].map(
        (operation) => `coding:${operation}`,
      ),
      ...[...input.requestedBrowserOps].map(
        (operation) => `browser:${operation}`,
      ),
      ...[...input.requestedGitOps].map((operation) => `git:${operation}`),
      ...(snapshot.plannerExecutionPending ? ["agent:spawn_executor"] : []),
      ...(snapshot.planRequirementsPending ? ["plan:requirements"] : []),
      ...(snapshot.pendingRequiredPlanStep >= 0 ? ["plan:pending"] : []),
    ],
    observedOperations: [
      ...[...input.codingEvidence].map((operation) => `coding:${operation}`),
      ...[...input.browserEvidence].map((operation) => `browser:${operation}`),
      ...[...input.gitEvidence].map((operation) => `git:${operation}`),
      ...(input.spawnedExecutor ? ["agent:spawn_executor"] : []),
    ],
    missingOperations: [
      ...snapshot.missingActionCodingOperations.map(
        (operation) => `coding:${operation}`,
      ),
      ...snapshot.missingBrowserOperations.map(
        (operation) => `browser:${operation}`,
      ),
      ...snapshot.missingAvailableGitOperations.map(
        (operation) => `git:${operation}`,
      ),
      ...(snapshot.plannerExecutionPending ? ["agent:spawn_executor"] : []),
      ...(snapshot.planRequirementsPending ? ["plan:requirements"] : []),
      ...(snapshot.pendingRequiredPlanStep >= 0 ? ["plan:pending"] : []),
    ],
  };
}

export function applyRunCompletionNotices(
  result: AgentCompletionResult,
  input: {
    usedRuntimeFinalizationFallback: boolean;
    evidenceComplete: boolean;
    externalWorkAbandoned: boolean;
  },
): AgentCompletionResult {
  let next = result;
  if (input.usedRuntimeFinalizationFallback)
    next = {
      ...next,
      kind:
        input.evidenceComplete && !input.externalWorkAbandoned
          ? next.kind
          : "incomplete",
      notice:
        input.evidenceComplete && !input.externalWorkAbandoned
          ? "已根据实际工具记录生成本轮摘要。"
          : "模型没有返回最终正文；已有工具结果和实际文件修改已保留。本轮已暂停，可点击“继续”从当前状态恢复。",
    };
  if (input.externalWorkAbandoned)
    next = {
      ...next,
      kind: "incomplete",
      notice:
        "部分子 Agent 因连续等待没有新进展已停止；已有工具结果和实际文件修改已保留，本轮已暂停，可点击“继续”从当前状态恢复。",
    };
  return next;
}

export function runDoneOutcome(input: {
  waitingForUser: boolean;
  finalizationMode?: AgentFinalizationMode;
  completionKind: AgentCompletionResult["kind"];
}): "blocked" | "paused" | "completed" {
  if (input.waitingForUser) return "blocked";
  if (input.completionKind === "incomplete") return "paused";
  // Hitting the run budget is not itself incompleteness. If the ledger already
  // has the requested evidence, the request finished; only missing operations
  // keep the paused badge.
  return "completed";
}

export function finalizationRoleLabel(role?: AgentRole) {
  return role === "planner"
    ? "规划模型"
    : role === "executor"
      ? "执行模型"
      : "当前任务";
}

export function finalizationProgressMessage(
  mode: AgentFinalizationMode | undefined,
  role?: AgentRole,
) {
  const label = finalizationRoleLabel(role);
  if (mode === "evidence-complete")
    return `${label}已完成主要修改和验证，正在收尾总结…`;
  if (mode === "repetition-stalled")
    return `${label}重复核对未产生新结果，正在基于已有记录收尾…`;
  if (mode === "limit-reached")
    return `${label}已达到运行上限，正在汇总已有结果和未完成项…`;
  return undefined;
}

export function finalizationHistoryContent(
  mode: AgentFinalizationMode,
  role: AgentRole | undefined,
  externalWorkAbandoned: boolean,
) {
  if (mode === "evidence-complete")
    return role === "planner"
      ? "<runtime_finalization>执行模型已返回覆盖本次要求的成功工具证据，规划阶段现在进入收尾。不要再派发新的执行 Agent，也不要重复复核。请依据已收集的执行结果给出简洁最终总结：完成内容、修改文件、验证结果、可用地址和真实残留问题。不得声称未经执行模型证实的事项。</runtime_finalization>"
      : "<runtime_finalization>已有成功工具记录覆盖本次要求，执行预算现在进入收尾阶段。不要再调用工具、不要继续修改，也不要追加重复验证。请仅依据现有工具结果给出简洁最终总结：完成内容、修改文件、验证结果、可用地址和真实残留问题。不得声称未验证的事项。</runtime_finalization>";
  if (mode === "repetition-stalled")
    return `<runtime_finalization reason="repeated_tool_results">同一组工具输入已经连续返回相同结果，运行时现已禁用后续工具调用。${externalWorkAbandoned ? "部分子 Agent 已因连续无进展被停止；不得把未收到的子任务结果说成已完成，必须明确列出已收到的结果和未完成项。" : ""}请立即依据已有结构化工具结果给出简洁结论；明确区分已确认事实、未完成事项和仍无法确认的内容。不得再次承诺复核，不得把未发生的修改或验证说成已完成。</runtime_finalization>`;
  if (role === "planner")
    return "<runtime_finalization>规划模型已达到运行预算上限。不要再派发或等待新的执行 Agent。请根据已收集的执行结果立即汇总：已完成内容、修改文件、成功和失败的验证、可用地址，以及尚未完成或无法确认的事项。必须如实区分完成项与残留项。</runtime_finalization>";
  if (role === "executor")
    return "<runtime_finalization>执行 Agent 已达到运行预算上限。不要再调用工具或继续修改。请根据现有工具结果立即汇总：已完成内容、修改文件、成功和失败的验证、可用地址，以及尚未完成或无法确认的事项。必须如实区分完成项与残留项。</runtime_finalization>";
  return "<runtime_finalization>当前任务已达到运行预算上限。不要再调用工具或继续修改。请根据现有工具结果立即汇总：已完成内容、修改文件、成功和失败的验证、可用地址，以及尚未完成或无法确认的事项。必须如实区分完成项与残留项。</runtime_finalization>";
}

const AUTO_CONTINUE_LIMIT = 1;

/** Continue a no-tool round only for protocol truncation or unfinished structured work. Assistant prose never participates. */
export function noToolAutoContinue(input: {
  hasCalls: boolean;
  finishReason?: string;
  plannerCoordinator: boolean;
  finalizationMode?: AgentFinalizationMode;
  plannerExecutionPending: boolean;
  requestedUserInput: boolean;
  actionablePlanPending: boolean;
  autoContinues: number;
}): NoToolAutoContinue {
  const truncated =
    !input.hasCalls &&
    /^(length|max_tokens|max_output_tokens)$/i.test(input.finishReason ?? "");
  const pausedOrIncomplete =
    !input.hasCalls &&
    /^(pause_turn|incomplete)$/i.test(input.finishReason ?? "");
  const collaborationPlanPending =
    input.plannerCoordinator &&
    !input.finalizationMode &&
    !input.hasCalls &&
    input.plannerExecutionPending;
  const executionPlanPending =
    !input.finalizationMode &&
    !input.requestedUserInput &&
    input.actionablePlanPending;
  return {
    truncated,
    pausedOrIncomplete,
    collaborationPlanPending,
    executionPlanPending,
    willAutoContinue:
      !input.hasCalls &&
      (truncated ||
        pausedOrIncomplete ||
        collaborationPlanPending ||
        executionPlanPending) &&
      input.autoContinues < AUTO_CONTINUE_LIMIT,
  };
}

export function autoContinueProgressMessage(input: {
  truncated: boolean;
  collaborationPlanPending: boolean;
  executionPlanPending: boolean;
  planRequirementsPending: boolean;
}) {
  if (input.truncated)
    return "上游说明被截断且未产生工具调用，正在要求模型直接继续执行…";
  if (input.collaborationPlanPending)
    return "协作规划已生成，正在要求规划模型启动执行模型…";
  if (input.executionPlanPending)
    return `结构化计划尚未取得${input.planRequirementsPending ? "完整要求声明或" : ""}实际执行证据，正在回到待办步骤继续…`;
  return "响应被截断，正在要求模型立即继续执行…";
}

export function autoContinueVerificationContent(input: {
  truncated: boolean;
  collaborationPlanPending: boolean;
  planRequirementsPending: boolean;
  missingActionCodingOperations: readonly CodingOperation[];
}) {
  const reason = input.truncated
    ? "上一轮响应被截断，未收到完整的工具调用。"
    : input.collaborationPlanPending
      ? "协作规划已经生成，但还没有启动执行 Agent。"
      : input.planRequirementsPending
        ? "恢复的结构化计划缺少每一步的 requires 声明。请先调用 update_plan，为每一步补齐 requires；不需要副作用的步骤传空数组，然后从第一个未完成步骤继续。"
        : `结构化计划仍缺少${planRequirementRecoveryLabel(input.missingActionCodingOperations)}。`;
  return `<runtime_verification>${reason}请立即调用相应工具继续执行，不要只输出总结。</runtime_verification>`;
}

export function emptyTurnRecovery(input: {
  hasText: boolean;
  hasCalls: boolean;
  hasReasoning: boolean;
  reasoningOnlyTurns: number;
  emptyTurns: number;
  hasUncollectedAgentWork: boolean;
  externalWorkAbandoned: boolean;
  hasRecoverableToolEvidence: boolean;
}): EmptyTurnRecovery | undefined {
  if (input.hasText || input.hasCalls) return undefined;
  if (input.hasReasoning) {
    if (input.reasoningOnlyTurns < 1) return { action: "retry-reasoning" };
    if (input.hasUncollectedAgentWork && !input.externalWorkAbandoned)
      return { action: "abandon-subagents" };
    if (input.hasRecoverableToolEvidence) return { action: "pause-reasoning" };
    return { action: "error-reasoning" };
  }
  if (input.emptyTurns < 1)
    return { action: "retry-empty", attempt: input.emptyTurns + 1 };
  if (input.hasUncollectedAgentWork && !input.externalWorkAbandoned)
    return { action: "abandon-subagents" };
  if (input.hasRecoverableToolEvidence) return { action: "pause-empty" };
  return { action: "error-empty" };
}

export const REASONING_ONLY_RETRY_CONTENT =
  "<runtime_verification>上一轮只返回了内部思考，没有正文，也没有工具调用。不要继续输出思考过程；请立即基于现有历史给出普通正文，或直接调用下一项具体工具。</runtime_verification>";

export const EMPTY_TURN_RETRY_CONTENT =
  "<runtime_verification>上一轮上游返回了空响应：没有正文，也没有工具调用。任务尚未完成。请从现有历史和工具结果继续，输出最终结论或立即调用下一步工具，不要再次返回空内容。</runtime_verification>";

export const REPETITION_RECOVERY_CONTENT =
  "<runtime_repetition_recovery>你已经连续多轮使用相同工具输入并得到相同结果。不要再次原样重试。请保留已有成果，检查最近一次失败或阻塞点，然后选择不同的命令或验证方式；已有后台进程时只读取其状态，不要重复启动；确实缺少外部信息时调用 request_user_input；任务已经完成时直接给出最终结论。</runtime_repetition_recovery>";

function isValidationToolCall(call: ToolCall) {
  if (call.name === "diagnostics") return true;
  if (call.name !== "run_command" && call.name !== "ssh_run") return false;
  const purpose = String(call.input.purpose ?? "").trim();
  if (purpose === "validate") return true;
  if (purpose === "inspect" || purpose === "modify" || purpose === "execute")
    return false;
  return isValidationCommand(String(call.input.command ?? ""));
}

export function classifyToolRoundProgress(input: {
  calls: readonly ToolCall[];
  roundAdvanced: boolean;
  roundOperationalProgress: boolean;
  roundExternalProgress: boolean;
  roundWaitingOnExternalWork: boolean;
  roundPlanChanged: boolean;
  roundFailed: boolean;
  roundFingerprint: string;
  noProgressFingerprints: ReadonlySet<string>;
  planCompleted: boolean;
  planStatusesCompleted?: boolean;
  evidenceComplete: boolean;
  hasMutationEvidence: boolean;
}): ToolRoundProgress {
  const unchangedPlanMaintenanceRound = Boolean(
    input.calls.length &&
      !input.roundPlanChanged &&
      input.calls.every((call) => call.name === "update_plan"),
  );
  const verificationOnlyRound = Boolean(
    input.calls.length &&
      !input.roundAdvanced &&
      !input.roundFailed &&
      (((input.planCompleted || input.planStatusesCompleted) &&
        !input.calls.some((call) => call.name === "update_plan")) ||
        (input.evidenceComplete && input.hasMutationEvidence)),
  );
  const nonProgressRound =
    verificationOnlyRound || unchangedPlanMaintenanceRound;
  const validationOnlyRound =
    input.calls.length > 0 &&
    input.calls.every((call) => isValidationToolCall(call));
  const repeatedNoProgressRound =
    !input.roundAdvanced &&
    input.noProgressFingerprints.has(input.roundFingerprint);
  const distinctOperationalProgress =
    input.roundOperationalProgress && !repeatedNoProgressRound;
  const madeProgress =
    input.roundAdvanced ||
    distinctOperationalProgress ||
    input.roundExternalProgress ||
    input.roundWaitingOnExternalWork ||
    (!nonProgressRound && !repeatedNoProgressRound);
  return {
    unchangedPlanMaintenanceRound,
    verificationOnlyRound,
    nonProgressRound,
    validationOnlyRound,
    repeatedNoProgressRound,
    distinctOperationalProgress,
    madeProgress,
  };
}

export function applyRoundStallCounters(
  state: RunState,
  progress: ToolRoundProgress,
  input: {
    roundAdvanced: boolean;
    roundExternalProgress: boolean;
    roundWaitingOnExternalWork: boolean;
    roundPlanChanged: boolean;
    roundFingerprint: string;
  },
) {
  if (input.roundAdvanced) state.noProgressFingerprints.clear();
  state.noProgressFingerprints.add(input.roundFingerprint);
  state.stalledRounds = progress.madeProgress ? 0 : state.stalledRounds + 1;
  state.semanticStallRounds =
    input.roundAdvanced ||
    progress.distinctOperationalProgress ||
    input.roundExternalProgress ||
    input.roundWaitingOnExternalWork ||
    input.roundPlanChanged
      ? 0
      : state.semanticStallRounds + 1;
  state.validationStallRounds =
    progress.validationOnlyRound &&
    !input.roundAdvanced &&
    !progress.distinctOperationalProgress &&
    !input.roundExternalProgress &&
    !input.roundWaitingOnExternalWork &&
    !input.roundPlanChanged
      ? state.validationStallRounds + 1
      : 0;
  if (
    input.roundAdvanced ||
    progress.distinctOperationalProgress ||
    input.roundExternalProgress ||
    input.roundPlanChanged
  )
    state.budgets.planRecoveryNudges = 0;
}

export function nextExternalWaitStall(input: {
  hasActiveUncollected: boolean;
  progressed: boolean;
  stalledRounds: number;
  startedAt: number | undefined;
  now?: number;
}): { stalledRounds: number; startedAt: number | undefined } {
  if (!input.hasActiveUncollected || input.progressed)
    return { stalledRounds: 0, startedAt: undefined };
  return {
    stalledRounds: input.stalledRounds + 1,
    startedAt: input.startedAt ?? input.now ?? Date.now(),
  };
}

export function pendingPlanStepLabel(
  plan: RunPlan,
  snapshot: Pick<
    RoundEvidenceSnapshot,
    "nextRequiredPlanStep" | "pendingRequiredPlanStep"
  >,
) {
  if (snapshot.nextRequiredPlanStep >= 0)
    return `第 ${snapshot.nextRequiredPlanStep + 1} 步“${plan.steps[snapshot.nextRequiredPlanStep]}”`;
  if (snapshot.pendingRequiredPlanStep >= 0)
    return `第 ${snapshot.pendingRequiredPlanStep + 1} 步“${plan.steps[snapshot.pendingRequiredPlanStep]}”`;
  return "当前结构化计划";
}

export function planRecoveryContent(input: {
  pendingStepLabel: string;
  planRequirementsPending: boolean;
  missing: readonly CodingOperation[];
}) {
  return `<runtime_repetition_recovery><runtime_execution_recovery>${input.pendingStepLabel}尚未完成。${input.planRequirementsPending ? "请先用 update_plan 为每一步补齐 requires（纯说明步骤用 []）。" : planRequirementRecoveryLabel(input.missing)}不要再次读取同一内容，不要只输出“已完成”；现在必须调用对应的原生工具。若外部环境确实不可用，调用 request_user_input 说明需要的具体信息，或在确认无需修改后调用 report_no_change。</runtime_execution_recovery></runtime_repetition_recovery>`;
}

export function stallFinalizeProgressMessage(input: {
  semanticStallReached: boolean;
  validationStallReached: boolean;
  validationStallRounds: number;
  semanticStallRounds: number;
  shouldFinalizeAvailableResult: boolean;
}) {
  if (input.semanticStallReached)
    return input.validationStallReached
      ? `连续 ${input.validationStallRounds} 轮只有验证且没有状态变化，已停止继续检查，正在汇总结果…`
      : `连续 ${input.semanticStallRounds} 轮没有产生实际状态变化，已停止继续检查，正在汇总结果…`;
  return input.shouldFinalizeAvailableResult
    ? "重复核对没有产生新结果，正在基于已有工具记录生成最终结论…"
    : "重复操作在纠偏后仍未取得进展，正在汇总已有结果和未完成项…";
}

export function roundStallDecision(input: {
  state: Pick<RunState, "stalledRounds" | "semanticStallRounds" | "validationStallRounds" | "budgets">;
  progress: Pick<ToolRoundProgress, "unchangedPlanMaintenanceRound">;
  snapshot: Pick<
    RoundEvidenceSnapshot,
    | "actionablePlanPending"
    | "evidenceComplete"
    | "planCompleted"
    | "hasMutationEvidence"
    | "planRequirementsPending"
    | "nextRequiredPlanStep"
    | "pendingRequiredPlanStep"
    | "missingActionCodingOperations"
  >;
  plan: RunPlan;
  roundFailed: boolean;
  pendingUserInput: boolean;
  hasUncollectedAgentWork: boolean;
}): RoundStallDecision {
  const completedPlanReadyToFinalize = Boolean(
    input.snapshot.planCompleted &&
      input.snapshot.evidenceComplete &&
      input.progress.unchangedPlanMaintenanceRound &&
      !input.roundFailed &&
      !input.pendingUserInput &&
      !input.hasUncollectedAgentWork,
  );
  if (completedPlanReadyToFinalize) return { action: "finalize-completed-plan" };
  const validationStallReached =
    input.state.validationStallRounds >= VALIDATION_STALL_ROUNDS;
  const semanticStallReached =
    input.state.semanticStallRounds >= SEMANTIC_STALL_ROUNDS ||
    validationStallReached;
  const currentStallAction: StallAction = semanticStallReached
    ? "finalize"
    : stallAction(input.state.stalledRounds);
  if (currentStallAction === "continue") return { action: "continue" };
  if (
    currentStallAction === "finalize" &&
    input.snapshot.actionablePlanPending &&
    input.state.budgets.planRecoveryNudges < MAX_PLAN_RECOVERY_NUDGES &&
    !(
      input.progress.unchangedPlanMaintenanceRound &&
      input.state.budgets.planRecoveryNudges > 0
    )
  )
    return {
      action: "plan-recovery",
      pendingStepLabel: pendingPlanStepLabel(input.plan, input.snapshot),
      missing: input.snapshot.missingActionCodingOperations,
      planRequirementsPending: input.snapshot.planRequirementsPending,
    };
  const shouldFinalizeAvailableResult =
    input.snapshot.evidenceComplete && !input.roundFailed;
  const shouldFinalizeNow =
    currentStallAction === "finalize" || shouldFinalizeAvailableResult;
  if (shouldFinalizeNow)
    return {
      action: "finalize",
      mode:
        !semanticStallReached &&
        shouldFinalizeAvailableResult &&
        (input.snapshot.planCompleted || input.snapshot.hasMutationEvidence)
          ? "evidence-complete"
          : "repetition-stalled",
      semanticStallReached,
      validationStallReached,
      shouldFinalizeAvailableResult,
    };
  return { action: "recover" };
}

export function isTruncatedFinishReason(reason?: string) {
  return /^(length|max_tokens|max_output_tokens)$/i.test(reason ?? "");
}

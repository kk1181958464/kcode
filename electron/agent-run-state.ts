import type {
  AgentActivity,
  AgentPlanRequirement,
  AgentPlanStepStatus,
  AgentRecoveryPlan,
} from "../src/types";
import type { BrowserOperation } from "./browser-operation-verification";
import type { CodingOperation } from "./coding-operation-verification";
import type { GitOperation } from "./git-operation-verification";
import type { AgentFinalizationMode } from "./agent-run-budget";

export type RunBudgets = {
  completionRetries: number;
  autoContinues: number;
  emptyTurns: number;
  reasoningOnlyTurns: number;
  planRecoveryNudges: number;
};

export type RunPrevRound = {
  activity?: AgentActivity;
  failure?: AgentActivity;
  toolNarrative: string;
};

export type RunPlan = {
  steps: string[];
  statuses: AgentPlanStepStatus[] | undefined;
  requirements: AgentPlanRequirement[][];
  cursor: number;
  requirementsDeclared: boolean;
};

export type RunPlanUpdate = {
  plan: Array<{
    step: string;
    status: AgentPlanStepStatus;
    requires: AgentPlanRequirement[];
  }>;
};

export type RunState = {
  timelineTextLength: number;
  requestedGitOps: Set<GitOperation>;
  requestedCodingEvidenceOps: Set<CodingOperation>;
  requestedBrowserOps: Set<BrowserOperation>;
  lastPromptTokens: number;
  lastRuntimeCompactionTokens: number;
  round: number;
  stalledRounds: number;
  semanticStallRounds: number;
  validationStallRounds: number;
  noProgressFingerprints: Set<string>;
  budgets: RunBudgets;
  prevRound: RunPrevRound;
  plan: RunPlan;
  imageFallbackNoticeSent: boolean;
  repetitionFinalizationPending: AgentFinalizationMode | undefined;
  externalWaitStallRounds: number;
  externalWaitStartedAt: number | undefined;
  externalWorkAbandoned: boolean;
  lastSubagentProgress: string;
};

function planFromRecovery(recoveryPlan?: AgentRecoveryPlan): RunPlan {
  return {
    steps: recoveryPlan?.steps.map((item) => item.step) ?? [],
    statuses: recoveryPlan?.steps.map((item) => item.status),
    requirements:
      recoveryPlan?.steps.map((item) => [...item.requires]) ?? [],
    cursor: recoveryPlan?.current ?? 0,
    requirementsDeclared: recoveryPlan
      ? recoveryPlan.requirementsDeclared
      : true,
  };
}

export function seedRequestedCodingOpsFromPlan(state: RunState) {
  for (const requirement of state.plan.requirements.flat())
    state.requestedCodingEvidenceOps.add(requirement as CodingOperation);
}

export function createRunState(input: {
  recoveryPlan?: AgentRecoveryPlan;
  lastSubagentProgress?: string;
} = {}): RunState {
  const state: RunState = {
    timelineTextLength: 0,
    requestedGitOps: new Set<GitOperation>(),
    requestedCodingEvidenceOps: new Set<CodingOperation>(),
    requestedBrowserOps: new Set<BrowserOperation>(),
    lastPromptTokens: 0,
    lastRuntimeCompactionTokens: 0,
    round: 0,
    stalledRounds: 0,
    semanticStallRounds: 0,
    validationStallRounds: 0,
    noProgressFingerprints: new Set<string>(),
    budgets: {
      completionRetries: 0,
      autoContinues: 0,
      emptyTurns: 0,
      reasoningOnlyTurns: 0,
      planRecoveryNudges: 0,
    },
    prevRound: { toolNarrative: "" },
    plan: planFromRecovery(input.recoveryPlan),
    imageFallbackNoticeSent: false,
    repetitionFinalizationPending: undefined,
    externalWaitStallRounds: 0,
    externalWaitStartedAt: undefined,
    externalWorkAbandoned: false,
    lastSubagentProgress: input.lastSubagentProgress ?? "",
  };
  seedRequestedCodingOpsFromPlan(state);
  return state;
}

export function resetRunStateAfterSteering(
  state: RunState,
  lastSubagentProgress: string,
) {
  state.requestedGitOps = new Set<GitOperation>();
  state.requestedCodingEvidenceOps = new Set<CodingOperation>();
  state.requestedBrowserOps = new Set<BrowserOperation>();
  state.budgets.completionRetries = 0;
  state.budgets.autoContinues = 0;
  state.budgets.emptyTurns = 0;
  state.budgets.reasoningOnlyTurns = 0;
  state.budgets.planRecoveryNudges = 0;
  state.stalledRounds = 0;
  state.semanticStallRounds = 0;
  state.validationStallRounds = 0;
  state.noProgressFingerprints.clear();
  state.repetitionFinalizationPending = undefined;
  state.externalWaitStallRounds = 0;
  state.externalWaitStartedAt = undefined;
  state.externalWorkAbandoned = false;
  state.lastSubagentProgress = lastSubagentProgress;
  state.plan.steps = [];
  state.plan.statuses = undefined;
  state.plan.requirements = [];
  state.plan.cursor = 0;
  state.plan.requirementsDeclared = true;
}

export function applyPlanUpdate(state: RunState, planUpdate: RunPlanUpdate) {
  const previousPlan = JSON.stringify({
    steps: state.plan.steps,
    statuses: state.plan.statuses,
    requirements: state.plan.requirements,
  });
  state.plan.steps = planUpdate.plan.map((item) => item.step);
  state.plan.statuses = planUpdate.plan.map((item) => item.status);
  state.plan.requirements = planUpdate.plan.map((item) => [...item.requires]);
  state.plan.requirementsDeclared = true;
  seedRequestedCodingOpsFromPlan(state);
  const activeStep = planUpdate.plan.findIndex(
    (item) => item.status === "in_progress",
  );
  const nextPending = planUpdate.plan.findIndex(
    (item) => item.status === "pending",
  );
  state.plan.cursor =
    activeStep >= 0
      ? activeStep
      : nextPending >= 0
        ? nextPending
        : Math.max(0, state.plan.steps.length - 1);
  const planSteps = state.plan.steps.length ? state.plan.steps : undefined;
  const planStep = planSteps
    ? Math.min(state.plan.cursor, planSteps.length - 1)
    : undefined;
  return {
    planChanged:
      previousPlan !==
      JSON.stringify({
        steps: state.plan.steps,
        statuses: state.plan.statuses,
        requirements: state.plan.requirements,
      }),
    planSteps,
    planStep,
  };
}

import type {
  AgentActivity,
  AgentPlanRequirement,
  AgentPlanStepStatus,
} from "./types";

export const AGENT_PLAN_REQUIREMENTS: AgentPlanRequirement[] = [
  "inspect",
  "modify",
  "execute",
  "validate",
  "connect",
  "upload",
  "download",
];

export type StructuredPlanUpdate = {
  explanation?: string;
  plan: Array<{
    step: string;
    status: AgentPlanStepStatus;
    requires: AgentPlanRequirement[];
  }>;
};

export function normalizePlanUpdate(input: {
  explanation?: unknown;
  plan?: unknown;
}): StructuredPlanUpdate {
  if (!Array.isArray(input.plan)) throw new Error("计划必须是步骤数组");
  if (input.plan.length > 12) throw new Error("执行计划最多包含 12 个步骤");
  const plan = input.plan.map((raw, index) => {
    if (!raw || typeof raw !== "object")
      throw new Error(`计划第 ${index + 1} 步格式无效`);
    const item = raw as Record<string, unknown>;
    const step = String(item.step ?? "")
      .replace(/\s+/g, " ")
      .trim();
    const status = String(item.status ?? "") as AgentPlanStepStatus;
    if (!Array.isArray(item.requires))
      throw new Error(
        `计划第 ${index + 1} 步必须声明 requires；纯说明步骤请传空数组`,
      );
    const requires = [
      ...new Set(item.requires.map((value) => String(value))),
    ] as AgentPlanRequirement[];
    if (
      requires.some(
        (requirement) => !AGENT_PLAN_REQUIREMENTS.includes(requirement),
      )
    )
      throw new Error(`计划第 ${index + 1} 步的 requires 包含无效操作`);
    if (step.length < 2) throw new Error(`计划第 ${index + 1} 步缺少具体内容`);
    if (step.length > 180) throw new Error(`计划第 ${index + 1} 步超过 180 字`);
    if (!["pending", "in_progress", "completed"].includes(status))
      throw new Error(`计划第 ${index + 1} 步状态无效`);
    return { step, status, requires };
  });
  if (new Set(plan.map((item) => item.step)).size !== plan.length)
    throw new Error("执行计划不能包含重复步骤");
  if (plan.filter((item) => item.status === "in_progress").length > 1)
    throw new Error("执行计划最多只能有一个进行中的步骤");
  const explanation = String(input.explanation ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500);
  return { explanation: explanation || undefined, plan };
}

export type ExecutionPlanStepStatus =
  "pending" | "running" | "completed" | "failed";

export type ExecutionPlanSummary = {
  steps: string[];
  current: number;
  statuses: ExecutionPlanStepStatus[];
  requirements?: AgentPlanRequirement[][];
};

const MUTATION_PLAN_TOOLS = new Set<AgentActivity["tool"]>([
  "apply_patch",
  "write_file",
  "make_directory",
  "move_path",
  "delete_path",
  "ssh_write_file",
  "ssh_upload_file",
  "ssh_download_file",
]);

const VALIDATION_PLAN_TOOLS = new Set<AgentActivity["tool"]>([
  "diagnostics",
  "git_diff",
  "git_status",
  "git_show",
  "process_output",
  "browser_snapshot",
  "browser_screenshot",
]);

const VALIDATION_COMMAND =
  /(?:^|\s)(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|typecheck|lint|build)|\b(?:pytest|phpunit|cargo\s+test|go\s+test|dotnet\s+test|tsc\b|eslint\b|vitest\b|jest\b|php\s+-l\b)/i;

/** Supplies a stable plan when an upstream model skips its numbered preamble. */
export function defaultExecutionPlan(operations: ReadonlySet<string>) {
  if (!operations.size) return [];
  const remote = ["connect", "upload", "download"].some((operation) =>
    operations.has(operation),
  );
  const mutates = ["modify", "upload", "download"].some((operation) =>
    operations.has(operation),
  );
  const executes = operations.has("execute");
  const validates = operations.has("validate");
  const steps = [
    remote ? "确认目标环境与当前状态" : "检查当前实现并确认处理范围",
  ];
  if (operations.has("modify")) steps.push("修改相关文件并记录实际差异");
  else if (operations.has("upload")) steps.push("上传文件并确认远端内容");
  else if (operations.has("download")) steps.push("下载文件并确认本地内容");
  else if (operations.has("connect")) steps.push("建立连接并确认可用状态");
  if (mutates || executes || validates)
    steps.push(
      validates || mutates
        ? "运行验证并核对最终结果"
        : "执行目标操作并检查输出",
    );
  else if (operations.has("inspect")) steps.push("汇总检查结果并给出结论");
  return [...new Set(steps)].slice(0, 6);
}

/** Maps fallback-plan activities to inspection, mutation, or validation. */
export function fallbackExecutionPlanStep(
  tool: AgentActivity["tool"],
  input: Record<string, unknown>,
  planLength: number,
  current: number,
) {
  const last = Math.max(0, planLength - 1);
  if (MUTATION_PLAN_TOOLS.has(tool)) return Math.min(1, last);
  if (
    VALIDATION_PLAN_TOOLS.has(tool) ||
    ((tool === "run_command" || tool === "ssh_run") &&
      VALIDATION_COMMAND.test(String(input.command ?? "")))
  )
    return last;
  return Math.min(current, last);
}

export function summarizeExecutionPlan(
  activities: readonly AgentActivity[],
): ExecutionPlanSummary | undefined {
  const source = [...activities]
    .reverse()
    .find((activity) => activity.planSteps && activity.planSteps.length >= 2);
  if (!source?.planSteps?.length) return undefined;
  const steps = source.planSteps;
  const current = Math.min(Math.max(0, source.planStep ?? 0), steps.length - 1);
  const declaredStatuses =
    source.planStatuses?.length === steps.length
      ? source.planStatuses
      : undefined;
  const declaredRequirements =
    source.planRequirements?.length === steps.length
      ? source.planRequirements
      : undefined;
  const statuses = steps.map<ExecutionPlanStepStatus>((_, index) => {
    const related = activities.filter(
      (activity) => activity.planStep === index,
    );
    const last = [...related]
      .reverse()
      .find(
        (activity) =>
          !["report_no_change", "request_user_input"].includes(activity.tool),
      );
    if (last?.status === "running" || last?.status === "waiting")
      return "running";
    if (last?.status === "failed" || last?.status === "denied") return "failed";
    if (declaredStatuses?.[index] === "completed") return "completed";
    if (declaredStatuses?.[index] === "in_progress") return "running";
    if (last && (last.status === "success" || last.status === "completed"))
      return "completed";
    return "pending";
  });
  return {
    steps,
    current,
    statuses,
    ...(declaredRequirements
      ? { requirements: declaredRequirements.map((item) => [...item]) }
      : {}),
  };
}

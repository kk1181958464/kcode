import { createRequire } from "node:module";
import { executorModelOverrides } from "./collaboration";
import { latestUserRequestContent } from "./coding-operation-verification";
import {
  SUBAGENT_WAIT_MIN_MS,
  SUBAGENT_WAIT_SLICE_MS,
} from "./agent-run-budget";
import {
  collectedSubagentSummaries,
  listSubagents,
  messageSubagent,
  permissionPolicyForSubagent,
  spawnSubagent,
  stopSubagent,
  waitForSubagents,
  MAX_SUBAGENT_DEPTH,
  type SubagentExecutionTarget,
  type SubagentRunner,
  type WaitForSubagentsOptions,
} from "./subagents";
import { turnSteeringQueue } from "./turn-steering";
import {
  codingEvidenceFromActivities,
  browserEvidenceFromActivities,
} from "./agent-evidence";
import type { AgentRunner, ToolResult } from "./agent-types";
import type { ModelRequest } from "../src/types";

const requireProduction = createRequire(__filename);

export const SUBAGENT_TOOL_NAMES = new Set([
  "spawn_agent",
  "list_agents",
  "message_agent",
  "wait_agent",
  "stop_agent",
]);

export type SubagentToolContext = {
  root: string;
  requestId: string;
  name: string;
  input: Record<string, unknown>;
  request: ModelRequest;
  signal: AbortSignal;
  runChildAgent: AgentRunner;
  onProgress?: (output: string) => void;
  waitTimeoutOverrideMs?: number;
};

export type SubagentToolDeps = {
  maxDepth: number;
  waitMinMs: number;
  waitSliceMs: number;
  executorModelOverrides: typeof executorModelOverrides;
  getProviderWithKey: (id: string) => Promise<{
    enabled: boolean;
    models: Array<{ modelId: string }>;
  }>;
  latestUserRequestContent: typeof latestUserRequestContent;
  collectedSubagentSummaries: typeof collectedSubagentSummaries;
  permissionPolicyForSubagent: typeof permissionPolicyForSubagent;
  spawnSubagent: (
    parentRequestId: string,
    name: string,
    task: string,
    parentSignal: AbortSignal,
    runner: SubagentRunner,
    executionTarget?: SubagentExecutionTarget,
  ) => unknown;
  listSubagents: typeof listSubagents;
  messageSubagent: typeof messageSubagent;
  waitForSubagents: (
    parentRequestId: string,
    agentIds: string[] | undefined,
    options: WaitForSubagentsOptions,
  ) => ReturnType<typeof waitForSubagents>;
  stopSubagent: typeof stopSubagent;
  subscribeToSteering: (
    requestId: string,
    listener: () => void,
  ) => () => void;
};

function productionGetProviderWithKey(id: string) {
  const store = requireProduction("./store") as typeof import("./store");
  return store.getProviderWithKey(id);
}

const defaultSubagentDeps: SubagentToolDeps = {
  maxDepth: MAX_SUBAGENT_DEPTH,
  waitMinMs: SUBAGENT_WAIT_MIN_MS,
  waitSliceMs: SUBAGENT_WAIT_SLICE_MS,
  executorModelOverrides,
  getProviderWithKey: productionGetProviderWithKey,
  latestUserRequestContent,
  collectedSubagentSummaries,
  permissionPolicyForSubagent,
  spawnSubagent,
  listSubagents,
  messageSubagent,
  waitForSubagents,
  stopSubagent,
  subscribeToSteering: (requestId, listener) =>
    turnSteeringQueue.subscribe(requestId, listener),
};

export function subagentWaitTimeoutMs(
  requestedTimeout: unknown,
  waitTimeoutOverrideMs: number | undefined,
  waitMinMs: number,
  waitSliceMs: number,
) {
  const requested = Number(requestedTimeout);
  const requestedWaitTimeoutMs = Number.isFinite(requested)
    ? Math.min(waitSliceMs, Math.max(waitMinMs, Math.floor(requested)))
    : waitSliceMs;
  if (waitTimeoutOverrideMs === undefined) return requestedWaitTimeoutMs;
  return Math.min(
    requestedWaitTimeoutMs,
    Math.max(1, Math.floor(waitTimeoutOverrideMs)),
  );
}

export async function executeSubagentTool(
  ctx: SubagentToolContext,
  deps: SubagentToolDeps = defaultSubagentDeps,
): Promise<ToolResult> {
  const { requestId, name, input, request, signal, runChildAgent } = ctx;
  const onProgress = ctx.onProgress ?? (() => undefined);

  if (name === "spawn_agent") {
    if ((request.agentDepth ?? 0) >= deps.maxDepth)
      throw new Error(
        "当前 Agent 已达到委派深度；请直接完成已分配范围，不要再创建下级 Agent。",
      );
    const task = String(input.task || "").trim();
    if (!task) throw new Error("缺少子 Agent 任务目标。");
    const givenName = String(input.name || "").trim();
    const role = String(input.role || "").trim();
    if (role && role !== "executor") throw new Error("不支持的子 Agent 角色。");
    const executorOverride = deps.executorModelOverrides(request);
    if (executorOverride) {
      const executorProvider = await deps.getProviderWithKey(
        executorOverride.providerId,
      );
      if (!executorProvider.enabled) throw new Error("执行模型供应商已停用。");
      if (
        !executorProvider.models.some(
          (model) => model.modelId === executorOverride.modelId,
        )
      )
        throw new Error("执行模型已被移除或不属于所选供应商。");
    }
    const childName = executorOverride ? givenName || "执行 Agent" : givenName;
    const childModelOverride = executorOverride
      ? {
          providerId: executorOverride.providerId,
          modelId: executorOverride.modelId,
          reasoningEffort: executorOverride.reasoningEffort,
          contextWindow: executorOverride.contextWindow,
          agentRole: executorOverride.agentRole,
          collaboration: executorOverride.collaboration,
        }
      : {};
    const delegatedRequestContext = executorOverride
      ? deps
          .latestUserRequestContent(
            request.messages.map((message) => ({
              kind: "message" as const,
              ...message,
            })),
          )
          .slice(-12_000)
      : "";
    const delegatedImages = executorOverride
      ? [...request.messages]
          .reverse()
          .find((message) => message.images?.length)?.images
      : undefined;
    // Thread the most recent already-collected executor's conclusion into a
    // follow-up executor so the planner need not restate everything. Only the
    // latest collected summary is carried to keep the delegated task focused.
    const priorExecutorSummary = executorOverride
      ? deps.collectedSubagentSummaries(requestId).at(-1)
      : undefined;
    const priorExecutorContext = priorExecutorSummary
      ? `\n\n上一执行 Agent（${priorExecutorSummary.name}）的结果摘要，供衔接参考，勿重复其已完成的工作：\n${priorExecutorSummary.transcript.slice(-4_000)}`
      : "";
    const state = deps.spawnSubagent(
      requestId,
      childName,
      task,
      signal,
      (childRequestId, agentId, childSignal) =>
        runChildAgent(
          childRequestId,
          {
            ...request,
            ...childModelOverride,
            taskId: `${request.taskId || requestId}:subagent:${agentId}`,
            agentDepth: (request.agentDepth ?? 0) + 1,
            permissionPolicy: deps.permissionPolicyForSubagent(
              request.permissionMode,
              request.permissionPolicy,
            ),
            messages: [
              {
                role: "user",
                content: `${executorOverride ? `你是协作任务的执行 Agent，当前执行模型为 ${executorOverride.displayName}。严格落实规划 Agent 给出的步骤和验收条件，使用真实工具完成修改与验证，不要只重复规划。` : "你是主 Agent 委派的子 Agent。"}请独立完成以下任务并向主 Agent 返回准确、简洁、可验证的结果。不要等待用户补充信息；遇到阻碍时说明已检查的内容和具体阻碍。避免修改其他子 Agent 可能负责的文件。${delegatedRequestContext ? `\n\n原始用户目标：\n${delegatedRequestContext}` : ""}${priorExecutorContext}\n\n委派任务：\n${task}`,
                images: delegatedImages,
              },
            ],
          },
          childSignal,
        ),
      executorOverride
        ? {
            agentRole: "executor",
            providerId: executorOverride.providerId,
            modelId: executorOverride.modelId,
            modelDisplayName: executorOverride.displayName,
            reasoningEffort: executorOverride.reasoningEffort,
          }
        : undefined,
    );
    return { output: JSON.stringify(state, null, 2) };
  }
  if (name === "list_agents")
    return {
      output: JSON.stringify(deps.listSubagents(requestId), null, 2),
    };
  if (name === "message_agent")
    return {
      output: JSON.stringify(
        deps.messageSubagent(
          requestId,
          String(input.agentId || ""),
          String(input.message || ""),
        ),
        null,
        2,
      ),
    };
  if (name === "wait_agent") {
    const agentIds = Array.isArray(input.agentIds)
      ? input.agentIds.map(String)
      : undefined;
    const waitTimeoutMs = subagentWaitTimeoutMs(
      input.timeoutMs,
      ctx.waitTimeoutOverrideMs,
      deps.waitMinMs,
      deps.waitSliceMs,
    );
    const waitResult = await deps.waitForSubagents(requestId, agentIds, {
      signal,
      onProgress,
      timeoutMs: waitTimeoutMs,
      subscribeToSteering: (listener) =>
        deps.subscribeToSteering(requestId, listener),
    });
    const childActivities = waitResult.completed.flatMap(
      (result) => result.activityRecords,
    );
    const completed = waitResult.completed.map(
      ({ activityRecords: _records, usageDelta: _usageDelta, ...result }) =>
        result,
    );
    return {
      output: JSON.stringify(
        {
          message: waitResult.message,
          timedOut: waitResult.timedOut,
          interrupted: waitResult.interrupted,
          progressed: waitResult.progressed,
          completed,
          pending: waitResult.pending,
        },
        null,
        2,
      ),
      childActivities,
      subagentUsage: waitResult.completed.reduce(
        (total, result) => ({
          input: total.input + result.usageDelta.input,
          output: total.output + result.usageDelta.output,
          cached: total.cached + result.usageDelta.cached,
        }),
        { input: 0, output: 0, cached: 0 },
      ),
      exitCode: waitResult.completed.some(
        (result) => result.status !== "completed",
      )
        ? 1
        : 0,
      executed: true,
      additions: childActivities.reduce(
        (sum, activity) => sum + (activity.additions ?? 0),
        0,
      ),
      deletions: childActivities.reduce(
        (sum, activity) => sum + (activity.deletions ?? 0),
        0,
      ),
      changed: childActivities.some(
        (activity) =>
          activity.status === "success" &&
          (activity.changed === true ||
            Boolean(activity.diff) ||
            Boolean(activity.additions) ||
            Boolean(activity.deletions)),
      ),
      operationEvidence: codingEvidenceFromActivities(childActivities),
      browserOperationEvidence: browserEvidenceFromActivities(childActivities),
      subagentWait: {
        completed: waitResult.completed.length,
        pending: waitResult.pending.length,
        timedOut: waitResult.timedOut,
        interrupted: waitResult.interrupted,
        progressed: waitResult.progressed,
      },
    };
  }
  if (name === "stop_agent") {
    const result = await deps.stopSubagent(
      requestId,
      String(input.agentId || ""),
    );
    const { activityRecords, usageDelta, ...visible } = result;
    return {
      output: JSON.stringify(visible, null, 2),
      childActivities: activityRecords,
      subagentUsage: usageDelta,
      operationEvidence: codingEvidenceFromActivities(activityRecords),
      browserOperationEvidence: browserEvidenceFromActivities(activityRecords),
    };
  }
  throw new Error(`不支持的子 Agent 工具：${name}`);
}

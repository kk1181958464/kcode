import { TurnDiffTracker } from "./turn-diff-tracker";
import { createDefaultStopHooks } from "./stop-hooks";
import { FileReadCache } from "./file-read-cache";
import { runHooks } from "./hook-lifecycle";
import { ConversationWriter } from "./conversation-persist";
import { resetToolStats } from "./tool-stats";
import { stat } from "node:fs/promises";
import path from "node:path";
import { type AgentActivity, type ModelRequest } from "../src/types";
import { imageInputSupport } from "../src/model-capabilities";
import {
  buildRuntimeWorkspaceBindingInstruction,
  effectiveLocalWorkspacePath,
} from "./workspace-prompt";
import { effectiveOpenAiProtocol } from "./protocol-fallback";
import { type GitOperation } from "./git-operation-verification";
import {
  latestUserRequestContent,
  type CodingOperation,
} from "./coding-operation-verification";
import { type BrowserOperation } from "./browser-operation-verification";
import { loadActiveSkillInstructions } from "./agent-skills";
import { agentHooks } from "./agent-hooks";
import { getProviderWithKey } from "./store";
import { bindBrowserRequest, browserIsOpen } from "./browser";
import { sshRemoteState } from "./ssh-remote";
import { subagentProgressToken } from "./subagents";
import { isPlannerCoordinator } from "./collaboration";
import { createRunState } from "./agent-run-state";
import type {
  ToolCall,
  ModelTurnRuntime,
  RunAgentDeps,
  HistoryItem,
} from "./agent-types";
import {
  defaultRuntimeContextSummarizer,
  hasImageAttachments,
} from "./runtime-compaction";
import { redactedToolInput } from "./agent-input";

/** Allocate per-request resources and bind the current workspace and provider. */
export async function initializeAgentRun(
  requestId: string,
  request: ModelRequest,
  signal: AbortSignal,
  deps: RunAgentDeps,
) {
  const getProvider = deps.getProvider ?? getProviderWithKey;
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
  runHooks("SessionStart", { workspaceRoot: root, requestId, signal }).catch(
    () => {},
  );
  // Tool stats tracking — reset per session
  const toolStats = resetToolStats();
  const activeConnectionFacts = new Map<string, string>();
  if (connectedRemoteWorkspace)
    activeConnectionFacts.set(
      "ssh",
      `ssh session ${connectedRemoteWorkspace.username}@${connectedRemoteWorkspace.host}:${connectedRemoteWorkspace.port}; remote project root ${connectedRemoteWorkspace.rootPath}; local project root ${localProjectPath ?? "none attached"}`,
    );
  const latestUserRequest = latestUserRequestContent(history);
  const plannerCoordinator = isPlannerCoordinator(request);
  const activeSkillInstructions =
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
  return {
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
  };
}

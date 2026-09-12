import { apiKeyCooldownPool } from "./api-key-cooldown";
import { WorldStateDiffTracker, buildSegments } from "./world-state-diff";
import { normalizeHistory } from "./history-normalize";
import { loadProjectInstructions } from "./project-instructions";
import path from "node:path";
import {
  inferReasoningConfig,
  type ModelRequest,
  type Protocol,
  type ReasoningEffort,
} from "../src/types";
import { imageInputSupport } from "../src/model-capabilities";
import {
  createConversationIsolation,
  historyFingerprint,
} from "./conversation-isolation";
import { writeLog } from "./logger";
import { directNetworkFetch, networkFetch } from "./network";
import { modelNetworkTransportLabel } from "./model-network-transport";
import { localShellPromptInstruction } from "./local-shell";
import {
  buildWorkspaceLocationInstruction,
  effectiveLocalWorkspacePath,
} from "./workspace-prompt";
import {
  fetchWithRetry,
  retryAfterMilliseconds,
  UpstreamHttpError,
  isRetryableStreamError,
  readResponseText,
} from "./request-guard";
import {
  effectiveOpenAiProtocol,
  rememberChatFallback,
  shouldFallbackResponses,
} from "./protocol-fallback";
import { latestUserRequestContent } from "./coding-operation-verification";
import { loadActiveSkillInstructions } from "./agent-skills";
import { SseStreamTimeoutError } from "./sse-stream";
import { REASONING_ONLY_IDLE_TIMEOUT_MS } from "./model-stream-retry";
import {
  FINALIZATION_TURN_MAX_DURATION_MS,
  MODEL_TURN_MAX_DURATION_MS,
} from "./model-stream-retry";
import { resolveModelCompatibility } from "./model-compatibility";
import { ModelAttemptBudget } from "./model-attempt-budget";
import { requiredToolChoiceForProtocol } from "./tool-choice-policy";
import { providerApiEndpoint } from "./provider-url";
import { hasUserSuppliedVerificationCode } from "./browser-cdp";
import { getProviderWithKey, updateModelCapabilities } from "./store";
import { listMcpServerConfigs } from "./mcp";
import { browserIsOpen } from "./browser";
import { MAX_SUBAGENT_DEPTH } from "./subagents";
import {
  isPlannerCoordinator,
  plannerCollaborationInstruction,
  plannerToolAllowed,
  remoteWorkspaceToolAllowed,
} from "./collaboration";
import type { Turn, ModelTurnRuntime, HistoryItem } from "./agent-types";
import {
  hasImageAttachments,
  historyWithoutImages,
} from "./runtime-compaction";
import { tools } from "./agent-tool-schema";
import { parseStreamedTurn, parseModelResponse } from "./model-response-parser";

const base64Data = (dataUrl: string) => dataUrl.slice(dataUrl.indexOf(",") + 1);

const worldStateTracker = new WorldStateDiffTracker();

export async function modelTurn(
  root: string,
  requestId: string,
  request: ModelRequest,
  history: HistoryItem[],
  signal: AbortSignal,
  toolsEnabled = true,
  requireToolCall = false,
  onText?: (delta: string) => void,
  onReasoning?: (delta: string) => void,
  onProgress?: (message: string) => void,
  protocolOverride?: Protocol,
  runtime?: ModelTurnRuntime,
  attemptBudget?: ModelAttemptBudget,
  turnDeadlineAt?: number,
): Promise<Turn> {
  const finalizationTurn = !toolsEnabled;
  const turnMaxDurationMs = finalizationTurn
    ? FINALIZATION_TURN_MAX_DURATION_MS
    : MODEL_TURN_MAX_DURATION_MS;
  // Key/protocol fallbacks are part of the same model turn. Reuse the original
  // deadline so each recursive fallback cannot open another timeout window.
  const effectiveTurnDeadlineAt =
    turnDeadlineAt ?? Date.now() + turnMaxDurationMs;
  const remainingTurnMs = () => effectiveTurnDeadlineAt - Date.now();
  const turnTimeout = () =>
    new SseStreamTimeoutError("absolute", turnMaxDurationMs);
  if (remainingTurnMs() <= 0) throw turnTimeout();
  const provider =
    runtime?.provider ?? (await getProviderWithKey(request.providerId));
  const apiKeys = provider.apiKeys?.length
    ? provider.apiKeys
    : [provider.apiKey];
  const requestedKeyIndex =
    runtime?.keyIndex ?? apiKeyCooldownPool.select(provider.id, apiKeys.length);
  const keyIndex = Math.min(
    Math.max(0, requestedKeyIndex),
    Math.max(0, apiKeys.length - 1),
  );
  const activeApiKey = apiKeys[keyIndex] || provider.apiKey;
  const triedKeyIndexes = new Set(runtime?.triedKeyIndexes ?? []);
  const nextApiKeyIndex = () => {
    triedKeyIndexes.add(keyIndex);
    return apiKeyCooldownPool.next(
      provider.id,
      apiKeys.length,
      keyIndex,
      triedKeyIndexes,
    );
  };
  if (!provider.enabled) throw new Error("当前供应商已停用");
  if (!provider.models.some((model) => model.modelId === request.modelId))
    throw new Error("模型不属于当前供应商或已被移除");
  const selectedModel = provider.models.find(
    (model) => model.modelId === request.modelId,
  )!;
  const protocol =
    protocolOverride ??
    (provider.protocol === "openai-responses" &&
    selectedModel.supportsResponses === false
      ? "openai-chat"
      : effectiveOpenAiProtocol(
          provider.id,
          provider.protocol,
          request.modelId,
        ));
  const compatibility = resolveModelCompatibility(
    provider,
    selectedModel,
    protocol,
  );
  const imageSupport = imageInputSupport(selectedModel, protocol);
  const omitImageInputs =
    runtime?.omitImageInputs === true || imageSupport === "unsupported";
  const payloadHistory = normalizeHistory(
    omitImageInputs ? historyWithoutImages(history) : history,
  ) as typeof history;
  const reasoning = {
    ...inferReasoningConfig(selectedModel.modelId, protocol),
    reasoningMode:
      selectedModel.reasoningMode ??
      inferReasoningConfig(selectedModel.modelId, protocol).reasoningMode,
  };
  const effort = request.reasoningEffort ?? "auto";
  const budgets: Partial<Record<ReasoningEffort, number>> = {
    low: 2048,
    medium: 8192,
    high: 16384,
    xhigh: 32768,
    max: 65536,
  };
  const plannerCoordinator = isPlannerCoordinator(request);
  const browserSessionId =
    request.connectionSessionId || request.taskId || requestId;
  const hasBrowserCredentialScope = browserIsOpen(browserSessionId);
  const runtimeTools = toolsEnabled
    ? tools.filter(
        (tool) =>
          !(
            (request.agentDepth ?? 0) >= MAX_SUBAGENT_DEPTH &&
            tool.name === "spawn_agent"
          ) &&
          (hasBrowserCredentialScope ||
            ![
              "browser_list_credentials",
              "browser_save_credential",
              "browser_fill_credential",
            ].includes(tool.name)) &&
          (!request.remoteWorkspace || remoteWorkspaceToolAllowed(tool.name)) &&
          (!plannerCoordinator ||
            plannerToolAllowed(tool.name, Boolean(request.remoteWorkspace))),
      )
    : [];
  const isolation = createConversationIsolation(request.taskId, requestId);
  const latestUserRequest = latestUserRequestContent(history);
  const enabledMcpServers = listMcpServerConfigs().filter(
    (server) => server.enabled,
  );
  const localShellInstruction = localShellPromptInstruction();
  const executionRoot = path.resolve(request.workspacePath);
  const workspaceLocationInstruction = buildWorkspaceLocationInstruction({
    executionRoot,
    localWorkspacePath: request.remoteWorkspace
      ? request.localWorkspacePath
      : root,
    remoteWorkspace: request.remoteWorkspace,
  });
  const localProjectAttached = Boolean(
    effectiveLocalWorkspacePath({
      executionRoot,
      localWorkspacePath: request.localWorkspacePath,
      remoteWorkspace: request.remoteWorkspace,
    }),
  );
  const activeSkills = [
    runtime?.activeSkills ??
      (await loadActiveSkillInstructions(latestUserRequest)),
    workspaceLocationInstruction,
    runtime?.workspaceBinding ?? "",
    plannerCollaborationInstruction(request),
    "When a task has multiple independent phases, call update_plan with concise steps and structured statuses instead of writing a numbered plan in prose. Every plan item must include requires with one or more native obligations (inspect, modify, execute, validate, connect, upload, download), or [] when the item is explanation-only. Keep a required step pending until its native tool result succeeds or a structured no-change/user-input result resolves it. Before every tool-call group, write no more than two concise user-facing progress sentences explaining which plan step you are executing and why; keep this preamble under 240 characters. Never dump a full implementation monologue, speculative patch, or repeated plan into the chat. A non-final turn must include a tool call instead of only describing what you will do. Update the plan as steps advance. After a failed tool result, briefly explain how you are adjusting the approach before the next tool call. Never claim success before a tool result confirms it.",
    "Delegation is one level only: a subagent must complete its assigned scope directly and must not create another subagent. When a child wait times out, use the returned progress and pending status; do not busy-poll with repeated short waits. Repeated waits with no child progress are stopped automatically and the partial result is preserved.",
    "wait_agent returns when the first selected child finishes. Put all relevant agent ids in one wait_agent call; never emit one wait call per child in the same model turn. Long waits are automatically sliced and all waits in one turn share a 60-second budget so the parent can observe real child progress. A timeout is a successful, non-destructive status update: the child remains running and uncollected, so wait again only when it is making progress; repeated no-progress waits are stopped automatically and the partial result is preserved. New user steering may interrupt the wait without stopping the child.",
    enabledMcpServers.length
      ? `KCode 已启用这些 MCP 服务：${enabledMcpServers.map((server) => `${server.name}（server=${server.id}）`).join("、")}。需要使用外部扩展能力时，先用对应 server ID 调用 mcp_list_tools 获取真实 schema，再调用 mcp_call_tool；不要凭空捏造 MCP 工具结果。MCP 工具活动和错误必须如实展示给用户。`
      : "当前没有启用 MCP 扩展；不要声称调用了 MCP 工具。",
    "Past-tense claims about real workspace or external actions are checked against successful structured tool results. Do not say that a file was changed, a command ran, a test passed, a remote connection or transfer completed, a browser action happened, or a Git action completed unless the corresponding tool evidence exists in this run. Informational answers, explanations, planning, and content generation that require no real action may finish without calling a tool; do not invent an action claim merely to create evidence. If an earlier statement was wrong, retract it explicitly instead of inventing evidence.",
    "When <runtime_retained_protocol_context> is present, it contains protocol details the user already supplied earlier in this task. Reuse those endpoint, authentication, request, response, and polling details; do not call request_user_input to ask for the same protocol again. Ask only for a specific field that is still absent after checking the retained block.",
    "When the latest user explicitly requests deployment, replacement, migration, restart, or another change to a known target, treat that request as authorization to carry out the action under the selected permission policy. Do not stop before the mutation solely because the service may briefly be affected: make the promised backup, use the least-disruptive or atomic switch available, and continue with native tools. Ask for another confirmation only when the permission system is waiting or a genuinely required target, credential, or rollback detail is missing.",
    "Saved credentials are local to this KCode installation and isolated by explicit tool scope. Never infer a credential category merely from words such as account, username, password, login, 账号, 密码, or 登录. SSH and database credentials belong only to their matching connect tools; call credential_list only after the target connection category is known. Website credentials belong only to the real origin currently open in the task browser: use browser_list_credentials, browser_save_credential, and browser_fill_credential there. If no target type or endpoint is known, call request_user_input for the target category and address instead of guessing website. A successful new SSH or database connection is remembered by default unless the user explicitly requests a temporary connection. Never invent an alias, put a decrypted secret in chat, send a secret to a subagent, or place one in a command when a native credential-aware tool can perform the action.",
    request.remoteWorkspace
      ? `This is a managed SSH Remote task with hybrid file access: the ssh_* tools act on the remote server, while the local file, git, and command tools act on THIS local machine. Use ssh_run for remote shell work; its shell and OS come from the remote server. For local commands, ${localShellInstruction} When the user points to local files by absolute path, read, edit, build, and inspect them with the local file and command tools, then use ssh_upload_file to deploy the results to the server and ssh_download_file to pull remote files down. Reuse the managed session while it is connected. If an SSH tool explicitly reports that the session was lost, call ssh_connect with credentials already supplied by the user; never ask the user to create another SSH Remote manually. Do not disconnect the managed session unless the user explicitly requests it.`
      : `${localShellInstruction} Use browser_open, browser_snapshot, browser_click, browser_type, and browser_screenshot for browser work. For responsive validation, pass explicit width and height to browser_screenshot. Never launch a browser through run_command for browsing, DOM inspection, version checks, or screenshots.`,
    !request.remoteWorkspace
      ? "When connecting to a remote project, pass its project directory as rootPath to ssh_connect so KCode opens the editable SSH Remote workspace immediately. If you learn the project directory only after connecting, call ssh_set_workspace once with that directory. Do not leave the editor rooted at the server home when a more specific project root is known, and do not call ssh_disconnect after finishing unless the user explicitly asks to disconnect."
      : "",
    "Never create a Git commit, push a branch or tag, or trigger a release/build workflow unless the latest user request explicitly asks for that Git action. Business-domain phrases such as submitting an order, pushing a message, publishing content, or running a local package/build are not Git authorization. Read-only Git status or diff checks may be used only when relevant to workspace safety and must not turn into a Git task.",
    "When you create, generate, or download a local file for the user, include a clickable Markdown link to it in the final reply. For a file inside the workspace, make the href its workspace-relative path with forward slashes, for example [report.txt](output/report.txt). Use an absolute local path only for files outside the workspace. Do not present a remote-server-only path as a local file link.",
  ]
    .filter(Boolean)
    .join("\n\n");
  const requiredToolInstruction =
    requireToolCall && runtimeTools.length
      ? "\n\n<runtime_tool_requirement>This response must include at least one native tool call. Do not return a plan, progress narration, or completion summary without calling a tool. Use request_user_input only when a specific undiscoverable input is genuinely required, and use report_no_change only after successful read-only inspection proves that no edit is needed.</runtime_tool_requirement>"
      : "";
  const recoveryPlanInstruction = request.recoveryPlan
    ? `\n\n<structured_recovery_plan>${JSON.stringify(request.recoveryPlan)}</structured_recovery_plan>\nThis is authoritative runtime state from the interrupted request. Preserve successful evidence, refresh the plan with requires if requirementsDeclared is false, and begin with the first pending or failed step. Do not treat a prose summary as proof of completion.`
    : "";
  const remoteWorkspaceInstruction = request.remoteWorkspace
    ? `\n\n<ssh_remote_workspace>\nThis task is attached to a managed SSH Remote workspace. Try the existing session first. If an SSH tool explicitly reports that the session was lost, ssh_connect is available for recovery. When the user already supplied the host, username, password, private-key content, or an absolute private-key path, reconnect yourself immediately with those values; use privateKeyPath for a user-supplied key path and do not send the user to the SSH Remote dialog. The project source of truth is on ${request.remoteWorkspace.username}@${request.remoteWorkspace.host}:${request.remoteWorkspace.port} under ${request.remoteWorkspace.rootPath}. Pass that rootPath when reconnecting. Use ssh_list_directory, ssh_read_file, ssh_write_file, ssh_run, ssh_upload_file, and ssh_download_file for work on the remote server. Relative SSH file paths are automatically resolved under the remote root. Every ssh_run command starts in the remote root. This is a hybrid task: you ALSO have the local file, git, and command tools, which act on THIS machine. When the user references local project sources by absolute path (for example D:\\\\project\\\\... on Windows), use the local tools to read, edit, build, and inspect them, then ssh_upload_file to deploy build artifacts to the server. The app-managed SSH cache is ${executionRoot}; the local project root for local tools is ${root}. Do not treat the cache as local source code. Use local tools on the local root or on absolute paths the user provides, then use ssh_upload_file when remote deployment is requested.\n</ssh_remote_workspace>`
    : "";
  const workspaceRoleInstruction =
    request.remoteWorkspace && !localProjectAttached
      ? `You are an SSH Remote agent. No local source project is attached. Treat ${executionRoot} as KCode's managed cache only; use ssh_* tools for remote source work and do not inspect or modify the cache as if it were the user's project.`
      : `You are a coding agent working in ${root}. Use the provided native tools to inspect and modify the project.`;
  const commandPurposeInstruction =
    "For run_command and ssh_run, set purpose to inspect for read-only work, modify for any intentional state change, validate only for a separate deterministic post-change check, and execute for other commands. Do not hide a mutation inside an inspect or validate call.";
  const system = `${isolation.boundary}\n${workspaceRoleInstruction} ${commandPurposeInstruction} Each run_command invocation uses a fresh local shell process, so environment variable changes do not persist to later commands; combine dependent setup and execution in one command. Prefer apply_patch for precise edits and write_file for new or complete files. Never invoke apply_patch, file deletion, file moves, or directory operations through run_command when a native tool exists. File tool paths accept absolute paths, including other drives (for example D:\\B on Windows); use them to read or write files the user explicitly points to outside ${root}, and resolve relative paths against ${root}. When you mention a file in your reply, always write its full workspace-relative path (for example src/views/Gooddetail.vue, not just Gooddetail.vue) so the user can tell exactly which file it is. Use web_search for current or externally verifiable information and fetch_url to inspect primary sources; preserve source URLs in the final answer. For interactive or authenticated sites use browser_open, browser_snapshot, browser_click, and browser_type. Credentials explicitly supplied by the user may be entered directly with browser_type. Browser recording is opt-in: call browser_record_start only after an explicit user request such as 开始录制, and call browser_record_stop when the user asks to stop or generate Python. Never record ordinary browsing by default. For independent work that can run concurrently, use spawn_agent with self-contained, non-overlapping tasks, then wait_agent before giving a final answer. Use list_agents, message_agent, and stop_agent to coordinate them. Subagents normally inherit this task's model; planner-executor collaboration routes executor agents to the configured execution model. Workspace and permissions remain shared. For remote servers, call ssh_connect with credentials explicitly supplied by the user, then use ssh_run and the SSH SFTP tools. Use ssh_upload_file to send a local file to the server and ssh_download_file to fetch a remote file to a local path; these transfer binary content directly, unlike ssh_write_file which only writes inline UTF-8 text. SSH exec sessions are non-interactive and may not load shell profiles; when a remote command depends on profile-defined PATH values, invoke the appropriate login shell explicitly. SSH host keys are not verified. Treat user credentials as secrets: pass them only to the matching credential-aware native tool, never echo them in narration, put them in a shell command, or send them to a subagent. For databases, use mysql_connect for direct MySQL access or mysql_connect_via_ssh for an SSH tunnel, then mysql_query; use ? placeholders and values for user-provided data when practical. Public direct MySQL connections use TLS by default and you must not retry with ssl=false unless the user explicitly approves. Never attempt to solve or bypass CAPTCHA, SMS, passkey, or two-factor verification. browser_snapshot waits while the user completes human verification in the visible browser and resumes automatically afterward, so do not end the task merely to ask the user to say continue. Do not claim an action succeeded until its tool result confirms it. Before finishing, compare every action requested by the user with successful tool results. A file task is complete only after a mutating tool produced an actual change; a validation is complete only after it really ran successfully after the latest change; a background service is started only after process_output confirms it is running. When the user explicitly requested a code or configuration change and successful inspection proves that change is unnecessary, call report_no_change with the specific evidence-based reason before the final response; do not manufacture a no-op edit. If the task cannot continue because the user must supply a URL, file, credential, repository target, requirement, permission, verification code, or another specific external input that cannot be discovered with the available tools, call request_user_input once with the exact question and required fields, then ask the user for them. Never use request_user_input to avoid work that the available tools can perform. For informational or status questions, answer from successful read-only evidence without calling report_no_change. If an action could not be completed, state that explicitly instead of saying it was done.${remoteWorkspaceInstruction}${activeSkills ? `\n\n${activeSkills}` : ""}${request.recoveryContext ? `\n\n<recovery_context>${request.recoveryContext}</recovery_context>\nThis task resumed after an interruption. Treat the recovery record as prior evidence. If the latest user asks only for a conclusion, status, or summary, answer directly from that evidence without repeating tool calls. If the user asks to continue execution, start with the first failed or incomplete structured plan step. Successful tools, recorded file changes, uploads, process starts, and commits are already facts; do not repeat them. Use only a minimal read-only check when it is necessary to confirm an external side effect before continuing interrupted work.` : ""}`;
  const imageInputNotice =
    omitImageInputs && hasImageAttachments(history)
      ? "\n\n当前模型不支持图片输入，历史图片附件已被省略。请只依据文字、上下文文件和工作区继续，不要假装看到了图片。"
      : "";
  const suppliedVerificationCodeNotice = hasUserSuppliedVerificationCode(
    request.messages,
  )
    ? "\n\nThe user explicitly supplied a numeric SMS, email, OTP, or 2FA code in this conversation. You may enter that supplied code with browser_type and submit it; this narrow exception is not permission to retrieve, guess, solve, or bypass any verification."
    : "";
  const localToolPathInstruction = localProjectAttached
    ? `File tool paths accept absolute paths, including other drives (for example D:\\B on Windows); use them to read or write files the user explicitly points to outside ${root}, and resolve relative paths against ${root}.`
    : `No local source is attached. Do not resolve relative local file paths against the managed SSH cache or use local tools to inspect it as source; use ssh_* tools for remote paths, and use a local absolute path only when the user explicitly supplies one.`;
  const adjustedSystem = system.replace(
    `File tool paths accept absolute paths, including other drives (for example D:\\B on Windows); use them to read or write files the user explicitly points to outside ${root}, and resolve relative paths against ${root}.`,
    localToolPathInstruction,
  );
  const projectInstructions = localProjectAttached
    ? loadProjectInstructions(root)
    : "";
  const projectInstructionsSection = projectInstructions
    ? `\n\n<project_instructions>\n${projectInstructions}\n</project_instructions>`
    : "";
  const payloadSystem = `${adjustedSystem}${recoveryPlanInstruction}${suppliedVerificationCodeNotice}${imageInputNotice}${projectInstructionsSection}${requiredToolInstruction}`;
  // Track system prompt segment changes for cache optimization analytics
  worldStateTracker.recordRound(
    buildSegments([
      { name: "identity", content: isolation.boundary },
      { name: "tools", content: "tools" }, // stable — schema is constant per request
      {
        name: "permissions",
        content: request.permissionPolicy
          ? JSON.stringify(request.permissionPolicy)
          : "",
      },
      { name: "workspace", content: root },
      { name: "skills", content: activeSkills },
      {
        name: "notices",
        content: `${suppliedVerificationCodeNotice}${imageInputNotice}`,
      },
    ]),
  );
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...isolation.headers,
  };
  if (protocol === "anthropic-messages") {
    headers["x-api-key"] = activeApiKey;
    headers["anthropic-version"] = "2023-06-01";
  } else if (protocol === "gemini-generate-content") {
    /* Gemini uses a query-string key. */
  } else headers.Authorization = `Bearer ${activeApiKey}`;
  let url = "",
    body: Record<string, unknown> = {};
  const requiredToolControl =
    requireToolCall && runtimeTools.length
      ? requiredToolChoiceForProtocol(protocol, {
          anthropicThinkingEnabled:
            reasoning.reasoningMode === "budget" && effort !== "auto",
        })
      : {};
  if (protocol === "openai-chat") {
    url = providerApiEndpoint(provider.baseUrl, protocol, "chat/completions");
    const messages: unknown[] = [{ role: "system", content: payloadSystem }];
    for (const item of payloadHistory) {
      if (item.kind === "message") {
        const content = item.images?.length
          ? [
              { type: "text", text: item.content },
              ...item.images.map((image) => ({
                type: "image_url",
                image_url: { url: image.dataUrl },
              })),
            ]
          : item.content;
        // Some OpenAI-compatible gateways reject empty assistant messages.
        if (item.role === "assistant" && !content) continue;
        messages.push({
          role: item.role,
          content,
          ...(item.role === "assistant" && item.reasoningContent
            ? { reasoning_content: item.reasoningContent }
            : {}),
        });
      } else if (item.kind === "calls") {
        const raw = item.rawCalls[0] as Record<string, unknown> | undefined;
        const message: Record<string, unknown> = {
          ...((raw?.message as Record<string, unknown> | undefined) ?? {
            role: "assistant",
            content: raw?.content,
            reasoning_content: raw?.reasoning_content,
            reasoning_details: raw?.reasoning_details,
            tool_calls: raw?.tool_calls,
          }),
          tool_calls:
            (raw?.message as Record<string, unknown> | undefined)?.tool_calls ??
            raw?.tool_calls ??
            item.calls.map((c) => ({
              id: c.id,
              type: "function",
              function: { name: c.name, arguments: JSON.stringify(c.input) },
            })),
        };
        if (!message.content) delete message.content;
        messages.push(message);
      } else
        messages.push({
          role: "tool",
          tool_call_id: item.callId,
          content: item.content,
        });
    }
    body = {
      model: request.modelId,
      ...isolation.openAi,
      messages,
      stream: true,
      stream_options: { include_usage: true },
      ...(runtimeTools.length
        ? {
            tools: runtimeTools.map((t) => ({ type: "function", function: t })),
          }
        : {}),
      ...requiredToolControl,
      reasoning_effort:
        reasoning.reasoningMode === "effort" &&
        !["auto", "thinking"].includes(effort)
          ? effort
          : undefined,
      thinking:
        reasoning.reasoningMode === "fixed"
          ? { type: "enabled" }
          : reasoning.reasoningMode === "toggle"
            ? { type: effort === "thinking" ? "enabled" : "disabled" }
            : undefined,
      reasoning_split: compatibility.splitReasoning ? true : undefined,
    };
  } else if (protocol === "openai-responses") {
    url = providerApiEndpoint(provider.baseUrl, protocol, "responses");
    const input: unknown[] = [{ role: "developer", content: payloadSystem }];
    for (const item of payloadHistory) {
      if (item.kind === "message")
        input.push({
          role: item.role,
          content: item.images?.length
            ? [
                { type: "input_text", text: item.content },
                ...item.images.map((image) => ({
                  type: "input_image",
                  image_url: image.dataUrl,
                })),
              ]
            : item.content,
        });
      else if (item.kind === "calls")
        input.push(
          ...(item.rawCalls.length
            ? item.rawCalls
            : item.calls.map((c) => ({
                type: "function_call",
                call_id: c.id,
                name: c.name,
                arguments: JSON.stringify(c.input),
              }))),
        );
      else
        input.push({
          type: "function_call_output",
          call_id: item.callId,
          output: item.content,
        });
    }
    body = {
      model: request.modelId,
      input,
      stream: true,
      ...(runtimeTools.length
        ? { tools: runtimeTools.map((t) => ({ type: "function", ...t })) }
        : {}),
      ...requiredToolControl,
      reasoning:
        reasoning.reasoningMode === "effort" &&
        !["auto", "thinking"].includes(effort)
          ? { effort }
          : undefined,
    };
  } else if (protocol === "anthropic-messages") {
    url = providerApiEndpoint(provider.baseUrl, protocol, "messages");
    const messages: { role: string; content: unknown }[] = [];
    for (const item of payloadHistory) {
      if (item.kind === "message")
        messages.push({
          role: item.role,
          content: item.images?.length
            ? [
                { type: "text", text: item.content },
                ...item.images.map((image) => ({
                  type: "image",
                  source: {
                    type: "base64",
                    media_type: image.mediaType,
                    data: base64Data(image.dataUrl),
                  },
                })),
              ]
            : item.content,
        });
      else if (item.kind === "calls")
        messages.push({
          role: "assistant",
          content: item.rawCalls.length
            ? item.rawCalls
            : item.calls.map((c) => ({
                type: "tool_use",
                id: c.id,
                name: c.name,
                input: c.input,
              })),
        });
      else
        messages.push({
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: item.callId,
              content: item.content,
            },
          ],
        });
    }
    body = {
      model: request.modelId,
      system: payloadSystem,
      messages,
      max_tokens: 4096,
      stream: true,
      thinking:
        reasoning.reasoningMode === "budget" && effort !== "auto"
          ? { type: "enabled", budget_tokens: budgets[effort] ?? 8192 }
          : undefined,
      ...(runtimeTools.length
        ? {
            tools: runtimeTools.map((t) => ({
              name: t.name,
              description: t.description,
              input_schema: t.parameters,
            })),
          }
        : {}),
      ...requiredToolControl,
    };
  } else {
    url = `${providerApiEndpoint(provider.baseUrl, protocol, `models/${encodeURIComponent(request.modelId)}:streamGenerateContent`)}?alt=sse&key=${encodeURIComponent(activeApiKey)}`;
    const contents: { role: string; parts: unknown[] }[] = [];
    for (const item of payloadHistory) {
      if (item.kind === "message")
        contents.push({
          role: item.role === "assistant" ? "model" : "user",
          parts: [
            { text: item.content },
            ...(item.images ?? []).map((image) => ({
              inlineData: {
                mimeType: image.mediaType,
                data: base64Data(image.dataUrl),
              },
            })),
          ],
        });
      else if (item.kind === "calls")
        contents.push({
          role: "model",
          parts: item.rawCalls.length
            ? item.rawCalls
            : item.calls.map((call) => ({
                functionCall: { name: call.name, args: call.input },
              })),
        });
      else {
        const call = [...payloadHistory]
          .reverse()
          .find(
            (entry) =>
              entry.kind === "calls" &&
              entry.calls.some((candidate) => candidate.id === item.callId),
          );
        const name =
          call?.kind === "calls"
            ? call.calls.find((candidate) => candidate.id === item.callId)?.name
            : undefined;
        contents.push({
          role: "user",
          parts: [
            { functionResponse: { name, response: { result: item.content } } },
          ],
        });
      }
    }
    body = {
      systemInstruction: { parts: [{ text: payloadSystem }] },
      contents,
      generationConfig:
        reasoning.reasoningMode === "budget"
          ? {
              thinkingConfig:
                effort === "auto"
                  ? undefined
                  : { thinkingBudget: budgets[effort] ?? 8192 },
            }
          : undefined,
      ...(runtimeTools.length
        ? {
            tools: [
              {
                functionDeclarations: runtimeTools.map((tool) => ({
                  name: tool.name,
                  description: tool.description,
                  parameters: tool.parameters,
                })),
              },
            ],
          }
        : {}),
      ...requiredToolControl,
    };
  }
  // Reasoning models can spend minutes thinking before the first byte arrives,
  // especially behind a third-party proxy with a large context. Keep a shorter
  // bound for regular models while progress events make either wait observable.
  const baseFirstByteTimeoutMs = finalizationTurn
    ? 90_000
    : reasoning.reasoningMode !== "none"
      ? 300_000
      : 90_000;
  const remainingBeforeFetch = remainingTurnMs();
  if (remainingBeforeFetch <= 0) throw turnTimeout();
  const firstByteTimeoutMs = Math.max(
    1,
    Math.min(baseFirstByteTimeoutMs, remainingBeforeFetch),
  );
  const serializedBody = JSON.stringify(body);
  const networkTransport = runtime?.networkTransport ?? "electron";
  const modelFetch =
    networkTransport === "direct" ? directNetworkFetch : networkFetch;
  let response: Response;
  try {
    response = await fetchWithRetry(
      url,
      {
        method: "POST",
        headers,
        body: serializedBody,
      },
      {
        signal,
        firstByteTimeoutMs,
        // streamModelTurn owns the single retry budget for both header and
        // mid-stream failures, so one broken transport cannot consume every
        // attempt before the alternate transport is tried.
        retries: 0,
        retryDelayMs: 2_000,
        maxBackoffMs: 30_000,
        fetchImpl: modelFetch,
        onProgress,
        attemptBudget,
      },
    );
  } catch (error) {
    const retryableKeyError =
      apiKeys.length > 1 && isRetryableStreamError(error);
    if (retryableKeyError)
      apiKeyCooldownPool.markUnavailable(provider.id, keyIndex);
    const nextKeyIndex = retryableKeyError ? nextApiKeyIndex() : undefined;
    if (nextKeyIndex !== undefined && !signal.aborted) {
      onProgress?.(
        `当前 API Key 暂时不可用，自动切换备用 Key（${nextKeyIndex + 1}/${apiKeys.length}）…`,
      );
      return modelTurn(
        root,
        requestId,
        request,
        history,
        signal,
        toolsEnabled,
        requireToolCall,
        onText,
        onReasoning,
        onProgress,
        protocolOverride,
        {
          provider,
          activeSkills: runtime?.activeSkills ?? "",
          workspaceBinding: runtime?.workspaceBinding,
          omitImageInputs: runtime?.omitImageInputs,
          keyIndex: nextKeyIndex,
          triedKeyIndexes: [...triedKeyIndexes],
          networkTransport,
        },
        attemptBudget,
        effectiveTurnDeadlineAt,
      );
    }
    throw error;
  }
  writeLog("info", "model.response", {
    requestId: isolation.traceId,
    taskScopeId: isolation.taskScopeId,
    conversationId: isolation.conversationId,
    providerId: request.providerId,
    modelId: request.modelId,
    protocol,
    transport: modelNetworkTransportLabel(networkTransport),
    status: response.status,
    requestBytes: Buffer.byteLength(serializedBody, "utf8"),
    toolCount: runtimeTools.length,
    historyHash: historyFingerprint(payloadHistory),
    upstreamRequestId:
      response.headers.get("x-request-id") ??
      response.headers.get("request-id") ??
      undefined,
  });
  const readBodyWithDeadline = () => {
    const remaining = remainingTurnMs();
    if (remaining <= 0) throw turnTimeout();
    return readResponseText(response, signal, undefined, remaining);
  };
  let responseErrorText: string | undefined;
  if (
    protocol === "openai-responses" &&
    !response.ok &&
    (response.status === 400 || response.status === 422)
  )
    responseErrorText = await readBodyWithDeadline();
  if (
    protocol === "openai-responses" &&
    shouldFallbackResponses(
      provider.baseUrl,
      response.status,
      responseErrorText,
    )
  ) {
    // Do not let a relay with a non-settling cancel() block protocol fallback.
    void response.body?.cancel().catch(() => undefined);
    rememberChatFallback(provider.id, request.modelId);
    void updateModelCapabilities(provider.id, request.modelId, {
      supportsResponses: false,
    });
    const compatibilityDetail = responseErrorText
      ? "（工具调用历史格式不兼容）"
      : "";
    onProgress?.(
      `Responses API 返回 ${response.status}${compatibilityDetail}，已自动切换到 Chat Completions 兼容接口…`,
    );
    writeLog("warn", "model.protocolFallback", {
      requestId: isolation.traceId,
      providerId: provider.id,
      modelId: request.modelId,
      from: "openai-responses",
      to: "openai-chat",
      status: response.status,
    });
    return modelTurn(
      root,
      requestId,
      request,
      history,
      signal,
      toolsEnabled,
      requireToolCall,
      onText,
      onReasoning,
      onProgress,
      "openai-chat",
      runtime,
      attemptBudget,
      effectiveTurnDeadlineAt,
    );
  }
  const retryableKeyStatus =
    apiKeys.length > 1 &&
    /^(401|403|408|425|429|5\d\d)$/.test(String(response.status));
  if (retryableKeyStatus)
    apiKeyCooldownPool.markUnavailable(provider.id, keyIndex);
  const nextKeyIndex = retryableKeyStatus ? nextApiKeyIndex() : undefined;
  if (!response.ok)
    if (nextKeyIndex !== undefined && !signal.aborted) {
      void response.body?.cancel().catch(() => undefined);
      onProgress?.(
        `上游返回 ${response.status}，自动切换备用 API Key（${nextKeyIndex + 1}/${apiKeys.length}）…`,
      );
      return modelTurn(
        root,
        requestId,
        request,
        history,
        signal,
        toolsEnabled,
        requireToolCall,
        onText,
        onReasoning,
        onProgress,
        protocolOverride,
        {
          provider,
          activeSkills: runtime?.activeSkills ?? "",
          workspaceBinding: runtime?.workspaceBinding,
          omitImageInputs: runtime?.omitImageInputs,
          keyIndex: nextKeyIndex,
          triedKeyIndexes: [...triedKeyIndexes],
          networkTransport,
        },
        attemptBudget,
        effectiveTurnDeadlineAt,
      );
    }
  if (!response.ok) {
    const detail = (responseErrorText ?? (await readBodyWithDeadline())).slice(
      0,
      500,
    );
    throw new UpstreamHttpError(
      response.status,
      detail,
      retryAfterMilliseconds(response),
    );
  }
  apiKeyCooldownPool.markHealthy(provider.id, keyIndex);
  if (/text\/event-stream/i.test(response.headers.get("content-type") || "")) {
    const remainingForStream = remainingTurnMs();
    if (remainingForStream <= 0) throw turnTimeout();
    return parseStreamedTurn(
      protocol,
      response,
      signal,
      onText,
      onReasoning,
      onProgress,
      reasoning.reasoningMode !== "none"
        ? REASONING_ONLY_IDLE_TIMEOUT_MS
        : undefined,
      compatibility.streamMode,
      finalizationTurn ? 45_000 : undefined,
      Math.max(
        1,
        Math.min(
          finalizationTurn
            ? FINALIZATION_TURN_MAX_DURATION_MS
            : MODEL_TURN_MAX_DURATION_MS,
          remainingForStream,
        ),
      ),
    );
  }
  if (remainingTurnMs() <= 0) throw turnTimeout();
  return parseModelResponse(protocol, JSON.parse(await readBodyWithDeadline()));
}

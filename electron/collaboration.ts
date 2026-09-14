import type {
  AgentToolName,
  ModelRequest,
  ReasoningEffort,
} from "../src/types";

const PLANNER_DISABLED_TOOLS = new Set<AgentToolName>([
  "apply_patch",
  "write_file",
  "make_directory",
  "move_path",
  "delete_path",
  "start_process",
  "process_output",
  "stop_process",
  "diagnostics",
  "browser_click",
  "browser_type",
  "browser_list_credentials",
  "browser_save_credential",
  "browser_fill_credential",
  "browser_record_start",
  "browser_record_stop",
  "ssh_connect",
  "ssh_set_workspace",
  "ssh_run",
  "ssh_list_directory",
  "ssh_read_file",
  "ssh_write_file",
  "ssh_upload_file",
  "ssh_download_file",
  "ssh_disconnect",
  "mysql_connect",
  "mysql_connect_via_ssh",
  "mysql_query",
  "mysql_disconnect",
  "sqlserver_connect",
  "sqlserver_connect_via_ssh",
  "sqlserver_query",
  "sqlserver_disconnect",
  "mongodb_connect",
  "mongodb_connect_via_ssh",
  "mongodb_execute",
  "mongodb_disconnect",
  "credential_save",
  "credential_forget",
  "run_command",
  "mcp_call_tool",
]);

const REMOTE_PLANNER_READ_TOOLS = new Set<AgentToolName>([
  "ssh_list_directory",
  "ssh_read_file",
]);

// Hybrid mode: an SSH Remote task keeps its LOCAL file/git/command tools AND
// the ssh_* tools, so the agent can read/build local sources (D:\... absolute
// paths) and deploy to the server in one task. Only the managed-session control
// tools stay disabled — letting the model re-target or drop the managed SSH
// session mid-task, or open competing via_ssh tunnels, would break recovery.
const REMOTE_WORKSPACE_DISABLED_TOOLS = new Set<AgentToolName>([
  "ssh_set_workspace",
  "ssh_disconnect",
  "mysql_connect_via_ssh",
  "sqlserver_connect_via_ssh",
  "mongodb_connect_via_ssh",
]);

export function isPlannerCoordinator(
  request: Pick<ModelRequest, "agentRole" | "collaboration">,
) {
  return (
    request.agentRole === "planner" &&
    request.collaboration?.mode === "planner-executor"
  );
}

export function plannerToolAllowed(
  tool: AgentToolName,
  managedSshRemote = false,
) {
  return (
    !PLANNER_DISABLED_TOOLS.has(tool) ||
    (managedSshRemote && REMOTE_PLANNER_READ_TOOLS.has(tool))
  );
}

export function remoteWorkspaceToolAllowed(tool: AgentToolName) {
  return !REMOTE_WORKSPACE_DISABLED_TOOLS.has(tool);
}

export function executorModelOverrides(
  request: Pick<ModelRequest, "agentRole" | "collaboration">,
):
  | {
      providerId: string;
      modelId: string;
      displayName: string;
      reasoningEffort: ReasoningEffort;
      contextWindow?: number;
      agentRole: "executor";
      collaboration: undefined;
    }
  | undefined {
  if (!isPlannerCoordinator(request)) return undefined;
  const target = request.collaboration!.executor;
  return {
    providerId: target.providerId,
    modelId: target.modelId,
    displayName: target.displayName,
    reasoningEffort: target.reasoningEffort ?? "auto",
    contextWindow: target.contextWindow,
    agentRole: "executor",
    collaboration: undefined,
  };
}

export function plannerCollaborationInstruction(request: ModelRequest) {
  if (!isPlannerCoordinator(request)) return "";
  const executor = request.collaboration!.executor;
  return `You are the planning and review coordinator in a two-model workflow. The configured executor is ${executor.displayName} (${executor.modelId}).
Workflow (in order):
1) Inspect with read-only tools only.
2) Call update_plan with a concise checklist, acceptance criteria, and per-step requires (use [] only for pure explanation steps).
3) Call spawn_agent once with role "executor". Put the full plan, paths, constraints, and required validation into its task. Do not implement changes yourself.
4) Call wait_agent once for that executor (or omit agentIds to wait for any direct child). Prefer longer waits (minutes); timeout_ms defaults to 5 minutes and may be set up to 1 hour. A timeout does not stop the executor — wait again only when list_agents shows real progress.
5) Review the executor's tool evidence, diffs, and validation results before answering the user. Never claim the plan was implemented without successful executor evidence.
If execution is incomplete: message_agent with a precise correction while it is still running, or after collecting its result spawn one focused follow-up executor. Do not emit one wait call per child in the same model turn.`;
}

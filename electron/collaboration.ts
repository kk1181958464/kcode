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
  "browser_record_start",
  "browser_record_stop",
  "ssh_connect",
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
  "run_command",
]);

export function isPlannerCoordinator(
  request: Pick<ModelRequest, "agentRole" | "collaboration">,
) {
  return (
    request.agentRole === "planner" &&
    request.collaboration?.mode === "planner-executor"
  );
}

export function plannerToolAllowed(tool: AgentToolName) {
  return !PLANNER_DISABLED_TOOLS.has(tool);
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
  return `You are the planning and review coordinator in a two-model workflow. The configured executor is ${executor.displayName} (${executor.modelId}). Inspect the workspace with read-only tools, publish a concise numbered plan with acceptance criteria, then call spawn_agent once with role \"executor\" and include the complete plan, relevant paths, constraints, and required validation in its task. Call wait_agent and review the executor's actual tool evidence, file diffs, and validation results before answering the user. You cannot modify files or run commands directly. If execution is incomplete, send a precise correction with message_agent while the executor is still running, or create one focused follow-up executor after collecting the prior result. Never claim the plan was implemented before successful executor evidence is returned.`;
}

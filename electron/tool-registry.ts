import { randomUUID } from "node:crypto";
import type { AgentToolName } from "../src/types";

export type ToolDescriptor = {
  name: AgentToolName;
  category:
    "read" | "write" | "command" | "network" | "browser" | "agent" | "other";
  supportsProgress: boolean;
};

export type ToolCallTrace = {
  callId: string;
  requestId: string;
  activityId: string;
  tool: AgentToolName;
  input: Record<string, unknown>;
  startedAt: number;
  status: "running" | "waiting" | "success" | "failed" | "denied" | "cancelled";
  lastProgress?: string;
  completedAt?: number;
};

export type ToolLifecycleListener = (
  event:
    | { type: "started"; trace: ToolCallTrace }
    | { type: "status"; trace: ToolCallTrace }
    | { type: "progress"; trace: ToolCallTrace; output: string }
    | { type: "completed"; trace: ToolCallTrace }
    | { type: "failed"; trace: ToolCallTrace; error: string },
) => void;

const descriptor = (
  name: AgentToolName,
  category: ToolDescriptor["category"],
  supportsProgress = false,
): ToolDescriptor => ({ name, category, supportsProgress });

const descriptors: ToolDescriptor[] = [
  descriptor("list_directory", "read"),
  descriptor("glob_files", "read"),
  descriptor("read_many_files", "read"),
  descriptor("path_info", "read"),
  descriptor("read_file", "read"),
  descriptor("search_code", "read"),
  descriptor("git_status", "read"),
  descriptor("git_remote_status", "network"),
  descriptor("git_diff", "read"),
  descriptor("git_log", "read"),
  descriptor("git_show", "read"),
  descriptor("apply_patch", "write"),
  descriptor("write_file", "write"),
  descriptor("make_directory", "write"),
  descriptor("move_path", "write"),
  descriptor("delete_path", "write"),
  descriptor("run_command", "command", true),
  descriptor("start_process", "command", true),
  descriptor("process_output", "command", true),
  descriptor("stop_process", "command", true),
  descriptor("diagnostics", "command", true),
  descriptor("web_search", "network", true),
  descriptor("fetch_url", "network", true),
  descriptor("mcp_list_tools", "network", true),
  descriptor("mcp_call_tool", "network", true),
  descriptor("browser_open", "browser", true),
  descriptor("browser_snapshot", "browser", true),
  descriptor("browser_click", "browser", true),
  descriptor("browser_type", "browser", true),
  descriptor("browser_fill_credential", "browser", true),
  descriptor("browser_screenshot", "browser", true),
  descriptor("browser_record_start", "browser", true),
  descriptor("browser_record_stop", "browser", true),
  descriptor("ssh_connect", "network", true),
  descriptor("ssh_set_workspace", "network", true),
  descriptor("ssh_run", "command", true),
  descriptor("ssh_list_directory", "network", true),
  descriptor("ssh_read_file", "network", true),
  descriptor("ssh_write_file", "write", true),
  descriptor("ssh_upload_file", "write", true),
  descriptor("ssh_download_file", "write", true),
  descriptor("ssh_disconnect", "network"),
  descriptor("mysql_connect", "network", true),
  descriptor("mysql_connect_via_ssh", "network", true),
  descriptor("mysql_query", "write", true),
  descriptor("mysql_disconnect", "network"),
  descriptor("sqlserver_connect", "network", true),
  descriptor("sqlserver_connect_via_ssh", "network", true),
  descriptor("sqlserver_query", "write", true),
  descriptor("sqlserver_disconnect", "network"),
  descriptor("mongodb_connect", "network", true),
  descriptor("mongodb_connect_via_ssh", "network", true),
  descriptor("mongodb_execute", "write", true),
  descriptor("mongodb_disconnect", "network"),
  descriptor("credential_list", "read"),
  descriptor("browser_list_credentials", "browser"),
  descriptor("browser_save_credential", "browser"),
  descriptor("credential_save", "write"),
  descriptor("credential_forget", "write"),
  descriptor("spawn_agent", "agent", true),
  descriptor("list_agents", "agent"),
  descriptor("message_agent", "agent", true),
  descriptor("wait_agent", "agent", true),
  descriptor("stop_agent", "agent", true),
  descriptor("update_plan", "other"),
  descriptor("report_no_change", "other"),
  descriptor("request_user_input", "other"),
];

const descriptorByName = new Map(descriptors.map((item) => [item.name, item]));

export class ToolRegistry {
  private readonly traces = new Map<string, ToolCallTrace>();
  private readonly listeners = new Set<ToolLifecycleListener>();

  descriptor(name: AgentToolName): ToolDescriptor {
    return descriptorByName.get(name) ?? descriptor(name, "other", false);
  }

  subscribe(listener: ToolLifecycleListener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  start(input: {
    requestId: string;
    activityId: string;
    tool: AgentToolName;
    args: Record<string, unknown>;
    startedAt?: number;
  }) {
    const trace: ToolCallTrace = {
      callId: randomUUID(),
      requestId: input.requestId,
      activityId: input.activityId,
      tool: input.tool,
      input: input.args,
      startedAt: input.startedAt ?? Date.now(),
      status: "running",
    };
    this.traces.set(trace.callId, trace);
    this.publish({ type: "started", trace });
    return trace;
  }

  markWaiting(callId: string) {
    const trace = this.traces.get(callId);
    if (!trace) return;
    trace.status = "waiting";
    this.publish({ type: "status", trace });
  }

  markRunning(callId: string) {
    const trace = this.traces.get(callId);
    if (!trace) return;
    trace.status = "running";
    this.publish({ type: "status", trace });
  }

  progress(callId: string, output: string) {
    const trace = this.traces.get(callId);
    if (!trace || !output || trace.lastProgress === output) return;
    trace.lastProgress = output;
    this.publish({ type: "progress", trace, output });
  }

  finish(callId: string, status: ToolCallTrace["status"] = "success") {
    const trace = this.traces.get(callId);
    if (!trace) return;
    trace.status = status;
    trace.completedAt = Date.now();
    if (status === "failed" || status === "denied" || status === "cancelled")
      this.publish({
        type: "failed",
        trace,
        error: trace.lastProgress || status,
      });
    else this.publish({ type: "completed", trace });
    this.traces.delete(callId);
  }

  fail(callId: string, error: string, cancelled = false) {
    const trace = this.traces.get(callId);
    if (!trace) return;
    trace.status = cancelled ? "cancelled" : "failed";
    trace.completedAt = Date.now();
    this.publish({ type: "failed", trace, error });
    this.traces.delete(callId);
  }

  active(requestId?: string) {
    return [...this.traces.values()].filter(
      (trace) => !requestId || trace.requestId === requestId,
    );
  }

  clearRequest(requestId: string) {
    for (const [callId, trace] of this.traces)
      if (trace.requestId === requestId) this.traces.delete(callId);
  }

  private publish(event: Parameters<ToolLifecycleListener>[0]) {
    for (const listener of this.listeners) listener(event);
  }
}

export const toolRegistry = new ToolRegistry();

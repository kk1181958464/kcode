import { backgroundProcessManager } from "./background-process-manager";
import type { ToolResult } from "./agent-types";

export type ProcessToolManager = {
  start(
    root: string,
    requestId: string,
    script: string,
  ): Promise<{ id: string }>;
  get(
    id: string,
    root: string,
  ): { output: string; exitCode?: number };
  stop(id: string, root: string): Promise<void>;
};

export async function executeProcessTool(
  root: string,
  requestId: string,
  name: string,
  input: Record<string, unknown>,
  manager: ProcessToolManager = backgroundProcessManager,
): Promise<ToolResult> {
  if (name === "start_process") {
    const script = String(input.command || "");
    const { id } = await manager.start(root, requestId, script);
    return {
      command: script,
      output: `后台进程已创建，需读取进程输出确认运行状态\nprocessId: ${id}`,
      executed: true,
      operationEvidence: ["execute"],
    };
  }
  if (name === "process_output") {
    const id = String(input.processId || "");
    const process = manager.get(id, root);
    return {
      output: `${process.exitCode === undefined ? "状态: 运行中" : `状态: 已退出 (${process.exitCode})`}\n${process.output || "暂无输出"}`,
      exitCode: process.exitCode === undefined ? undefined : process.exitCode,
      executed: true,
      operationEvidence: ["execute"],
    };
  }
  if (name === "stop_process") {
    const id = String(input.processId || "");
    await manager.stop(id, root);
    return {
      output: `后台进程 ${id} 已停止`,
      executed: true,
      operationEvidence: ["execute"],
    };
  }
  throw new Error(`不支持的进程工具：${name}`);
}

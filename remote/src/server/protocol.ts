export type ClientType = "desktop" | "mobile";

export type RemoteCommand =
  | { type: "task.load"; taskId: string }
  | { type: "task.send"; taskId: string; content: string }
  | { type: "task.cancel"; taskId: string }
  | {
      type: "task.approve";
      taskId: string;
      requestId: string;
      activityId: string;
      allowed: boolean;
    };

export type RemoteTaskSnapshot = {
  id: string;
  name: string;
  workspaceName: string;
  createdAt: number;
  updatedAt: number;
  runningId?: string;
  runStatus?: string;
  modelSelection?: string;
  messages: Array<{
    id: string;
    role: "user" | "assistant";
    content: string;
    error?: string;
    createdAt: number;
    model?: string;
    imageCount?: number;
  }>;
  activities: Array<{
    id: string;
    requestId: string;
    tool: string;
    status: string;
    title: string;
    narrative?: string;
    planSteps?: string[];
    planStep?: number;
    startedAt: number;
    completedAt?: number;
    path?: string;
    additions?: number;
    deletions?: number;
    exitCode?: number;
    errorSummary?: string;
  }>;
  usage?: { input: number; output: number; cached: number };
  durationMs?: number;
  archived?: boolean;
};

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

export function stringValue(
  value: unknown,
  name: string,
  max = 256,
  allowEmpty = false,
) {
  if (typeof value !== "string") throw new Error(`${name} 格式无效`);
  const result = value.trim();
  if ((!allowEmpty && !result) || result.length > max)
    throw new Error(`${name} 格式无效`);
  return result;
}

export function parseClientType(value: unknown): ClientType {
  if (value !== "desktop" && value !== "mobile")
    throw new Error("客户端类型无效");
  return value;
}

export function parseRemoteCommand(value: unknown): RemoteCommand {
  if (!isRecord(value)) throw new Error("远程命令格式无效");
  const type = stringValue(value.type, "命令类型", 64);
  const taskId = stringValue(value.taskId, "任务 ID");
  if (type === "task.load") return { type, taskId };
  if (type === "task.send")
    return {
      type,
      taskId,
      content: stringValue(value.content, "消息", 20_000),
    };
  if (type === "task.cancel") return { type, taskId };
  if (type === "task.approve") {
    if (typeof value.allowed !== "boolean") throw new Error("审批结果无效");
    return {
      type,
      taskId,
      requestId: stringValue(value.requestId, "请求 ID"),
      activityId: stringValue(value.activityId, "活动 ID"),
      allowed: value.allowed,
    };
  }
  throw new Error("不支持的远程命令");
}

export function parseTaskSnapshots(value: unknown): RemoteTaskSnapshot[] {
  if (!Array.isArray(value) || value.length > 500)
    throw new Error("任务快照格式无效");
  const encoded = JSON.stringify(value);
  if (Buffer.byteLength(encoded, "utf8") > 12 * 1024 * 1024)
    throw new Error("任务快照超过 12 MB 限制");
  return value.map((task) => {
    if (!isRecord(task)) throw new Error("任务快照格式无效");
    stringValue(task.id, "任务 ID");
    stringValue(task.name, "任务名称", 256);
    if (!Array.isArray(task.messages) || !Array.isArray(task.activities))
      throw new Error("任务内容格式无效");
    return task as RemoteTaskSnapshot;
  });
}

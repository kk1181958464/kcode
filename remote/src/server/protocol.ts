export type ClientType = "desktop" | "mobile";

const MAX_CONTEXT_FILES = 9;
const MAX_CONTEXT_FILE_BYTES = 512 * 1024;
const MAX_CONTEXT_TOTAL_BYTES = 2 * 1024 * 1024;
const MAX_IMAGE_FILES = 9;
const MAX_IMAGE_FILE_BYTES = 5 * 1024 * 1024;
const MAX_REMOTE_ATTACHMENT_BYTES = 7 * 1024 * 1024;
const IMAGE_MEDIA_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
]);
type ImageMediaType = "image/png" | "image/jpeg" | "image/webp" | "image/gif";

export type RemoteAttachments = {
  images?: Array<{
    id: string;
    name: string;
    mediaType: ImageMediaType;
    dataUrl: string;
    size: number;
  }>;
  files?: Array<{
    id: string;
    name: string;
    content: string;
    size: number;
  }>;
};

export type RemoteCommand =
  | { type: "task.load"; taskId: string }
  | {
      type: "task.send";
      taskId: string;
      content: string;
      clientMessageId?: string;
      attachments?: RemoteAttachments;
    }
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
  runtimeStatus?: string;
  modelSelection?: string;
  executorModelSelection?: string;
  messages: Array<{
    id: string;
    role: "user" | "assistant";
    content: string;
    error?: string;
    createdAt: number;
    completedAt?: number;
    finalResponseOffset?: number;
    finalResponseStartedAt?: number;
    finalResponseProcess?: "correction";
    model?: string;
    imageCount?: number;
    files?: Array<{ name: string; size: number }>;
  }>;
  activities: Array<{
    id: string;
    requestId: string;
    tool: string;
    toolCallId?: string;
    status: string;
    title: string;
    narrative?: string;
    textOffset?: number;
    subagentId?: string;
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

function optionalText(value: unknown, name: string, max: number) {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length > max)
    throw new Error(`${name} 格式无效`);
  return value;
}

function parseAttachmentName(value: unknown) {
  const name = stringValue(value, "附件名称", 240).replace(/^.*[\\/]/, "");
  if (!name) throw new Error("附件名称格式无效");
  return name;
}

function parseRemoteAttachments(value: unknown): RemoteAttachments | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error("附件格式无效");
  const rawImages = value.images ?? [];
  const rawFiles = value.files ?? [];
  if (!Array.isArray(rawImages) || rawImages.length > MAX_IMAGE_FILES)
    throw new Error(`每条消息最多上传 ${MAX_IMAGE_FILES} 张图片`);
  if (!Array.isArray(rawFiles) || rawFiles.length > MAX_CONTEXT_FILES)
    throw new Error(`每条消息最多上传 ${MAX_CONTEXT_FILES} 个文件`);

  const seen = new Set<string>();
  let totalBytes = 0;
  const images = rawImages.map((item) => {
    if (!isRecord(item)) throw new Error("图片附件格式无效");
    const id = stringValue(item.id, "附件 ID", 128);
    if (seen.has(id)) throw new Error("附件 ID 重复");
    seen.add(id);
    const name = parseAttachmentName(item.name);
    const mediaType = stringValue(item.mediaType, "图片类型", 32);
    if (!IMAGE_MEDIA_TYPES.has(mediaType)) throw new Error("图片类型不支持");
    const dataUrl = optionalText(item.dataUrl, "图片数据", 10 * 1024 * 1024);
    const prefix = `data:${mediaType};base64,`;
    if (!dataUrl?.startsWith(prefix)) throw new Error(`${name} 的图片数据无效`);
    const encoded = dataUrl.slice(prefix.length);
    if (
      !encoded ||
      encoded.length % 4 === 1 ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)
    )
      throw new Error(`${name} 的图片数据无效`);
    const size = Buffer.from(encoded, "base64").byteLength;
    if (size <= 0 || size > MAX_IMAGE_FILE_BYTES)
      throw new Error(`${name} 超过 5 MB 或图片数据无效`);
    totalBytes += size;
    return {
      id,
      name,
      mediaType: mediaType as ImageMediaType,
      dataUrl,
      size,
    };
  });

  let fileBytes = 0;
  const files = rawFiles.map((item) => {
    if (!isRecord(item)) throw new Error("文件附件格式无效");
    const id = stringValue(item.id, "附件 ID", 128);
    if (seen.has(id)) throw new Error("附件 ID 重复");
    seen.add(id);
    const name = parseAttachmentName(item.name);
    const content = optionalText(
      item.content,
      "文件内容",
      MAX_CONTEXT_FILE_BYTES,
    );
    if (content === undefined || content.includes("\0"))
      throw new Error(`${name} 不是有效的文本文件`);
    const size = Buffer.byteLength(content, "utf8");
    if (size > MAX_CONTEXT_FILE_BYTES) throw new Error(`${name} 超过 512 KB`);
    fileBytes += size;
    if (fileBytes > MAX_CONTEXT_TOTAL_BYTES)
      throw new Error("上下文文件总量超过 2 MB");
    totalBytes += size;
    return { id, name, content, size };
  });
  if (totalBytes > MAX_REMOTE_ATTACHMENT_BYTES)
    throw new Error("附件总量超过 7 MB");
  if (!images.length && !files.length) return undefined;
  return {
    images: images.length ? images : undefined,
    files: files.length ? files : undefined,
  };
}

export function parseRemoteCommand(value: unknown): RemoteCommand {
  if (!isRecord(value)) throw new Error("远程命令格式无效");
  const type = stringValue(value.type, "命令类型", 64);
  const taskId = stringValue(value.taskId, "任务 ID");
  if (type === "task.load") return { type, taskId };
  if (type === "task.send") {
    const content = stringValue(value.content, "消息", 20_000, true);
    const clientMessageId =
      value.clientMessageId === undefined
        ? undefined
        : stringValue(value.clientMessageId, "消息 ID", 128);
    const attachments = parseRemoteAttachments(value.attachments);
    if (!content && !attachments) throw new Error("消息或附件不能为空");
    return {
      type,
      taskId,
      content,
      ...(clientMessageId ? { clientMessageId } : {}),
      ...(attachments ? { attachments } : {}),
    };
  }
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

export function parseRemoteTaskEvent(value: unknown) {
  if (
    !isRecord(value) ||
    value.type !== "task.event" ||
    value.event !== "stream"
  )
    throw new Error("实时事件格式无效");
  const updatedAt = Number(value.updatedAt);
  if (!Number.isFinite(updatedAt) || updatedAt <= 0)
    throw new Error("实时事件时间无效");
  const sequence = value.sequence === undefined ? 0 : Number(value.sequence);
  if (!Number.isInteger(sequence) || sequence < 0)
    throw new Error("实时事件序号无效");
  const runtimeSequence =
    value.runtimeSequence === undefined
      ? undefined
      : Number(value.runtimeSequence);
  if (
    runtimeSequence !== undefined &&
    (!Number.isInteger(runtimeSequence) || runtimeSequence < 0)
  )
    throw new Error("运行事件序号无效");
  const runtimeProtocolVersion =
    value.runtimeProtocolVersion === undefined
      ? undefined
      : Number(value.runtimeProtocolVersion);
  if (
    runtimeProtocolVersion !== undefined &&
    (!Number.isInteger(runtimeProtocolVersion) ||
      runtimeProtocolVersion < 1 ||
      runtimeProtocolVersion > 100)
  )
    throw new Error("运行协议版本无效");
  const reasoning = optionalText(value.reasoning, "实时思考", 8_000);
  const progress = optionalText(value.progress, "实时状态", 1_000);
  const runtimeEventId = optionalText(
    value.runtimeEventId,
    "运行事件 ID",
    256,
  );
  const runtimeEventKind = optionalText(
    value.runtimeEventKind,
    "运行事件类型",
    128,
  );
  const runtimeItemStatus = optionalText(
    value.runtimeItemStatus,
    "运行项目状态",
    64,
  );
  return {
    type: "task.event" as const,
    event: "stream" as const,
    taskId: stringValue(value.taskId, "任务 ID"),
    requestId: stringValue(value.requestId, "请求 ID"),
    sequence,
    content: optionalText(value.content, "实时正文", 96_000) ?? "",
    ...(reasoning === undefined ? {} : { reasoning }),
    ...(progress === undefined ? {} : { progress }),
    ...(runtimeEventId === undefined ? {} : { runtimeEventId }),
    ...(runtimeEventKind === undefined ? {} : { runtimeEventKind }),
    ...(runtimeItemStatus === undefined ? {} : { runtimeItemStatus }),
    ...(runtimeSequence === undefined ? {} : { runtimeSequence }),
    ...(runtimeProtocolVersion === undefined
      ? {}
      : { runtimeProtocolVersion }),
    updatedAt,
  };
}

export function remoteCommandAuditPayload(command: RemoteCommand) {
  if (command.type !== "task.send" || !command.attachments) return command;
  return {
    ...command,
    attachments: {
      images: command.attachments.images?.map(
        ({ dataUrl: _dataUrl, ...metadata }) => metadata,
      ),
      files: command.attachments.files?.map(
        ({ content: _content, ...metadata }) => metadata,
      ),
    },
  };
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

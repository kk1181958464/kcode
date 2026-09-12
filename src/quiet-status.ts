export type QuietStatusKind =
  | "waiting-model"
  | "retrying"
  | "compacting"
  | "waiting-subagents"
  | "recovering";

const KIND_LABEL: Record<QuietStatusKind, string> = {
  "waiting-model": "等待模型",
  retrying: "正在重连",
  compacting: "整理上下文",
  "waiting-subagents": "等待子任务",
  recovering: "正在恢复",
};

export function classifyQuietStatus(message: string): QuietStatusKind | undefined {
  const value = message.trim();
  if (!value) return undefined;
  if (/子 Agent|子任务|wait_agent|未完成的子/.test(value))
    return "waiting-subagents";
  if (/整理上下文|压缩上下文|交接摘要|context_compaction|接近预算/.test(value))
    return "compacting";
  if (/重连|重试|切换.*通道|备用直连|上游连接中断/.test(value)) return "retrying";
  if (/自动恢复|收尾|纠偏|更换执行策略|要求它|要求模型/.test(value))
    return "recovering";
  if (/正在|等待|生成|调用|检查/.test(value)) return "waiting-model";
  return "waiting-model";
}

export function quietStatusLabel(kind: QuietStatusKind) {
  return KIND_LABEL[kind];
}

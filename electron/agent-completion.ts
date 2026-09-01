import type { AgentCompletionResult, AgentFileTransfer } from "../src/types";

export type ToolEvidenceSummary = {
  toolCalls: number;
  successfulTools: number;
  failedTools: number;
  changedFiles: string[];
  transfers?: AgentFileTransfer[];
  additions: number;
  deletions: number;
};

type CompletionInput = {
  requestedOperations: Iterable<string>;
  observedOperations: Iterable<string>;
  missingOperations: Iterable<string>;
  evidence: ToolEvidenceSummary;
  waitingForUser: boolean;
  verifiedNoChange: boolean;
};

const operationLabels: Record<string, string> = {
  "coding:modify": "实际修改",
  "coding:execute": "执行命令",
  "coding:validate": "修改后验证",
  "coding:connect": "建立远程连接",
  "coding:upload": "上传文件",
  "coding:download": "下载文件",
  "browser:open": "打开网页",
  "browser:type": "填写网页",
  "browser:click": "点击网页",
  "browser:verify": "交互后页面验证",
  "git:commit": "Git 提交",
  "git:push": "Git 推送",
  "git:release": "触发发布",
  "agent:spawn_executor": "启动执行模型",
  "plan:requirements": "补齐结构化计划要求",
  "plan:pending": "完成结构化计划中的待办步骤",
};

function uniqueSorted(values: Iterable<string>) {
  return [...new Set(values)].sort();
}

function uniqueTransfers(values: Iterable<AgentFileTransfer>) {
  const transfers = new Map<string, AgentFileTransfer>();
  for (const transfer of values) {
    const key = `${transfer.direction}:${transfer.source}:${transfer.destination}`;
    transfers.set(key, transfer);
  }
  return [...transfers.values()];
}

function missingEvidenceNotice(missing: readonly string[]) {
  const labels = missing.map(
    (operation) => operationLabels[operation] ?? operation,
  );
  return `未检测到${labels.join("、")}的成功运行记录。已保留模型回答，但没有把这些操作标记为完成。`;
}

/**
 * Produces the completion state from runtime facts only. Assistant prose never
 * participates in this decision, so phrases such as "已实现" cannot create or
 * erase execution evidence.
 */
export function buildAgentCompletionResult(
  input: CompletionInput,
): AgentCompletionResult {
  const requestedOperations = uniqueSorted(input.requestedOperations);
  const operations = uniqueSorted(input.observedOperations);
  const missingOperations = uniqueSorted(input.missingOperations);
  const transfers = uniqueTransfers(input.evidence.transfers ?? []);

  let kind: AgentCompletionResult["kind"];
  if (input.waitingForUser) kind = "blocked";
  else if (missingOperations.length) kind = "incomplete";
  else if (input.verifiedNoChange) kind = "no_change";
  else if (
    input.evidence.changedFiles.length > 0 ||
    operations.includes("coding:modify")
  )
    kind = "changed";
  else if (input.evidence.successfulTools > 0) kind = "executed";
  else kind = "answer";

  return {
    kind,
    operations,
    missingOperations,
    toolCalls: input.evidence.toolCalls,
    successfulTools: input.evidence.successfulTools,
    failedTools: input.evidence.failedTools,
    changedFiles: uniqueSorted(input.evidence.changedFiles),
    ...(transfers.length ? { transfers } : {}),
    additions: input.evidence.additions,
    deletions: input.evidence.deletions,
    notice:
      kind === "incomplete"
        ? missingEvidenceNotice(missingOperations)
        : kind === "blocked" && requestedOperations.length
          ? "任务正在等待必要的用户输入，已有运行记录和回答均已保留。"
          : undefined,
  };
}

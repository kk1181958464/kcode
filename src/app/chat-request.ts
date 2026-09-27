import { type TaskRecord } from "../models";
import {
  serializeDesignElementsForAgent,
  type DesignElementContext,
} from "../design-mode";
import type { ChatMessage, ContextFile } from "../types";

type ChatHistoryOptions = {
  nextMessages: ChatMessage[];
  compactedCount: number;
  contextByMessage: Map<string, ContextFile[]>;
  designByMessage: Map<string, DesignElementContext[]>;
  resumingInterruptedRun: boolean;
  currentUserId: string;
  requestSummary?: string;
  requestLedger?: TaskRecord["contextLedger"];
  retainedContext: string;
};

export function buildChatHistory({
  nextMessages,
  compactedCount,
  contextByMessage,
  designByMessage,
  resumingInterruptedRun,
  currentUserId,
  requestSummary,
  requestLedger,
  retainedContext,
}: ChatHistoryOptions) {
  const requestMessages = nextMessages.slice(compactedCount);
  const history = requestMessages.map(({ id, role, content, images }) => {
    const files = role === "user" ? (contextByMessage.get(id) ?? []) : [];
    const designs = role === "user" ? (designByMessage.get(id) ?? []) : [];
    const fileContext = files
      .map(
        (file) =>
          `<context_file name="${file.name}">\n${file.content}\n</context_file>`,
      )
      .join("\n\n");
    const designContext = serializeDesignElementsForAgent(designs);
    const recoveryNotice =
      resumingInterruptedRun && role === "user" && id === currentUserId
        ? "\n\n<interrupted_turn_recovery>上一轮被停止、暂停或中断。已有助手输出和持久化工具证据仍然有效。若当前要求是总结或给出结论，请直接基于已有结果回答，不要重新执行整轮检查；若要求继续，优先依据恢复检查点中的计划，从第一个失败或未完成步骤接着做。成功工具、文件修改、上传、启动和提交都不得重复；仅在确有必要时做最小的只读核验。</interrupted_turn_recovery>"
        : "";
    return {
      role,
      content: `${[fileContext ? `${content}\n\n${fileContext}` : content, designContext].filter(Boolean).join("\n\n")}${recoveryNotice}`,
      images,
    };
  });
  if (requestSummary) {
    history.unshift({
      role: "user",
      content: `<conversation_summary>\n这是较早对话的压缩检查点，由另一个模型交接而来。请延续其中的目标、约束、决策、已验证结果与未完成步骤，不要重复已经完成的工作：\n${requestSummary}\n${requestLedger ? `\n<fact_ledger>${JSON.stringify(requestLedger)}</fact_ledger>` : ""}\n</conversation_summary>`,
      images: undefined,
    });
  }
  if (retainedContext) {
    history.unshift({
      role: "user",
      content: retainedContext,
      images: undefined,
    });
  }
  return history;
}

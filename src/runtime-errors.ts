export type RuntimeErrorKind =
  | "authentication"
  | "rate_limit"
  | "provider_unavailable"
  | "transport"
  | "timeout"
  | "invalid_request"
  | "tool_failure"
  | "cancelled"
  | "unknown";

export type RuntimeErrorClassification = {
  kind: RuntimeErrorKind;
  retryable: boolean;
  userAction: "retry" | "change_provider" | "provide_input" | "none";
};

/** Normalize provider, transport, and tool errors before they reach a UI. */
export function classifyRuntimeError(raw: string): RuntimeErrorClassification {
  const value = raw.trim();
  if (/任务已停止|任务已取消|操作已停止|aborted|aborterror/i.test(value))
    return { kind: "cancelled", retryable: false, userAction: "none" };
  if (/invalid (api )?key|unauthorized|401|认证失败|api.?key 无效/i.test(value))
    return {
      kind: "authentication",
      retryable: false,
      userAction: "change_provider",
    };
  if (/400|bad request|invalid content|参数无效|请求格式/i.test(value))
    return {
      kind: "invalid_request",
      retryable: false,
      userAction: "provide_input",
    };
  if (/429|rate.?limit|too many requests|频率限制|服务繁忙/i.test(value))
    return { kind: "rate_limit", retryable: true, userAction: "retry" };
  if (/超时|timed? ?out|ETIMEDOUT|等待响应/i.test(value))
    return { kind: "timeout", retryable: true, userAction: "retry" };
  if (
    /ERR_|ECONN|socket|\bstream\b|chunked|connection|连接中断|断流/i.test(value)
  )
    return { kind: "transport", retryable: true, userAction: "retry" };
  if (
    /502|503|504|bad gateway|service unavailable|upstream|网关|上游/i.test(
      value,
    )
  )
    return {
      kind: "provider_unavailable",
      retryable: true,
      userAction: "change_provider",
    };
  if (/工具|命令|tool|exit\s*[=:]\s*[1-9]|执行失败/i.test(value))
    return {
      kind: "tool_failure",
      retryable: false,
      userAction: "provide_input",
    };
  return { kind: "unknown", retryable: false, userAction: "retry" };
}

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

// Some providers send this as an SSE error inside an HTTP 200 response.
export function isTransientGenerationError(message: string): boolean {
  return /\binternal (?:server )?error during (?:token|response) generation\b/i.test(
    message,
  );
}

/** Relays can report a mid-stream disconnect as an error inside HTTP 200. */
export function isPrematureStreamEndError(message: string): boolean {
  return /\bstream\s+(?:ended|closed|terminated|disconnected)\s+(?:before\s+completion|prematurely)\b/i.test(
    message,
  );
}

/** Structured provider codes take priority over ambiguous message wording. */
export function classifyStructuredRuntimeError(
  raw: unknown,
): RuntimeErrorClassification | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const error = raw as {
    code?: unknown;
    type?: unknown;
    status?: unknown;
    name?: unknown;
  };
  const codes = [error.code, error.type]
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.toLowerCase());
  const matches = (...values: string[]) =>
    codes.some((code) => values.includes(code));
  if (
    error.name === "AbortError" ||
    matches("cancelled", "canceled", "aborted")
  )
    return { kind: "cancelled", retryable: false, userAction: "none" };
  if (
    error.status === 401 ||
    error.status === 403 ||
    matches(
      "authentication_error",
      "invalid_api_key",
      "unauthorized",
      "permission_error",
      "permission_denied",
    )
  )
    return {
      kind: "authentication",
      retryable: false,
      userAction: "change_provider",
    };
  if (
    matches(
      "insufficient_quota",
      "billing_hard_limit_reached",
      "credit_balance_too_low",
    )
  )
    return {
      kind: "provider_unavailable",
      retryable: false,
      userAction: "change_provider",
    };
  if (
    matches(
      "invalid_request_error",
      "invalid_argument",
      "context_length_exceeded",
      "model_not_found",
      "not_found_error",
      "request_too_large",
    )
  )
    return {
      kind: "invalid_request",
      retryable: false,
      userAction: "provide_input",
    };
  if (
    error.status === 429 ||
    matches(
      "rate_limit_error",
      "rate_limit_exceeded",
      "rate_limit",
      "resource_exhausted",
    )
  )
    return { kind: "rate_limit", retryable: true, userAction: "retry" };
  if (
    error.status === 408 ||
    matches("timeout_error", "request_timeout", "deadline_exceeded")
  )
    return { kind: "timeout", retryable: true, userAction: "retry" };
  if (
    error.status === 425 ||
    (typeof error.status === "number" &&
      error.status >= 500 &&
      error.status <= 599) ||
    matches(
      "server_error",
      "internal_error",
      "internal_server_error",
      "overloaded_error",
      "api_error",
      "unavailable",
    )
  )
    return {
      kind: "provider_unavailable",
      retryable: true,
      userAction: "retry",
    };
  if (
    typeof error.status === "number" &&
    error.status >= 400 &&
    error.status < 500
  )
    return {
      kind: "invalid_request",
      retryable: false,
      userAction: "provide_input",
    };
  if (matches("stream_incomplete", "incomplete_stream"))
    return { kind: "transport", retryable: true, userAction: "retry" };
  return undefined;
}

/** Normalize provider, transport, and tool errors before they reach a UI. */
export function classifyRuntimeError(raw: unknown): RuntimeErrorClassification {
  const structured = classifyStructuredRuntimeError(raw);
  if (structured) return structured;
  const message =
    raw && typeof raw === "object" && "message" in raw ? raw.message : raw;
  const value = String(message).trim();
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
  if (isTransientGenerationError(value))
    return {
      kind: "provider_unavailable",
      retryable: true,
      userAction: "retry",
    };
  if (/超时|timed? ?out|ETIMEDOUT|等待响应/i.test(value))
    return { kind: "timeout", retryable: true, userAction: "retry" };
  if (
    /ERR_|ECONN|socket|\bstream\b|chunked|connection|连接中断|连接失败|网络连接|断流|已安全暂停|没有返回完成或错误状态/i.test(
      value,
    )
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

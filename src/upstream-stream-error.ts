type ErrorRecord = Record<string, unknown>;

function record(value: unknown): ErrorRecord | undefined {
  return value !== null && typeof value === "object"
    ? (value as ErrorRecord)
    : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

/** Preserve useful provider metadata without retaining the response payload. */
export class UpstreamStreamError extends Error {
  readonly code?: string | number;
  readonly type?: string;
  readonly status?: number;
  readonly param?: string;
  readonly requestId?: string;
  readonly eventType?: string;

  constructor(event: ErrorRecord) {
    const response = record(event.response);
    const detail = record(event.error) ?? record(response?.error) ?? event;
    super(
      text(detail.message) ??
        text(event.error) ??
        text(event.message) ??
        "模型流式请求失败",
    );
    this.name = "UpstreamStreamError";
    this.code =
      typeof detail.code === "string" || typeof detail.code === "number"
        ? detail.code
        : undefined;
    this.type = text(detail.type);
    this.status = [
      detail.status,
      detail.status_code,
      event.status,
      this.code,
    ].find(
      (status): status is number =>
        typeof status === "number" &&
        Number.isInteger(status) &&
        status >= 400 &&
        status <= 599,
    );
    this.param = text(detail.param);
    this.requestId = text(event.request_id) ?? text(detail.request_id);
    this.eventType = text(event.type);
  }
}

export function upstreamStreamError(
  event: unknown,
): UpstreamStreamError | undefined {
  const value = record(event);
  if (!value) return undefined;
  if (value.error || value.type === "error" || value.type === "response.failed")
    return new UpstreamStreamError(value);
  return undefined;
}

export type ModelNetworkTransport = "electron" | "direct";

export function networkTransportErrorText(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause = (error as Error & { cause?: unknown }).cause;
  if (!cause) return error.message;
  const causeText = cause instanceof Error ? cause.message : String(cause);
  return `${error.message}: ${causeText}`;
}

export function isChromiumNetworkTransportError(error: unknown) {
  return /\bnet::ERR_[A-Z0-9_]+\b/i.test(networkTransportErrorText(error));
}

export function isDirectNetworkTransportError(error: unknown) {
  return /fetch failed|\bterminated\b|UND_ERR_[A-Z0-9_]+|other side closed|socket disconnected|ECONNRESET|EPIPE/i.test(
    networkTransportErrorText(error),
  );
}

export function nextModelNetworkTransport(
  current: ModelNetworkTransport,
  error: unknown,
): ModelNetworkTransport {
  if (current === "electron" && isChromiumNetworkTransportError(error))
    return "direct";
  if (current === "direct" && isDirectNetworkTransportError(error))
    return "electron";
  return current;
}

export function modelNetworkTransportLabel(transport: ModelNetworkTransport) {
  return transport === "electron" ? "electron" : "node-direct";
}

type Listener = () => void;

const values = new Map<string, string>();
const listeners = new Map<string, Set<Listener>>();

export const streamingReasoningKey = (requestId: string) =>
  `reasoning:${requestId}`;

function emit(requestId: string) {
  for (const listener of listeners.get(requestId) ?? []) listener();
}

export function getStreamingText(requestId: string) {
  return values.get(requestId) ?? "";
}

export function appendStreamingText(requestId: string, delta: string) {
  if (!delta) return;
  values.set(requestId, getStreamingText(requestId) + delta);
  emit(requestId);
}

export function resetStreamingText(requestId: string) {
  if (!values.has(requestId)) return;
  values.delete(requestId);
  emit(requestId);
}

export function consumeStreamingText(requestId: string) {
  const value = getStreamingText(requestId);
  values.delete(requestId);
  return value;
}

export function subscribeStreamingText(requestId: string, listener: Listener) {
  const current = listeners.get(requestId) ?? new Set<Listener>();
  current.add(listener);
  listeners.set(requestId, current);
  return () => {
    current.delete(listener);
    if (!current.size) listeners.delete(requestId);
  };
}

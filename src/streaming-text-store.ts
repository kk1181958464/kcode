export type StreamingTextChange =
  | { type: "append"; delta: string }
  | { type: "replace"; value: string }
  | { type: "reset" };
type Listener = (change: StreamingTextChange) => void;

const values = new Map<string, string[]>();
const lengths = new Map<string, number>();
const listeners = new Map<string, Set<Listener>>();
const STORE_CHUNK_LIMIT = 4_096;

export const streamingReasoningKey = (requestId: string) =>
  `reasoning:${requestId}`;
export const streamingProgressKey = (requestId: string) =>
  `progress:${requestId}`;

function emit(requestId: string, change: StreamingTextChange) {
  for (const listener of listeners.get(requestId) ?? []) listener(change);
}

export function getStreamingText(requestId: string) {
  return values.get(requestId)?.join("") ?? "";
}

export function getStreamingTextTail(requestId: string, maxChars: number) {
  const chunks = values.get(requestId) ?? [];
  const totalLength = lengths.get(requestId) ?? 0;
  if (maxChars <= 0 || !chunks.length) return { text: "", totalLength };
  let remaining = maxChars;
  const tail: string[] = [];
  for (let index = chunks.length - 1; index >= 0 && remaining > 0; index--) {
    const chunk = chunks[index];
    if (chunk.length <= remaining) {
      tail.push(chunk);
      remaining -= chunk.length;
    } else {
      let start = chunk.length - remaining;
      // Do not cut between the two UTF-16 code units of an emoji.
      if (
        start > 0 &&
        /[\uDC00-\uDFFF]/.test(chunk[start]) &&
        /[\uD800-\uDBFF]/.test(chunk[start - 1])
      )
        start -= 1;
      tail.push(chunk.slice(start));
      remaining = 0;
    }
  }
  return { text: tail.reverse().join(""), totalLength };
}

export function appendStreamingText(requestId: string, delta: string) {
  if (!delta) return;
  const chunks = values.get(requestId);
  if (chunks) {
    const last = chunks.at(-1) ?? "";
    if (last.length + delta.length <= STORE_CHUNK_LIMIT)
      chunks[chunks.length - 1] = last + delta;
    else chunks.push(delta);
  } else values.set(requestId, [delta]);
  lengths.set(requestId, (lengths.get(requestId) ?? 0) + delta.length);
  emit(requestId, { type: "append", delta });
}

export function replaceStreamingText(requestId: string, value: string) {
  if (!value) {
    resetStreamingText(requestId);
    return;
  }
  values.set(requestId, [value]);
  lengths.set(requestId, value.length);
  emit(requestId, { type: "replace", value });
}

export function resetStreamingText(requestId: string) {
  if (!values.has(requestId)) return;
  values.delete(requestId);
  lengths.delete(requestId);
  emit(requestId, { type: "reset" });
}

export function consumeStreamingText(requestId: string) {
  const value = getStreamingText(requestId);
  const consumed = values.delete(requestId);
  lengths.delete(requestId);
  if (consumed) emit(requestId, { type: "reset" });
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

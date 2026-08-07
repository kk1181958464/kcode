/** Accepts only strictly newer sequenced events while allowing legacy events. */
export function acceptStreamSequence(
  sequences: Map<string, number>,
  streamId: string,
  sequence?: number,
) {
  if (sequence === undefined) return true;
  if (!Number.isSafeInteger(sequence) || sequence <= 0) return false;
  const previous = sequences.get(streamId) ?? 0;
  if (sequence <= previous) return false;
  sequences.set(streamId, sequence);
  return true;
}

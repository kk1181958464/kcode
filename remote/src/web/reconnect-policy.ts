const RECONNECT_DELAYS_MS = [500, 1_000, 2_000, 3_000, 5_000, 8_000, 12_000];

export function reconnectDelay(attempt: number, online = true) {
  if (!online) return undefined;
  const index = Math.max(
    0,
    Math.min(RECONNECT_DELAYS_MS.length - 1, Math.floor(attempt)),
  );
  return RECONNECT_DELAYS_MS[index];
}


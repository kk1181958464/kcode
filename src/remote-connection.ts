export const REMOTE_SUPERSEDED_CLOSE_CODE = 4001;

export function shouldReconnectRemote(
  enabled: boolean,
  stopped: boolean,
  closeCode?: number,
) {
  return enabled && !stopped && closeCode !== REMOTE_SUPERSEDED_CLOSE_CODE;
}

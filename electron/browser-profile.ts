export const SHARED_BROWSER_PARTITION = "persist:kcode-browser";

/**
 * Browser pages remain isolated by session id in memory, while authentication
 * storage is shared like a normal browser profile. The page session id is
 * intentionally ignored so new tasks do not look like new devices to sites.
 */
export function browserStoragePartition(_pageSessionId?: string) {
  return SHARED_BROWSER_PARTITION;
}

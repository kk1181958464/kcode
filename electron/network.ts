import { net } from "electron";

/** Electron's network stack follows the app proxy configuration. */
export const networkFetch: typeof fetch = (input, init) =>
  net.fetch(typeof input === "string" ? input : input.toString(), init);

/**
 * Direct Node transport used only as a fallback when Chromium's URL loader
 * repeatedly drops an otherwise valid model response stream.
 */
export const directNetworkFetch: typeof fetch = (input, init) =>
  globalThis.fetch(input, init);

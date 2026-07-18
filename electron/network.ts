import { net } from "electron";

/** Electron's network stack follows the app proxy configuration. */
export const networkFetch: typeof fetch = (input, init) =>
  net.fetch(typeof input === "string" ? input : input.toString(), init);
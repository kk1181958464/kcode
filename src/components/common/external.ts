// Opens an http(s) URL in the user's system browser via the Electron shell
// bridge. No-ops for non-web URLs so it is safe to call on arbitrary text.
export function openExternalUrl(url: string) {
  if (!/^https?:\/\//i.test(url)) return;
  void window.kcode?.shell?.openExternal(url);
}

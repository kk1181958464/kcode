export function openExternalUrl(url: string) {
  if (!/^https?:\/\//i.test(url)) return;
  void window.kcode?.shell?.openExternal(url);
}

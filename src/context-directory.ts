export function contextDialogDirectory(
  taskDirectory?: string,
  defaultDirectory?: string,
) {
  return taskDirectory?.trim() || defaultDirectory?.trim() || undefined;
}

export function directoryFromFilePath(filePath: string) {
  const value = filePath.trim().replace(/[\\/]+$/, "");
  const separator = Math.max(value.lastIndexOf("\\"), value.lastIndexOf("/"));
  if (separator < 0) return undefined;
  if (separator === 0) return value[0];
  if (separator === 2 && /^[a-z]:[\\/]/i.test(value)) return value.slice(0, 3);
  return value.slice(0, separator);
}

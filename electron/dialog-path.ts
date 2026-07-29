import { stat } from "node:fs/promises";
import path from "node:path";
import { workspacePathSchema } from "./ipc-validation";

export async function existingDirectory(rawDirectory?: string) {
  const requestedDirectory = workspacePathSchema.optional().parse(rawDirectory);
  if (!requestedDirectory) return undefined;
  const candidate = path.resolve(requestedDirectory);
  try {
    return (await stat(candidate)).isDirectory() ? candidate : undefined;
  } catch {
    return undefined;
  }
}

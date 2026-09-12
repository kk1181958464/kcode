import { statSync } from "node:fs";
import path from "node:path";
import { downloadSshFile, listSshDirectory, readSshFile, uploadSshFile, writeSshFile } from "./ssh";
import { resolveSshWorkspacePath } from "./ssh-remote-path";

export type SshFileOperationContext = {
  root: string;
  browserSessionId: string;
  requestId: string;
  activityId: string;
  toolName: string;
  input: Record<string, unknown>;
  signal: AbortSignal;
  remoteRootPath?: string;
  onProgress?: (output: string) => void;
  diffFor: (file: string, before: string, after: string) => {
    diff: string;
    additions: number;
    deletions: number;
  };
};

function localPath(root: string, value: unknown) {
  const raw = String(value || "");
  return path.resolve(root, raw);
}

function remotePath(ctx: SshFileOperationContext, value: unknown, fallback = "") {
  const raw = String(value || fallback);
  return ctx.remoteRootPath && raw
    ? resolveSshWorkspacePath(ctx.remoteRootPath, raw)
    : raw;
}

export async function executeSshFileOperation(ctx: SshFileOperationContext) {
  const { browserSessionId, requestId, activityId, signal, input } = ctx;
  switch (ctx.toolName) {
    case "ssh_list_directory": {
      const requestedPath = remotePath(ctx, input.path, ".");
      return { path: requestedPath, output: JSON.stringify(await listSshDirectory(browserSessionId, requestId, requestedPath, signal), null, 2) };
    }
    case "ssh_read_file": {
      const requestedPath = remotePath(ctx, input.path);
      return { path: requestedPath, output: await readSshFile(browserSessionId, requestId, requestedPath, signal) };
    }
    case "ssh_write_file": {
      const requestedPath = remotePath(ctx, input.path);
      const result = await writeSshFile(browserSessionId, requestId, activityId, requestedPath, String(input.content ?? ""), signal);
      return { path: requestedPath, output: `已原子写入远程文件，共 ${result.bytes} 字节`, changed: result.before !== result.after, undoable: true, ...ctx.diffFor(requestedPath, result.before, result.after) };
    }
    case "ssh_upload_file": {
      const local = localPath(ctx.root, input.localPath);
      statSync(local);
      const remote = remotePath(ctx, input.remotePath);
      const result = await uploadSshFile(browserSessionId, requestId, local, remote, signal, ctx.onProgress);
      return { path: remote, output: `已上传本地文件到远程 ${remote}，共 ${result.bytes} 字节`, changed: true };
    }
    case "ssh_download_file": {
      const remote = remotePath(ctx, input.remotePath);
      const local = localPath(ctx.root, input.localPath);
      const result = await downloadSshFile(browserSessionId, requestId, remote, local, signal);
      return { path: local, output: `已下载远程文件到本地 ${local}，共 ${result.bytes} 字节`, changed: true };
    }
    default: return undefined;
  }
}

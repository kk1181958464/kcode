import type { SshRemoteProfile } from "../src/ssh-remote-types";

export type WorkspacePromptRemote = Pick<
  SshRemoteProfile,
  "host" | "port" | "username" | "rootPath"
>;

export type WorkspacePromptInput = {
  executionRoot: string;
  localWorkspacePath?: string;
  remoteWorkspace?: WorkspacePromptRemote;
};

function clean(value: string | undefined, maxLength = 32_767) {
  const trimmed = value
    ?.replace(/[\u0000-\u001f\u007f]/g, " ")
    .trim();
  return trimmed ? trimmed.slice(0, maxLength) : undefined;
}

function display(value: string) {
  return clean(value)?.replaceAll("`", "'").replaceAll('"', "'") || "";
}

function quoted(value: string) {
  return `"${display(value)}"`;
}

export function effectiveLocalWorkspacePath({
  executionRoot,
  localWorkspacePath,
  remoteWorkspace,
}: WorkspacePromptInput) {
  return (
    clean(localWorkspacePath) ||
    (!remoteWorkspace ? clean(executionRoot) : undefined)
  );
}

/**
 * Stable routing instructions for a task that may have both local and SSH
 * roots. Keeping this in one prompt block prevents a later SSH connection
 * from making the model guess which directory contains the source.
 */
export function buildWorkspaceLocationInstruction(
  input: WorkspacePromptInput,
) {
  const executionRoot = clean(input.executionRoot) || input.executionRoot;
  const localRoot = effectiveLocalWorkspacePath(input);
  const remote = input.remoteWorkspace;
  const lines = ["<workspace_locations>"];

  if (localRoot)
    lines.push(
      `LOCAL PROJECT ROOT (this computer): ${quoted(localRoot)}. Use local file, search, edit, Git, run_command, and start_process tools against this project. Start inspection at this exact path; do not scan drive roots, Desktop, Downloads, or unrelated directories to guess where the project is.`,
    );
  else if (remote)
    lines.push(
      `LOCAL PROJECT ROOT: none is attached. ${quoted(executionRoot)} is only KCode's managed local cache for this SSH task, not the user's source. Do not search local disks to guess a project that was not supplied.`,
    );
  else
    lines.push(
      `LOCAL PROJECT ROOT (this computer): ${quoted(executionRoot)}. Use this exact path for local file, search, edit, Git, run_command, and start_process tools; do not scan other directories to guess the project.`,
    );

  if (remote) {
    lines.push(
      `REMOTE PROJECT ROOT (SSH server): ${display(remote.username)}@${display(remote.host)}:${remote.port} at ${quoted(remote.rootPath)}. Use ssh_* tools for this root. Never send a remote path to a local tool or treat the SSH cache as the remote source.`,
    );
    lines.push(
      "These roots are independent. When both are needed, inspect or modify local source with local tools first, then transfer explicitly with ssh_upload_file or ssh_download_file.",
    );
  }

  lines.push("</workspace_locations>");
  return lines.join("\n");
}

export function buildRuntimeWorkspaceBindingInstruction(
  localWorkspacePath: string | undefined,
  remote: WorkspacePromptRemote,
) {
  const localRoot = clean(localWorkspacePath);
  return [
    "<runtime_workspace_binding>",
    "An SSH connection is now active for this task. Connecting SSH did not replace the local project context; keep these roots separate.",
    localRoot
      ? `LOCAL source on this computer: ${quoted(localRoot)}`
      : "LOCAL source: none is attached; do not search local disks to invent one.",
    `REMOTE source on the SSH server: ${display(remote.username)}@${display(remote.host)}:${remote.port} at ${quoted(remote.rootPath)}`,
    "Routing: local file/search/edit/Git/run_command/start_process tools -> LOCAL; ssh_* tools -> REMOTE. Use ssh_upload_file or ssh_download_file for an explicit transfer. Do not scan drive roots, Desktop, Downloads, or the remote home to guess the other root.",
    "</runtime_workspace_binding>",
  ].join("\n");
}

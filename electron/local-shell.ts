import { powershellCommand } from "./powershell-command";

export type LocalShellInvocation = {
  executable: string;
  args: string[];
  label: string;
};

export function localShellInvocation(
  script: string,
  platform: NodeJS.Platform = process.platform,
): LocalShellInvocation {
  if (platform === "win32")
    return {
      executable: "powershell.exe",
      args: [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        powershellCommand(script),
      ],
      label: "Windows PowerShell 5.1",
    };
  return {
    executable: "/bin/sh",
    args: ["-lc", script],
    label: "POSIX shell (/bin/sh)",
  };
}

export function localShellToolDescription(
  background = false,
  platform: NodeJS.Platform = process.platform,
) {
  const action = background ? "Start a long-running" : "Run a";
  if (platform === "win32")
    return `${action} Windows PowerShell 5.1 command in the workspace. This is not Bash: do not use <<EOF heredocs or &&/|| chains.`;
  return `${action} POSIX shell command in the workspace using /bin/sh -lc. This is not PowerShell: use POSIX paths, quoting, environment assignments, and command chaining.`;
}

export function localShellPromptInstruction(
  platform: NodeJS.Platform = process.platform,
) {
  if (platform === "win32")
    return "run_command uses Windows PowerShell 5.1, not Bash. Never use <<EOF heredocs or &&/|| chains; use a PowerShell here-string for multiline stdin and check $LASTEXITCODE explicitly when chaining native commands.";
  return "run_command uses a fresh POSIX shell through /bin/sh -lc, not PowerShell. Use POSIX paths, quoting, environment assignments, and &&/|| when commands depend on each other.";
}

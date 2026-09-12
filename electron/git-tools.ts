import { resolveGitExecutable } from "./executables";
import { parseGitRemoteHead, validateGitBranchName, validateGitRemoteName } from "./git-remote-status";
import { isNotGitRepositoryOutput } from "./git-operation-verification";

type Command = (root: string, executable: string, args: string[], signal: AbortSignal, timeout?: number) => Promise<{ output: string; exitCode: number }>;
export async function executeGitTool(root: string, name: string, input: Record<string, unknown>, signal: AbortSignal, command: Command) {
  const git = resolveGitExecutable();
  if (name === "git_status") {
    const result = await command(root, git, ["status", "--short", "--branch"], signal, 15_000);
    if (result.exitCode) return isNotGitRepositoryOutput(result.output) ? { output: "当前工作区未初始化 Git：该目录不是 Git 仓库。", executed: true } : Promise.reject(new Error(result.output || "Git 状态读取失败"));
    return { output: result.output || "工作区无变更" };
  }
  if (name === "git_diff") {
    const args = ["diff", "--no-ext-diff"]; if (input.staged) args.push("--cached"); if (input.path) args.push("--", String(input.path));
    const result = await command(root, git, args, signal, 20_000);
    if (result.exitCode) throw new Error(result.output || "Git diff 读取失败"); return { output: result.output || "没有差异" };
  }
  if (name === "git_log") {
    const limit = Math.min(50, Math.max(1, Number(input.limit) || 10));
    const result = await command(root, git, ["log", `-${limit}`, "--date=short", "--pretty=format:%h %ad %s (%an)"], signal, 15_000);
    if (result.exitCode) throw new Error(result.output || "Git 日志读取失败"); return { output: result.output || "没有提交记录" };
  }
  if (name === "git_show") {
    const revision = String(input.revision || ""); if (!revision || !/^[\w./~^:-]+$/.test(revision)) throw new Error("Git revision 格式无效");
    const spec = input.path ? `${revision}:${String(input.path).replaceAll("\\", "/")}` : revision;
    const result = await command(root, git, ["show", "--no-ext-diff", "--format=fuller", spec], signal, 20_000);
    if (result.exitCode) throw new Error(result.output || "Git 内容读取失败"); return { output: result.output };
  }
  if (name === "git_remote_status") {
    const remote = validateGitRemoteName(String(input.remote || "")); let branch = String(input.branch || "").trim();
    if (!branch) { const result = await command(root, git, ["branch", "--show-current"], signal, 10_000); if (result.exitCode) throw new Error(result.output || "Git 当前分支读取失败"); branch = result.output.trim(); if (!branch) throw new Error("当前处于 detached HEAD，请明确指定要校验的远端分支"); }
    branch = validateGitBranchName(branch);
    const local = await command(root, git, ["rev-parse", "HEAD"], signal, 10_000); if (local.exitCode) throw new Error(local.output || "Git 本地提交读取失败");
    const remoteResult = await command(root, git, ["ls-remote", "--exit-code", "--refs", remote, `refs/heads/${branch}`], signal, 30_000); if (remoteResult.exitCode) throw new Error(remoteResult.output || `远端 ${remote} 未找到分支 ${branch}`);
    const localHead = parseGitRemoteHead(local.output); const remoteHead = parseGitRemoteHead(remoteResult.output);
    return { output: JSON.stringify({ remote, branch, localHead, remoteHead, synchronized: localHead === remoteHead }, null, 2), executed: true };
  }
  throw new Error(`不支持的 Git 工具：${name}`);
}

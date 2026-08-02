const remotePattern = /^[0-9A-Za-z._-]+$/;
const branchPattern = /^[0-9A-Za-z._/-]+$/;

export function validateGitRemoteName(value: string) {
  const remote = value.trim() || "origin";
  if (
    !remotePattern.test(remote) ||
    remote.startsWith("-") ||
    remote.includes("..")
  )
    throw new Error("Git 远端名称无效");
  return remote;
}

export function validateGitBranchName(value: string) {
  const branch = value.trim();
  if (
    !branch ||
    !branchPattern.test(branch) ||
    branch.startsWith("-") ||
    branch.startsWith("/") ||
    branch.endsWith("/") ||
    branch.includes("..") ||
    branch.includes("//")
  )
    throw new Error("Git 分支名称无效");
  return branch;
}

export function parseGitRemoteHead(output: string) {
  const hash = output.trim().split(/\s+/)[0] || "";
  if (!/^[0-9a-f]{40,64}$/i.test(hash))
    throw new Error("远端未返回有效的提交编号");
  return hash.toLowerCase();
}

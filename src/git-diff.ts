function normalizePath(value: string) {
  return value
    .trim()
    .replace(/^['"]|['"]$/g, "")
    .replace(/^a\//, "")
    .replace(/^b\//, "")
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .toLowerCase();
}

function matchesPath(candidate: string, target: string) {
  const left = normalizePath(candidate);
  const right = normalizePath(target);
  return (
    left === right || left.endsWith(`/${right}`) || right.endsWith(`/${left}`)
  );
}

/** Extract one file's section from a standard `git diff` document. */
export function extractGitFileDiff(text: string, filePath: string) {
  if (!text.trim() || !filePath.trim()) return "";
  const chunks = text.split(/(?=^diff --git )/m);
  for (const chunk of chunks) {
    if (!/^diff --git /m.test(chunk)) continue;
    const paths = [...chunk.matchAll(/^(?:--- a\/|\+\+\+ b\/)(.+)$/gm)].map(
      (match) => match[1],
    );
    if (paths.some((candidate) => matchesPath(candidate, filePath)))
      return chunk.trim();
  }
  return "";
}

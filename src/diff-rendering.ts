export type DiffLineKind = "meta" | "hunk" | "add" | "del" | "context";

export const DIFF_VIRTUALIZATION_THRESHOLD = 600;

export function classifyDiffLine(line: string): DiffLineKind {
  if (line.startsWith("+++") || line.startsWith("---")) return "meta";
  if (line.startsWith("@@")) return "hunk";
  if (line.startsWith("+")) return "add";
  if (line.startsWith("-")) return "del";
  if (line.startsWith("diff ") || line.startsWith("index ")) return "meta";
  return "context";
}

export function shouldVirtualizeDiff(lineCount: number, virtualize: boolean) {
  return virtualize && lineCount > DIFF_VIRTUALIZATION_THRESHOLD;
}

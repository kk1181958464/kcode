export type GitFileChangeStat = {
  path: string;
  additions: number;
  deletions: number;
};

const count = (value: string) => Number(value) || 0;

export function parseGitNumstat(output: string): GitFileChangeStat[] {
  const changes: GitFileChangeStat[] = [];
  let cursor = 0;
  while (cursor < output.length) {
    const recordEnd = output.indexOf("\0", cursor);
    if (recordEnd < 0) break;
    const record = output.slice(cursor, recordEnd);
    cursor = recordEnd + 1;
    const firstTab = record.indexOf("\t");
    const secondTab = record.indexOf("\t", firstTab + 1);
    if (firstTab < 0 || secondTab < 0) continue;

    let filePath = record.slice(secondTab + 1);
    if (!filePath) {
      const oldPathEnd = output.indexOf("\0", cursor);
      if (oldPathEnd < 0) break;
      cursor = oldPathEnd + 1;
      const newPathEnd = output.indexOf("\0", cursor);
      if (newPathEnd < 0) break;
      filePath = output.slice(cursor, newPathEnd);
      cursor = newPathEnd + 1;
    }
    if (!filePath) continue;
    changes.push({
      path: filePath.replaceAll("\\", "/"),
      additions: count(record.slice(0, firstTab)),
      deletions: count(record.slice(firstTab + 1, secondTab)),
    });
  }
  return changes;
}

export function countTextLines(content: Buffer): number | undefined {
  if (content.includes(0)) return undefined;
  const normalized = content.toString("utf8").replace(/\r\n?/g, "\n");
  if (!normalized) return 0;
  const lines = normalized.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines.length;
}

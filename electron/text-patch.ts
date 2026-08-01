export function normalizeLineEndings(value: string) {
  return value.replace(/\r\n|\r/g, "\n");
}

function preferredLineEnding(value: string) {
  const crlfCount = value.match(/\r\n/g)?.length ?? 0;
  const withoutCrlf = value.replace(/\r\n/g, "");
  const lfCount = withoutCrlf.match(/\n/g)?.length ?? 0;
  const crCount = withoutCrlf.match(/\r/g)?.length ?? 0;
  if (crlfCount >= lfCount && crlfCount >= crCount && crlfCount > 0)
    return "\r\n";
  if (crCount > lfCount) return "\r";
  return "\n";
}

export function applyUpdatePatch(original: string, lines: readonly string[]) {
  const lineEnding = preferredLineEnding(original);
  const bom = original.startsWith("\uFEFF") ? "\uFEFF" : "";
  const source = normalizeLineEndings(original.slice(bom.length)).split("\n");
  let cursor = 0;
  const output: string[] = [];

  for (const line of lines) {
    if (line.startsWith("@@")) continue;
    const marker = line[0];
    const value = line.slice(1);
    if (marker === " ") {
      const index = source.indexOf(value, cursor);
      if (index < 0) throw new Error(`补丁上下文不匹配：${value}`);
      output.push(...source.slice(cursor, index + 1));
      cursor = index + 1;
    } else if (marker === "-") {
      const index = source.indexOf(value, cursor);
      if (index < 0) throw new Error(`补丁删除内容不匹配：${value}`);
      output.push(...source.slice(cursor, index));
      cursor = index + 1;
    } else if (marker === "+") output.push(value);
    else if (line) throw new Error(`无法识别的补丁行：${line}`);
  }

  output.push(...source.slice(cursor));
  return bom + output.join(lineEnding);
}

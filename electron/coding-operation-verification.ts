export type CodingOperation = "inspect" | "modify" | "validate";

export type CodingVerificationHistoryItem =
  | { kind: "message"; role: "user" | "assistant"; content: string }
  | {
      kind: "calls";
      calls: {
        id: string;
        name: string;
        input: Record<string, unknown>;
      }[];
    }
  | { kind: "result"; callId: string; content: string };

type VerificationMessage = Extract<
  CodingVerificationHistoryItem,
  { kind: "message" }
>;

function latestUserContent(history: CodingVerificationHistoryItem[]) {
  return (
    [...history]
      .reverse()
      .find(
        (item): item is VerificationMessage =>
          item.kind === "message" && item.role === "user",
      )?.content ?? ""
  );
}

/** Operations the latest user explicitly expects the coding agent to perform. */
export function requestedCodingOperations(
  history: CodingVerificationHistoryItem[],
) {
  const content = latestUserContent(history);
  const operations = new Set<CodingOperation>();
  if (
    /(?:看下|查看|检查|排查|审查|分析|定位|找出|读取|搜索|确认|过一下)|\b(?:inspect|check|review|analy[sz]e|read|search|investigate)\b/i.test(
      content,
    )
  )
    operations.add("inspect");
  if (
    /(?:改一下|修改|修复|解决|优化|适配|增加|新增|添加|删除|移除|重构|实现|落地|调整|替换|设计一下|开始改|弄一下)|\b(?:edit|change|modify|fix|implement|add|remove|refactor|optimi[sz]e|update)\b/i.test(
      content,
    )
  )
    operations.add("modify");
  if (
    /(?:验证|测试|检查构建|类型检查|构建|打包)|\b(?:verify|test|typecheck|lint|build)\b/i.test(
      content,
    )
  )
    operations.add("validate");
  return operations;
}

/**
 * Kimi K3 may answer coding requests with prose when OpenAI Chat leaves
 * tool_choice at its default "auto". Require its first native tool call for
 * explicit coding work; after every requested operation has successful native
 * evidence, normal auto selection is restored so the model can finish naturally.
 */
export function shouldRequireCodingTool(
  modelId: string,
  requested: ReadonlySet<CodingOperation>,
  evidence: ReadonlySet<CodingOperation>,
) {
  return (
    /(?:^|[\W_])kimi[.-]?k3(?:$|[\W_])/i.test(modelId) &&
    [...requested].some((operation) => !evidence.has(operation))
  );
}

/** Operations the assistant claims have already happened in its final text. */
export function claimedCodingOperations(text: string) {
  const operations = new Set<CodingOperation>();
  if (
    /(?:已|已经|完成|实际).{0,18}(?:检查|查看|读取|搜索|排查|审查|分析|确认|定位)|(?:检查|读取|搜索|排查|审查|分析).{0,12}(?:完成|通过|结果)|\b(?:inspected|checked|reviewed|analyzed|read|searched)\b/i.test(
      text,
    )
  )
    operations.add("inspect");
  if (
    /(?:已|已经|完成|成功|落地).{0,24}(?:修改|改造|修复|优化|适配|新增|添加|删除|移除|重构|实现|替换|调整)|(?:修改|改动|改造|修复|优化|适配|实现|调整)(?:文件|范围|集中|位于|涉及|如下|完成)|修改文件\s*[:：]|\b(?:modified|edited|changed|fixed|implemented|updated)\b/i.test(
      text,
    )
  )
    operations.add("modify");
  if (
    /(?:类型检查|测试|构建|生产构建|lint|typecheck).{0,14}(?:通过|成功|完成)|(?:通过|成功).{0,10}(?:类型检查|测试|构建)|\b(?:tests?|typecheck|lint|build)\s+(?:passed|succeeded|completed)\b/i.test(
      text,
    )
  )
    operations.add("validate");
  return operations;
}

function successfulCallIds(history: CodingVerificationHistoryItem[]) {
  const ids = new Set<string>();
  for (const item of history) {
    if (item.kind !== "result") continue;
    try {
      const result = JSON.parse(item.content) as { success?: boolean };
      if (result.success) ids.add(item.callId);
    } catch {
      // Unstructured legacy output cannot prove that an operation succeeded.
    }
  }
  return ids;
}

/** Successful native tool results generated during this Agent run. */
export function successfulCodingEvidence(
  history: CodingVerificationHistoryItem[],
) {
  const successful = successfulCallIds(history);
  const operations = new Set<CodingOperation>();
  const inspectTools = new Set([
    "list_directory",
    "glob_files",
    "read_many_files",
    "path_info",
    "read_file",
    "search_code",
    "git_status",
    "git_diff",
    "git_log",
    "git_show",
  ]);
  const modifyTools = new Set([
    "apply_patch",
    "write_file",
    "make_directory",
    "move_path",
    "delete_path",
  ]);
  for (const item of history) {
    if (item.kind !== "calls") continue;
    for (const call of item.calls) {
      if (!successful.has(call.id)) continue;
      if (inspectTools.has(call.name)) operations.add("inspect");
      if (modifyTools.has(call.name)) operations.add("modify");
      if (call.name === "diagnostics") operations.add("validate");
      if (call.name !== "run_command") continue;
      const command = String(call.input.command ?? "");
      if (/\b(?:cat|type|findstr|rg|grep|git\s+(?:status|diff|log|show))\b/i.test(command))
        operations.add("inspect");
      if (
        /(?:>|set-content|add-content|out-file)|\b(?:sed|perl|python|node)\b.{0,80}(?:write|replace)|\bgit\s+(?:checkout|restore|apply)\b/i.test(
          command,
        )
      )
        operations.add("modify");
      if (
        /\b(?:npm|pnpm|yarn)\s+(?:test|run\s+(?:test|typecheck|lint|build))\b|\b(?:vitest|jest|pytest|phpunit|go\s+test|cargo\s+test|tsc)\b/i.test(
          command,
        )
      )
        operations.add("validate");
    }
  }
  return operations;
}

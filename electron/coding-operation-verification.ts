export type CodingOperation =
  | "inspect"
  | "modify"
  | "execute"
  | "validate"
  | "connect"
  | "upload"
  | "download";

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

const CONTINUATION_REQUEST =
  /^(?:好|好的|可以|行|继续|继续吧|开始|开始吧|开始弄吧|开始改吧|改吧|修吧|做吧|弄吧|执行吧|就这么做|按(?:你|上面|这个).{0,12}做|都弄|都改|全部(?:做|弄|改|修改)|上面(?:的)?全部(?:做|弄|改|修改))(?:了|吧|啊|呀)?[。！!，,\s]*$/i;

export function isAdvisoryOnlyRequest(content: string) {
  const normalized = content.replace(/\s+/g, "");
  if (
    /只说不改|只讲不改|(?:不要|不用|先别)(?:修改|改动|执行|运行)(?:代码|文件|项目)?[。！!]?$/i.test(
      normalized,
    )
  )
    return true;
  return /(?:只说|只讲)(?:一下)?(?:方案|思路)|只需要(?:说明|解释|介绍|回答)(?:即可|就行)?[。！!]?$|仅(?:咨询|了解|说明)[。！!]?$|只(?:咨询|了解一下|回答)(?:即可|就行)?[。！!]?$/i.test(
    normalized,
  );
}

function relevantRequestContent(history: CodingVerificationHistoryItem[]) {
  const messages = history.filter(
    (item): item is VerificationMessage => item.kind === "message",
  );
  let latestIndex = messages.length - 1;
  while (latestIndex >= 0 && messages[latestIndex].role !== "user")
    latestIndex -= 1;
  const latest = messages[latestIndex]?.content ?? "";
  if (!CONTINUATION_REQUEST.test(latest.trim())) return latest;
  const previous = messages
    .slice(Math.max(0, latestIndex - 2), latestIndex)
    .map((message) => message.content)
    .join("\n");
  return previous ? `${previous}\n${latest}` : latest;
}

/** Operations the latest user explicitly expects the coding agent to perform. */
export function requestedCodingOperations(
  history: CodingVerificationHistoryItem[],
) {
  const content = relevantRequestContent(history);
  if (isAdvisoryOnlyRequest(content)) return new Set<CodingOperation>();
  const validationContent = content.replace(
    /(?:触发|启动).{0,12}(?:打包|发布|Actions|工作流)|\btrigger.{0,12}(?:build|release|actions|workflow)\b/gi,
    "",
  );
  const asksForCodingInformation =
    /(?:是否|有没有|是不是|为什么|怎么|如何|能不能|能否|会不会|是什么|怎么回事|了吗|了没)[^。！!]*[？?]?|[吗么][？?]?$|\?$/i.test(
      content.trim(),
    );
  const explicitModifyRequest =
    /(?:帮我|请(?!问)|麻烦|要你|开始|继续|把|替我|重新).{0,50}(?:修改|修复|解决|优化|增加|新增|添加|删除|重构|实现|调整|替换|创建|生成|编写|开发|搭建|配置|接入|edit|change|fix|implement|add|remove|create|develop|configure)/i.test(
      content,
    );
  const explicitExecuteRequest =
    /(?:帮我|请|麻烦|要你|开始|继续|把|替我|重新|再次|并|然后).{0,40}(?:运行|执行|启动|安装|部署|跑一下|run|execute|start|launch|install|deploy)|(?:运行|执行|启动|安装|部署|跑)(?:一下|起来|看看)/i.test(
      content,
    );
  const explicitValidationRequest =
    /(?:帮我|请|麻烦|要你|开始|继续|把|替我|重新|再次|并|然后).{0,40}(?:验证|测试|类型检查|构建|打包|verify|test|typecheck|lint|build)/i.test(
      content,
    );
  const modifyContent =
    asksForCodingInformation && !explicitModifyRequest ? "" : content;
  const executeContent =
    asksForCodingInformation && !explicitExecuteRequest ? "" : content;
  const actionableValidationContent =
    asksForCodingInformation && !explicitValidationRequest
      ? ""
      : validationContent;
  const asksForRemoteStatus =
    /(?:是否|有没有|是不是|为什么|怎么|如何|能不能|能否|会不会|支持|连接了吗|上传了吗|下载了吗|了没)[^。！!]*[？?]?|[吗么][？?]?$|\?$/i.test(
      content.trim(),
    );
  const explicitRemoteRequest =
    /(?:帮我|请|麻烦|要你|开始|继续|把|替我).{0,40}(?:连接|连上|上传|下载|connect|upload|download)/i.test(
      content,
    );
  const remoteActionContent =
    asksForRemoteStatus && !explicitRemoteRequest ? "" : content;
  const operations = new Set<CodingOperation>();
  if (
    /(?:看下|查看|检查|排查|审查|分析|定位|找出|读取|搜索|确认|过一下|为什么|怎么回事)|\b(?:inspect|check|review|analy[sz]e|read|search|investigate|why)\b/i.test(
      content,
    )
  )
    operations.add("inspect");
  if (
    /(?:改一下|修改|修复|解决|优化|适配|增加|新增|添加|加上|删除|移除|重构|实现|落地|调整|替换|换成|设计一下|开始改|弄一下|弄好|做一个|做个|创建|新建|生成|写入|编写|开发|搭建|制作|配置|接入|集成|迁移|美化|处理一下|完善|补齐|补上|收尾)|\b(?:edit|change|modify|fix|implement|add|remove|refactor|optimi[sz]e|update|create|write|develop|configure|integrate|migrate)\b|\bbuild\s+(?:(?:a|an|the|this|new)\s+)?(?:app|application|page|site|feature|component|tool|service|project)\b/i.test(
      modifyContent,
    )
  )
    operations.add("modify");
  if (
    /(?:运行|执行|启动|安装|部署|发布到|跑|跑一下|跑起来)|\b(?:run|execute|start|launch|install|deploy)\b/i.test(
      executeContent,
    )
  )
    operations.add("execute");
  if (
    /(?:验证|测试|检查构建|类型检查|构建|打包)|\b(?:verify|test|typecheck|lint|build)\b/i.test(
      actionableValidationContent,
    )
  )
    operations.add("validate");
  if (
    /(?:连接|连上|登录到).{0,20}(?:SSH|服务器|主机|MySQL|SQL Server|MongoDB|数据库)|\bconnect(?:\s+to)?\s+(?:ssh|server|host|mysql|sql server|mongodb|database)\b/i.test(
      remoteActionContent,
    )
  )
    operations.add("connect");
  if (
    /(?:上传|传到).{0,30}(?:服务器|远程|SSH)|\bupload\b/i.test(
      remoteActionContent,
    )
  )
    operations.add("upload");
  if (
    /(?:下载|拉取).{0,30}(?:服务器|远程|SSH|文件)|\bdownload\b/i.test(
      remoteActionContent,
    )
  )
    operations.add("download");
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
    /(?:已|已经|完成|成功|落地|搞定|做好|弄好|处理好).{0,24}(?:修改|改造|修复|优化|适配|新增|添加|创建|新建|生成|写入|编写|开发|搭建|配置|删除|移除|重构|实现|替换|调整)|(?:修改|改动|改造|修复|优化|适配|实现|调整|创建|生成|写入)(?:文件|范围|集中|位于|涉及|如下|完成|成功|好了)|修改文件\s*[:：]|\b(?:(?:i|we)(?:'ve| have)?\s+)?(?:modified|edited|changed|fixed|implemented|updated|created|written|built|configured)(?:\s+successfully)?\b/i.test(
      text,
    )
  )
    operations.add("modify");
  if (
    /(?:已|已经|成功|完成|搞定|做好|弄好|处理好).{0,18}(?:运行|执行|启动|安装|部署|发布)|(?:运行|执行|启动|安装|部署).{0,10}(?:成功|完成|好了)|\b(?:(?:i|we)(?:'ve| have)?\s+)?(?:ran|executed|started|launched|installed|deployed|done|all set)\b/i.test(
      text,
    )
  )
    operations.add("execute");
  if (
    /(?:类型检查|测试|构建|生产构建|lint|typecheck).{0,14}(?:通过|成功|完成)|(?:通过|成功).{0,10}(?:类型检查|测试|构建)|\b(?:tests?|typecheck|lint|build)\s+(?:passed|succeeded|completed)\b/i.test(
      text,
    )
  )
    operations.add("validate");
  return operations;
}

type SuccessfulResult = {
  success?: boolean;
  data?: Record<string, unknown>;
};

function parsedResults(history: CodingVerificationHistoryItem[]) {
  const results = new Map<string, SuccessfulResult>();
  for (const item of history) {
    if (item.kind !== "result") continue;
    try {
      const result = JSON.parse(item.content) as SuccessfulResult;
      results.set(item.callId, result);
    } catch {
      // Unstructured legacy output cannot prove that an operation succeeded.
    }
  }
  return results;
}

function successfulResults(history: CodingVerificationHistoryItem[]) {
  return new Map(
    [...parsedResults(history)].filter(([, result]) => result.success === true),
  );
}

export function hasVerifiedNoChangeEvidence(
  history: CodingVerificationHistoryItem[],
) {
  const results = successfulResults(history);
  const noOpCapableTools = new Set([
    "apply_patch",
    "write_file",
    "make_directory",
    "ssh_write_file",
    "mysql_query",
    "sqlserver_query",
    "mongodb_execute",
    "diagnostics",
  ]);
  for (const item of history) {
    if (item.kind !== "calls") continue;
    for (const call of item.calls) {
      if (!noOpCapableTools.has(call.name)) continue;
      const data = results.get(call.id)?.data;
      if (
        data?.changed === false &&
        (data.mutationAttempted === true ||
          !["mysql_query", "sqlserver_query", "mongodb_execute"].includes(
            call.name,
          ))
      )
        return true;
    }
  }
  return false;
}

export function claimsNoChangeNeeded(text: string) {
  return /(?:无需|不需要|没有必要|不必)(?:再)?(?:修改|改动|变更)|(?:内容|文件|配置|目录).{0,12}(?:一致|相同|已经正确|符合要求)|(?:未|没有)发生实际(?:修改|改动|变更)|已经(?:是|处于|符合).{0,16}(?:目标|预期|要求|正确)|\b(?:no changes? (?:were )?(?:needed|required)|already (?:correct|matches?|up[ -]to[ -]date)|nothing (?:needed|to change)|unchanged)\b/i.test(
    text,
  );
}

function hasActualMutation(data: Record<string, unknown> | undefined) {
  if (!data) return false;
  if (data.changed === false) return false;
  if (data.changed === true) return true;
  if (Number(data.additions) > 0 || Number(data.deletions) > 0) return true;
  if (typeof data.diff === "string" && data.diff.trim()) return true;
  if (!Array.isArray(data.fileChanges)) return false;
  return data.fileChanges.some((change) => {
    if (!change || typeof change !== "object") return false;
    const item = change as Record<string, unknown>;
    return (
      item.changed === true ||
      Number(item.additions) > 0 ||
      Number(item.deletions) > 0 ||
      (typeof item.diff === "string" && Boolean(item.diff.trim()))
    );
  });
}

function isValidationCommand(command: string) {
  const value = command.trim();
  return (
    /(?:^|[;&|]\s*|\n\s*|\{\s*)(?:(?:npm|pnpm|yarn|bun)\s+(?:test|(?:run\s+)?(?:test(?::[\w.-]+)?|typecheck|lint|build|check|verify|compile))|(?:npx|pnpm\s+exec|yarn\s+exec|bunx)\s+(?:vitest|jest|tsc|vue-tsc|eslint|biome|prettier)|vitest|jest|pytest|python\s+-m\s+(?:pytest|unittest|py_compile|compileall|json\.tool)|phpunit|php(?:\.exe)?\s+(?:-l|artisan\s+test)|composer\s+test|go\s+(?:test|vet)|cargo\s+(?:test|check|clippy|build)|dotnet\s+(?:test|build)|(?:\.\/?|\.\\)?(?:mvnw?|gradlew?|gradle)\b[^;&|\n]{0,120}\b(?:test|verify|check|build|package)\b|make\s+(?:test|check)|deno\s+(?:test|check)|(?:node(?:\.exe)?\s+--check)|(?:bash|sh)\s+-n|ruby\s+-c|jq\s+(?:empty|--exit-status)|(?:vue-)?tsc|eslint|biome\s+(?:check|lint)|prettier\s+--check|Test-Json|ConvertFrom-Json)(?:\s|$)/i.test(
      value,
    ) ||
    /\bJSON\.parse\s*\(|\bConvertFrom-Json\b|\bTest-Json\b|\b(?:test|check|verify|validate)[\w.-]*\.(?:[cm]?js|py|php|sh)\b/i.test(
      value,
    )
  );
}

function hasSuccessfulValidationOutput(value: unknown) {
  if (typeof value !== "string") return false;
  return /\b(?:validation|validate|verification|syntax(?:[ -]check)?|tests?|typecheck|lint|build)\s*(?::|=|-)?\s*(?:pass(?:ed)?|success(?:ful)?|ok)\b|\b(?:pass(?:ed)?|success(?:ful)?|ok)\s*(?::|=|-)?\s*(?:validation|verification|syntax|tests?|typecheck|lint|build)\b|no syntax errors detected|(?:验证|校验|测试|语法检查|构建).{0,24}(?:通过|成功|无错误)/i.test(
    value,
  );
}

/** Successful native tool results generated during this Agent run. */
export function successfulCodingEvidence(
  history: CodingVerificationHistoryItem[],
) {
  const parsed = parsedResults(history);
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
    "web_search",
    "fetch_url",
    "browser_snapshot",
    "browser_screenshot",
    "ssh_list_directory",
    "ssh_read_file",
  ]);
  const executeTools = new Set([
    "run_command",
    "ssh_run",
    "mysql_query",
    "sqlserver_query",
    "mongodb_execute",
  ]);
  const connectTools = new Set([
    "ssh_connect",
    "mysql_connect",
    "mysql_connect_via_ssh",
    "sqlserver_connect",
    "sqlserver_connect_via_ssh",
    "mongodb_connect",
    "mongodb_connect_via_ssh",
  ]);
  const calls = new Map<
    string,
    { id: string; name: string; input: Record<string, unknown> }
  >();
  for (const item of history)
    if (item.kind === "calls")
      for (const call of item.calls) calls.set(call.id, call);

  let sequence = 0;
  let lastMutation = -1;
  let lastValidation = -1;
  for (const item of history) {
    if (item.kind !== "result") continue;
    sequence += 1;
    const result = parsed.get(item.callId);
    const call = calls.get(item.callId);
    if (!result || !call) continue;
    const data = result.data;
    const successful = result.success === true;
    if (successful && inspectTools.has(call.name)) operations.add("inspect");
    if (successful && connectTools.has(call.name)) operations.add("connect");
    if (successful && call.name === "ssh_upload_file") operations.add("upload");
    if (successful && call.name === "ssh_download_file")
      operations.add("download");
    const childEvidence = Array.isArray(data?.operationEvidence)
      ? data.operationEvidence.filter(
          (operation): operation is CodingOperation =>
            [
              "inspect",
              "modify",
              "execute",
              "validate",
              "connect",
              "upload",
              "download",
            ].includes(String(operation)),
        )
      : [];
    for (const operation of childEvidence)
      if (operation !== "validate") operations.add(operation);
    if (childEvidence.includes("modify")) lastMutation = sequence;
    if (childEvidence.includes("validate")) lastValidation = sequence + 0.5;

    const command = ["run_command", "ssh_run"].includes(call.name)
      ? String(call.input.command ?? "")
      : "";
    // Command text only describes intent. It cannot prove that the workspace
    // actually changed (for example `2>$null` or a no-op formatter). Mutation
    // evidence must come from structured tool-result metadata.
    const mutated =
      successful &&
      (call.name === "wait_agent" || call.name === "stop_agent"
        ? childEvidence.includes("modify")
        : !["ssh_upload_file", "ssh_download_file"].includes(call.name) &&
          hasActualMutation(data));
    if (mutated) {
      operations.add("modify");
      lastMutation = sequence;
    }

    const executed =
      data?.executed === true &&
      (successful ||
        data.exitCode !== undefined ||
        call.name === "diagnostics");
    if (executeTools.has(call.name) && executed) operations.add("execute");
    if (
      ["mysql_query", "sqlserver_query", "mongodb_execute"].includes(
        call.name,
      ) &&
      data?.executed === true &&
      data.changed !== true
    )
      operations.add("inspect");
    if (["run_command", "ssh_run"].includes(call.name)) {
      if (
        (successful || (executed && data?.exitCode === 1)) &&
        /\b(?:cat|type|findstr|rg|grep|git\s+(?:status|diff|log|show))\b/i.test(
          command,
        )
      )
        operations.add("inspect");
      if (
        successful &&
        executed &&
        (isValidationCommand(command) ||
          hasSuccessfulValidationOutput(data?.output))
      )
        lastValidation = sequence;
    }
    if (call.name === "diagnostics" && successful && data?.executed === true) {
      operations.add("execute");
      lastValidation = sequence;
    }
    if (
      call.name === "process_output" &&
      typeof data?.output === "string" &&
      /(?:状态:\s*运行中|status:\s*running)/i.test(data.output)
    )
      operations.add("execute");
  }
  if (lastValidation > lastMutation) operations.add("validate");
  return operations;
}

export function missingRequestedCodingOperations(
  requested: ReadonlySet<CodingOperation>,
  evidence: ReadonlySet<CodingOperation>,
) {
  return [...requested].filter((operation) => !evidence.has(operation));
}

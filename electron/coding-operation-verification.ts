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

const EVIDENCE_OUTPUT_TOOLS = new Set([
  "process_output",
  "git_status",
  "git_log",
  "git_diff",
  "git_show",
  "run_command",
  "ssh_run",
]);

export function compactOperationEvidenceResult(
  callId: string,
  toolName: string,
  success: boolean,
  data: Record<string, unknown>,
): Extract<CodingVerificationHistoryItem, { kind: "result" }> {
  return {
    kind: "result",
    callId,
    content: JSON.stringify({
      success,
      data: {
        changed: data.changed,
        executed: data.executed,
        mutationAttempted: data.mutationAttempted,
        noChangeReported: data.noChangeReported,
        userInputRequested: data.userInputRequested,
        operationEvidence: data.operationEvidence,
        browserOperationEvidence: data.browserOperationEvidence,
        exitCode: data.exitCode,
        output: EVIDENCE_OUTPUT_TOOLS.has(toolName)
          ? String(data.output ?? "").slice(0, 1_000)
          : undefined,
      },
    }),
  };
}

type VerificationMessage = Extract<
  CodingVerificationHistoryItem,
  { kind: "message" }
>;

const CONTINUATION_REQUEST =
  /^(?:好|好的|可以|行|继续|继续吧|开始|开始吧|开始弄吧|开始改吧|改吧|修吧|做吧|弄吧|执行吧|就这么做|按(?:你|上面|这个).{0,12}做|都弄|都改|全部(?:做|弄|改|修改)|上面(?:的)?全部(?:做|弄|改|修改))(?:了|吧|啊|呀)?[。！!，,\s]*$/i;

const ASSISTANT_PROPOSAL_ACCEPTANCE_REQUEST =
  /^(?:就这么(?:做|改|弄)|按(?:你|上面|这个).{0,12}(?:做|改|弄|修改)|照(?:你|上面|这个).{0,12}(?:做|改|弄|修改)|都(?:做|改|弄|修改)|全部(?:做|改|弄|修改)|上面(?:的)?全部(?:做|改|弄|修改))(?:了|吧|啊|呀)?[。！!，,\s]*$/i;

const CORRECTIVE_CONTINUATION_REQUEST =
  /(?:^|\n)\s*(?:还是|仍然|依然|仍旧|又|现在还是|目前还是)(?:不对|不行|有问题|没好|没有好|未解决|不正常|不生效|看不到|不显示|显示错误|报错|卡住)|(?:^|\n)\s*(?:问题|故障|错误|这个问题)(?:还在|仍在|依然存在|没有解决|没解决)/i;

const REMOTE_CONTINUATION_REQUEST =
  /^(?:你)?(?:直接|重新|再次|再)?(?:连接|连上|重连)(?:一下)?(?:吧|啊|呀)?[。！!，,\s]*$/i;

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

function userIntentContent(content: string) {
  return content
    .replace(/<user_steer>([\s\S]*?)<\/user_steer>/gi, "$1")
    .replace(
      /<interrupted_turn_recovery>[\s\S]*?<\/interrupted_turn_recovery>/gi,
      "",
    )
    .replace(/<runtime_verification>[\s\S]*?<\/runtime_verification>/gi, "")
    .replace(/<runtime_finalization>[\s\S]*?<\/runtime_finalization>/gi, "")
    .replace(/<runtime_hook>[\s\S]*?<\/runtime_hook>/gi, "")
    .replace(/<parent_instruction>[\s\S]*?<\/parent_instruction>/gi, "")
    .replace(/<context_file\b[^>]*>[\s\S]*?<\/context_file>/gi, "")
    .replace(/<conversation_summary>[\s\S]*?<\/conversation_summary>/gi, "")
    .trim();
}

export function relevantVerificationRequestContent(
  history: CodingVerificationHistoryItem[],
) {
  const messages = history
    .filter((item): item is VerificationMessage => item.kind === "message")
    .map((message) => ({
      ...message,
      content:
        message.role === "user"
          ? userIntentContent(message.content)
          : message.content,
    }))
    .filter((message) => message.role !== "user" || message.content);
  let latestIndex = messages.length - 1;
  while (latestIndex >= 0 && messages[latestIndex].role !== "user")
    latestIndex -= 1;
  const latest = messages[latestIndex]?.content ?? "";
  if (CORRECTIVE_CONTINUATION_REQUEST.test(latest.trim())) {
    const previousUser = [...messages.slice(0, latestIndex)]
      .reverse()
      .find((message) => message.role === "user");
    return previousUser ? `${previousUser.content}\n${latest}` : latest;
  }
  if (REMOTE_CONTINUATION_REQUEST.test(latest.trim())) {
    const previousUser = [...messages.slice(0, latestIndex)]
      .reverse()
      .find((message) => message.role === "user");
    return previousUser ? `${previousUser.content}\n${latest}` : latest;
  }
  if (!CONTINUATION_REQUEST.test(latest.trim())) return latest;
  const priorMessages = messages.slice(0, latestIndex);
  const previousUser = [...priorMessages]
    .reverse()
    .find((message) => message.role === "user");
  if (ASSISTANT_PROPOSAL_ACCEPTANCE_REQUEST.test(latest.trim())) {
    const adjacentAssistant = priorMessages.at(-1);
    const acceptedProposal =
      adjacentAssistant?.role === "assistant" ? adjacentAssistant.content : "";
    return [previousUser?.content, acceptedProposal, latest]
      .filter(Boolean)
      .join("\n");
  }
  // A continuation inherits the user's previous request, never the previous
  // model's prose. In particular, after switching models the preceding
  // assistant may contain a plan such as "I will edit and run tests". Treating
  // that prose as user intent invents extra required operations while the new
  // request correctly starts with a fresh evidence ledger, which then produces
  // a false `coding_tool_execution_missing` error.
  return previousUser ? `${previousUser.content}\n${latest}` : latest;
}

/** Operations the latest user explicitly expects the coding agent to perform. */
export function requestedCodingOperations(
  history: CodingVerificationHistoryItem[],
) {
  const content = relevantVerificationRequestContent(history);
  if (isAdvisoryOnlyRequest(content)) return new Set<CodingOperation>();
  const validationContent = content
    .replace(/验证码|动态码|校验码|\b(?:otp|verification\s+codes?)\b/gi, "")
    .replace(
      /(?:触发|启动).{0,12}(?:打包|发布|Actions|工作流)|\btrigger.{0,12}(?:build|release|actions|workflow)\b/gi,
      "",
    );
  const asksForCodingInformation =
    /(?:是否|有没有|是不是|为什么|怎么|如何|能不能|能否|会不会|是什么|怎么回事|了吗|了没)[^。！!]*[？?]?|[吗么][？?]?$|\?$/i.test(
      content.trim(),
    );
  const describesObservedState =
    /(?:我(?:看|看到|发现|注意到)|当前|现在|目前|看起来|好像).{0,80}(?:没有|未|找不到|看不到|不显示|不存在|缺少)/i.test(
      content,
    );
  const explicitModifyRequest =
    /(?:帮我|请(?!问)|麻烦|要你|开始|继续|把|替我|重新).{0,50}(?:修改|修复|改为|改成|修改成|切换为|替换为|解决|优化|增加|新增|添加|删除|重构|实现|调整|替换|创建|生成|编写|开发|搭建|配置|接入|edit|change|fix|implement|add|remove|create|develop|configure)/i.test(
      content,
    );
  const explicitExecuteRequest =
    /(?:帮我|请|麻烦|要你|开始|继续|把|替我|重新|再次|并|然后).{0,40}(?:运行|执行|启动|安装|部署|跑一下|run|execute|start|launch|install|deploy)|(?:运行|执行|启动|安装|部署|跑)(?:一下|起来|看看)/i.test(
      content,
    );
  const explicitValidationRequest =
    /(?:帮我|请|麻烦|要你|开始|继续|把|替我|重新|再次|并|然后).{0,40}(?:验证|测试|类型检查|构建|打包|verify|test|typecheck|lint|build)/i.test(
      validationContent,
    );
  const externalProbeRequest =
    /(?:直接|实际|请|帮我|麻烦|替我|测试一下|试一下|测一下|探测)/i.test(
      content,
    ) &&
    /(?:(?:你)?(?:直接|实际|帮我|请|麻烦|替我)?(?:调用|请求|访问|测试|试一下|测一下|探测)).{0,40}(?:https?:\/\/|API|接口|端点|endpoint|URL)|(?:https?:\/\/|API|接口|端点|endpoint|URL).{0,40}(?:直接|实际)?(?:调用|请求|访问|测试|试一下|测一下|探测)/i.test(
      content,
    );
  const explicitCodeValidationRequest =
    /(?:单元测试|自动化测试|测试用例|类型检查|检查构建|构建|打包|typecheck|lint|build|unit tests?)/i.test(
      validationContent,
    );
  const modifyContent =
    (asksForCodingInformation || describesObservedState) &&
    !explicitModifyRequest
      ? ""
      : content;
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
    /(?:帮我|请|麻烦|要你|开始|继续|把|替我|直接|重新|再次|再).{0,40}(?:连接|连上|重连|上传|下载|connect|reconnect|upload|download)/i.test(
      content,
    );
  const remoteActionContent =
    asksForRemoteStatus && !explicitRemoteRequest ? "" : content;
  const correctiveImplementationRequest =
    CORRECTIVE_CONTINUATION_REQUEST.test(content) &&
    /(?:项目|代码|文件|配置|页面|界面|列表|显示|统计|组件|功能|按钮|输入框|字段|数据|接口|服务|应用|客户端|前端|后端)/i.test(
      content,
    );
  const operations = new Set<CodingOperation>();
  if (
    /(?:看下|看一下|查看|检查|排查|审查|分析|定位|找出|读取|搜索|确认|过一下|为什么|怎么回事)|\b(?:inspect|check|review|analy[sz]e|read|search|investigate|why)\b/i.test(
      content,
    )
  )
    operations.add("inspect");
  if (correctiveImplementationRequest) operations.add("inspect");
  if (externalProbeRequest) operations.add("inspect");
  if (
    /(?:改一下|修改|改为|改成|修改成|切换为|替换为|修改|修复|解决|优化|适配|增加|新增|添加|加上|删除|移除|重构|实现|落地|调整|替换|换成|设计一下|开始改|弄一下|弄好|做一个|做个|创建|新建|生成|写入|编写|开发|搭建|制作|配置|接入|集成|迁移|美化|弹窗|页面交互|处理一下|完善|补齐|补上|收尾)|\b(?:edit|change|modify|fix|implement|add|remove|refactor|optimi[sz]e|update|create|write|develop|configure|integrate|migrate)\b|\bbuild\s+(?:(?:a|an|the|this|new)\s+)?(?:app|application|page|site|feature|component|tool|service|project)\b/i.test(
      modifyContent,
    )
  )
    operations.add("modify");
  if (correctiveImplementationRequest) operations.add("modify");
  if (
    /(?:运行|执行|启动|安装|部署|发布到|跑|跑一下|跑起来)|\b(?:run|execute|start|launch|install|deploy)\b/i.test(
      executeContent,
    )
  )
    operations.add("execute");
  if (externalProbeRequest) operations.add("execute");
  if (
    /(?:验证|测试|检查构建|类型检查|构建|打包)|\b(?:verify|test|typecheck|lint|build)\b/i.test(
      actionableValidationContent,
    ) &&
    (!externalProbeRequest ||
      explicitModifyRequest ||
      explicitCodeValidationRequest)
  )
    operations.add("validate");
  if (
    /(?:连接|连上|登录到).{0,20}(?:SSH|服务器|主机|MySQL|SQL Server|MongoDB|数据库)|(?:部署|发布到).{0,20}(?:服务器|远程|主机)|\bconnect(?:\s+to)?\s+(?:ssh|server|host|mysql|sql server|mongodb|database)\b|\bdeploy(?:\s+to)?\s+(?:server|host|remote)\b/i.test(
      remoteActionContent,
    ) ||
    (explicitRemoteRequest &&
      /(?:SSH|服务器|主机|IP(?:\s*地址)?|端口|用户名|username|密码|password|私钥|密钥|private[ -]?key|credential)/i.test(
        remoteActionContent,
      ))
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
 * Explicit coding work must enter the native tool loop before a model can
 * finish in prose. Once the requested side effects have verifiable evidence,
 * normal automatic tool selection is restored so the model can summarize.
 */
export function shouldRequireCodingTool(
  _modelId: string,
  requested: ReadonlySet<CodingOperation>,
  evidence: ReadonlySet<CodingOperation>,
  history: CodingVerificationHistoryItem[] = [],
) {
  if (hasRequestedUserInputEvidence(history)) return false;
  const required = codingOperationsRequiringToolEvidence(requested);
  if (!required.size) return false;
  return (
    missingVerifiedCodingOperations(
      required,
      new Set(),
      evidence,
      history,
      requested,
    ).length > 0
  );
}

/** Operations the assistant claims have already happened in its final text. */
export function claimedCodingOperations(text: string) {
  const proseText = text
    .replace(/```[\s\S]*?```/g, "")
    .replace(
      /(?:如果|若|假如|一旦|\bif\b|\bwhen\b)[^。！？!?\n]{0,160}[。！？!?]?/gi,
      "",
    );
  const assertedText = proseText.replace(
    /(?:无需|不需要|没有必要|不必)(?:再)?(?:修改|改动|变更)|(?:未|没有|尚未|无法|不能|不会|并未).{0,10}(?:检查|查看|读取|搜索|排查|审查|分析|确认|定位|修改|改动|修复|优化|新增|添加|创建|生成|写入|实现|调整|更新|运行|执行|启动|安装|部署|发布|验证|测试|构建|连接|上传|下载)|\b(?:not|never|did not|could not|unable to)\b[^.!?\n]{0,40}\b(?:inspect|check|modify|edit|fix|implement|run|execute|validate|connect|upload|download)\b/gi,
    "",
  );
  const operations = new Set<CodingOperation>();
  if (
    /(?:已|已经|完成|实际).{0,18}(?:检查|查看|读取|搜索|排查|审查|分析|确认|定位)|(?:我|我们)(?:已经|已)?(?:检查|查看|读取|搜索|排查|审查|分析|确认|定位)(?:了|过)|(?:检查|读取|搜索|排查|审查|分析)(?:后|并).{0,10}(?:确认|发现|结果)|(?:检查|读取|搜索|排查|审查|分析).{0,12}(?:完成|通过|结果)|\b(?:inspected|checked|reviewed|analyzed|read|searched)\b/i.test(
      assertedText,
    )
  )
    operations.add("inspect");
  if (
    /(?:已|已经|完成|成功|落地|搞定|做好|弄好|处理好).{0,24}(?:修改|改造|修复|优化|适配|新增|添加|创建|新建|生成|写入|编写|开发|搭建|配置|删除|移除|重构|实现|替换|调整|更新)|(?:我|我们)(?:已经|已)?(?:修改|改动|改造|修复|优化|适配|新增|添加|创建|新建|生成|写入|编写|开发|搭建|配置|删除|移除|重构|实现|替换|调整|更新)(?:了|完成|好了)|(?:做了|完成了).{0,16}(?:修改|改动|改造|修复|优化|新增|添加|创建|配置|重构|调整|更新)|(?:修改|改动|改造|修复|优化|适配|实现|调整|创建|生成|写入|更新)(?:文件|范围|集中|位于|涉及|如下|完成|成功|好了|了)|修改文件\s*[:：]|\b(?:(?:i|we)(?:'ve| have)?\s+)?(?:modified|edited|changed|fixed|implemented|updated|created|written|built|configured)(?:\s+successfully)?\b/i.test(
      assertedText,
    )
  )
    operations.add("modify");
  if (
    /(?:已|已经|成功|完成|搞定|做好|弄好|处理好).{0,18}(?:运行|执行|启动|安装|部署|发布)|(?:我|我们|并|随后|然后|同时)(?:已经|已)?(?:运行|执行|启动|安装|部署|发布)(?:了|完成|好了)|(?:运行|执行|启动|安装|部署).{0,10}(?:成功|完成|好了)|\b(?:(?:i|we)(?:'ve| have)?\s+)?(?:ran|executed|started|launched|installed|deployed)\b/i.test(
      assertedText,
    )
  )
    operations.add("execute");
  if (
    /(?:类型检查|测试|构建|生产构建|lint|typecheck).{0,14}(?:通过|成功|完成)|(?:通过|成功).{0,10}(?:类型检查|测试|构建)|\b(?:tests?|typecheck|lint|build)\s+(?:passed|succeeded|completed)\b/i.test(
      assertedText,
    )
  )
    operations.add("validate");
  if (
    /(?:已|已经|成功).{0,16}(?:连接|连上|登录到).{0,18}(?:SSH|服务器|主机|MySQL|SQL Server|MongoDB|数据库)|(?:SSH|服务器|主机|MySQL|SQL Server|MongoDB|数据库).{0,16}(?:已连接|连接成功|已登录)|\b(?:connected|logged in)\s+(?:to\s+)?(?:the\s+)?(?:ssh|server|host|mysql|sql server|mongodb|database)\b/i.test(
      assertedText,
    )
  )
    operations.add("connect");
  if (
    /(?:已|已经|成功).{0,12}(?:上传|传到)|(?:上传|传输).{0,12}(?:成功|完成|好了)|\b(?:uploaded|upload completed|upload succeeded)\b/i.test(
      assertedText,
    )
  )
    operations.add("upload");
  if (
    /(?:已|已经|成功).{0,12}(?:下载|拉取)|(?:下载|拉取).{0,12}(?:成功|完成|好了)|\b(?:downloaded|download completed|download succeeded)\b/i.test(
      assertedText,
    )
  )
    operations.add("download");
  return operations;
}

export function claimsTaskCompletion(text: string) {
  const proseText = text
    .replace(/```[\s\S]*?```/g, "")
    .replace(
      /(?:如果|若|假如|一旦|\bif\b|\bwhen\b)[^。！？!?\n]{0,160}[。！？!?]?/gi,
      "",
    );
  const assertedText = proseText.replace(
    /(?:未|没有|尚未|还没|无法|不能|并未).{0,10}(?:完成|解决|处理完|搞定|做好|弄好)|(?:部分|仅|只).{0,8}(?:完成|处理|解决)|\b(?:not|never|isn't|wasn't|did not|could not|unable to|partially)\b[^.!?\n]{0,40}\b(?:complete|completed|done|resolved|fixed)\b/gi,
    "",
  );
  return /(?:任务|工作|需求|问题|故障|功能|处理).{0,12}(?:已|已经|都已|全部)?(?:完成|解决|处理完|处理好|搞定|做好|弄好)|(?:已|已经)(?:全部|整体|都)?(?:完成|处理完|处理好|解决|搞定|做好|弄好)|\b(?:task completed|completed successfully|all done|all set|fully resolved)\b/i.test(
    assertedText,
  );
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

export function hasSuccessfulToolEvidence(
  history: CodingVerificationHistoryItem[],
) {
  const calls = new Map<string, string>();
  for (const item of history)
    if (item.kind === "calls")
      for (const call of item.calls) calls.set(call.id, call.name);
  const administrativeTools = new Set([
    "request_user_input",
    "report_no_change",
    "spawn_agent",
    "list_agents",
    "message_agent",
    "stop_agent",
  ]);
  for (const [callId, result] of parsedResults(history)) {
    const tool = calls.get(callId);
    if (result.success === true && tool && !administrativeTools.has(tool))
      return true;
  }
  return false;
}

export function isUnsupportedTaskCompletionClaim(
  text: string,
  executionRequired: boolean,
  history: CodingVerificationHistoryItem[],
) {
  return (
    executionRequired &&
    claimsTaskCompletion(text) &&
    !hasSuccessfulToolEvidence(history)
  );
}

export function hasRequestedUserInputEvidence(
  history: CodingVerificationHistoryItem[],
) {
  const parsed = parsedResults(history);
  const calls = new Map<
    string,
    { name: string; input: Record<string, unknown> }
  >();
  for (const item of history)
    if (item.kind === "calls")
      for (const call of item.calls) calls.set(call.id, call);
  for (const [callId, result] of parsed) {
    const call = calls.get(callId);
    if (
      call?.name === "request_user_input" &&
      result.success === true &&
      result.data?.userInputRequested === true &&
      String(call.input.question ?? "").trim().length >= 8 &&
      Array.isArray(call.input.fields) &&
      call.input.fields.some((field) => String(field).trim())
    )
      return true;
  }
  return false;
}

function verifiedNoChangeEvidence(history: CodingVerificationHistoryItem[]) {
  const parsed = parsedResults(history);
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
  const inspectionTools = new Set([
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
  const calls = new Map<
    string,
    { id: string; name: string; input: Record<string, unknown> }
  >();
  for (const item of history) {
    if (item.kind === "calls")
      for (const call of item.calls) calls.set(call.id, call);
  }
  let inspected = false;
  let mutated = false;
  let explicitReport = false;
  let verifiedNoOp = false;
  for (const item of history) {
    if (item.kind !== "result") continue;
    const call = calls.get(item.callId);
    const result = parsed.get(item.callId);
    if (!call || result?.success !== true) continue;
    const data = result.data;
    const command = ["run_command", "ssh_run"].includes(call.name)
      ? String(call.input.command ?? "")
      : "";
    if (
      inspectionTools.has(call.name) ||
      (["run_command", "ssh_run"].includes(call.name) &&
        data?.executed === true &&
        isInspectionCommand(command))
    )
      inspected = true;
    if (hasActualMutation(data)) {
      mutated = true;
      explicitReport = false;
    }
    if (noOpCapableTools.has(call.name)) {
      if (
        data?.changed === false &&
        (data.mutationAttempted === true ||
          !["mysql_query", "sqlserver_query", "mongodb_execute"].includes(
            call.name,
          ))
      )
        verifiedNoOp = true;
    }
    if (
      call.name === "report_no_change" &&
      data?.noChangeReported === true &&
      String(call.input.reason ?? "").trim().length >= 8 &&
      inspected &&
      !mutated
    )
      explicitReport = true;
  }
  return { verifiedNoOp, explicitReport };
}

export function hasVerifiedNoChangeEvidence(
  history: CodingVerificationHistoryItem[],
) {
  const evidence = verifiedNoChangeEvidence(history);
  return evidence.verifiedNoOp || evidence.explicitReport;
}

export function hasVerifiedNoChangeReport(
  history: CodingVerificationHistoryItem[],
) {
  return verifiedNoChangeEvidence(history).explicitReport;
}

export function claimsNoChangeNeeded(text: string) {
  return /(?:无需|不需要|没有必要|不必)(?:再)?(?:修改|改动|变更)|(?:本次|因此|所以)?(?:不(?:会|再)?|没有)(?:进行|产生|做)?(?:任何)?(?:修改|改动|变更)|(?:本次|本轮|当前)?(?:没有|不存在)(?:任何)?(?:需要|可执行)?的?(?:文件|代码|配置)?(?:修改|改动|变更)(?:需求|目标|必要)|(?:内容|文件|配置|目录).{0,12}(?:一致|相同|已经正确|符合要求)|(?:未|没有)发生实际(?:修改|改动|变更)|已经(?:是|处于|符合).{0,16}(?:目标|预期|要求|正确)|\b(?:no changes? (?:were )?(?:needed|required)|already (?:correct|matches?|up[ -]to[ -]date)|nothing (?:needed|to change)|unchanged)\b/i.test(
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

function isInspectionCommand(command: string) {
  return /\b(?:cat|type|findstr|rg|grep|Get-Content|Get-ChildItem|Select-String|Test-Path|Resolve-Path|git\s+(?:status|diff|log|show))\b/i.test(
    command,
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
        isInspectionCommand(command)
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

/**
 * Inspection is useful evidence when tools are available, but it is not a
 * side effect. A screenshot, attachment, or supplied error can be answered
 * without opening the workspace, so inspection alone must not become a failed
 * task.
 */
export function codingOperationsRequiringToolEvidence(
  operations: ReadonlySet<CodingOperation>,
) {
  return new Set(
    [...operations].filter((operation) => operation !== "inspect"),
  );
}

export function missingVerifiedCodingOperations(
  required: ReadonlySet<CodingOperation>,
  claimed: ReadonlySet<CodingOperation>,
  evidence: ReadonlySet<CodingOperation>,
  history: CodingVerificationHistoryItem[],
  _requested: ReadonlySet<CodingOperation> = required,
) {
  const noChangeEvidence = hasVerifiedNoChangeEvidence(history);
  const noChangeReport = hasVerifiedNoChangeReport(history);
  return missingRequestedCodingOperations(required, evidence).filter(
    (operation) =>
      !(
        (operation === "modify" &&
          noChangeEvidence &&
          !claimed.has("modify")) ||
        (operation === "validate" && noChangeReport && !claimed.has("validate"))
      ),
  );
}

const BLOCKABLE_CODING_OPERATIONS = new Set<CodingOperation>([
  "execute",
  "validate",
  "connect",
  "upload",
  "download",
]);

export function reportsMissingRequiredUserInput(text: string) {
  const reportsUnavailable =
    /(?:无法|不能|未能|尚未|暂时无法|不可执行|阻塞|缺少|欠缺|未(?:提供|收到|配置|选择|确认|上传|连接|执行|完成)|没有(?:可用|收到|提供|配置|选择|确认|上传|连接|执行|完成|可执行)|(?:请|需要(?:你|用户)?|等待(?:你|用户)?|麻烦).{0,32}(?:提供|补充|上传|选择|确认|登录|完成|允许|授权)|missing|required (?:input|information)|not (?:provided|available|configured)|(?:please|need you to) (?:provide|upload|select|confirm|sign in|complete|authorize))/i.test(
      text,
    );
  const namesConcreteInput =
    /(?:URL|网址|链接|SSH|服务器|server|主机|host|远程|IP(?:\s*地址)?|域名|端口|port|账号|用户名|username|密码|password|密钥|key|凭据|credential|token|验证码|动态码|OTP|2FA|人工验证|CAPTCHA|连接参数|登录信息|权限|permission|仓库|repository|remote|分支|branch|发布目标|文件|file|附件|图片|路径|path|目录|需求|requirement|规格|specification|字段|field|接口|API|数据库|database|外部服务|运行环境|测试环境|依赖|dependency)/i.test(
      text,
    );
  const asksUser =
    /(?:请|需要(?:你|用户)?|等待(?:你|用户)?|麻烦).{0,32}(?:提供|补充|上传|选择|确认|登录|完成|允许|授权)|(?:提供|补充|上传|选择|确认|登录|完成).{0,24}(?:后|之后|才能|即可).{0,18}(?:继续|执行|处理|开始)|(?:please|need you to) (?:provide|upload|select|confirm|sign in|complete|authorize)/i.test(
      text,
    );
  return reportsUnavailable && namesConcreteInput && asksUser;
}

/**
 * A truthful request for required user/external input is a blocked outcome,
 * not a failed verification. Workspace inspection/modification still cannot
 * be skipped through prose alone.
 */
export function reportsBlockedCodingOperations(
  text: string,
  missing: readonly CodingOperation[],
) {
  if (!text.trim() || !missing.length) return false;
  const explicitlyRequestsInput = reportsMissingRequiredUserInput(text);
  if (
    !explicitlyRequestsInput &&
    missing.some((operation) => !BLOCKABLE_CODING_OPERATIONS.has(operation))
  )
    return false;
  const reportsUnavailable =
    /(?:无法|不能|未能|尚未|暂时无法|不可执行|阻塞|缺少|欠缺|未(?:提供|收到|配置|连接|执行|完成|部署|上传|下载|验证|测试)|没有(?:可用|收到|提供|配置|连接|执行|完成|部署|上传|下载|验证|测试|可执行))/i.test(
      text,
    );
  const namesRequiredInput =
    /(?:SSH|服务器|主机|远程|IP(?:\s*地址)?|域名|端口|账号|用户名|密码|密钥|凭据|连接参数|登录信息|权限|数据库|外部服务|运行环境|测试环境|依赖)|(?:需要|请|等待).{0,24}(?:提供|补充|配置|确认)/i.test(
      text,
    );
  if (!reportsUnavailable || !namesRequiredInput) return false;

  const operationWords = missing
    .map((operation) => {
      if (operation === "execute") return "执行|运行|启动|安装|部署|发布";
      if (operation === "validate") return "验证|校验|测试|构建|检查";
      if (operation === "connect") return "连接|登录";
      if (operation === "upload") return "上传|传输";
      return "下载|拉取";
    })
    .join("|");
  const claimsSuccess = new RegExp(
    `(?:已|已经|成功).{0,20}(?:${operationWords})|(?:${operationWords}).{0,12}(?:成功|已完成|完成了|好了)`,
    "i",
  );
  const withoutNegatedSuccess = text.replace(
    new RegExp(
      `(?:未能|没有|尚未|无法|不能|并未|未).{0,8}(?:成功|完成).{0,12}(?:${operationWords})`,
      "gi",
    ),
    "",
  );
  return !claimsSuccess.test(withoutNegatedSuccess);
}

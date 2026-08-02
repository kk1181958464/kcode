import { relevantVerificationRequestContent } from "./coding-operation-verification";

export type BrowserOperation = "open" | "type" | "click" | "verify";

export type BrowserVerificationHistoryItem =
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

export function requestedBrowserOperations(
  history: BrowserVerificationHistoryItem[],
) {
  const content = relevantVerificationRequestContent(history);
  const operations = new Set<BrowserOperation>();
  const browserContext =
    /(?:网页|网站|页面|浏览器|表单|按钮|链接|网址|地址栏|输入框|搜索框|菜单|下拉|选项|复选框|单选框|下一步|账号|密码|验证码|登录|购物车|订单|消息|https?:\/\/|www\.|[A-Za-z0-9.-]+\.(?:com|cn|net|org))|\b(?:web(?:site|page)?|browser|form|button|link|url|login|account|password|cart|checkout)\b/i.test(
      content,
    );
  const implementationDescription =
    /(?:修复|修改|开发|实现|优化|重构|排查|调试|代码|项目|组件|函数|逻辑|样式|bug|问题|卡住|卡顿|报错)/i.test(
      content,
    );
  const startsWithBrowserAction =
    /^\s*(?:(?:帮我|请|麻烦|替我|现在|直接|先|继续|开始)\s*)?(?:打开|访问|进入|导航到|前往|填写|输入|键入|点击|选择|提交|发送|登录|截图|open|visit|navigate|go to|fill|enter|type|click|select|submit|send|log in|screenshot)/i.test(
      content,
    );
  const politeBrowserAction =
    !implementationDescription &&
    /(?:帮我|请|麻烦|替我|现在|直接).{0,40}(?:打开|访问|进入|导航到|前往|填写|输入|键入|点击|选择|提交|发送|登录|截图|open|visit|navigate|go to|fill|enter|type|click|select|submit|send|log in|screenshot)/i.test(
      content,
    );
  if (!browserContext || (!startsWithBrowserAction && !politeBrowserAction))
    return operations;
  const asksForInformation =
    /(?:是否|有没有|是不是|为什么|怎么|如何|能不能|能否|会不会|是什么|了吗|了没)[^。！!]*[？?]?|[吗么][？?]?$|\?$/i.test(
      content.trim(),
    );
  const explicitRequest =
    /(?:帮我|请(?!问)|麻烦|要你|开始|继续|把|替我).{0,40}(?:打开|访问|进入|登录|点击|选择|填写|输入|提交|发送|截图|open|visit|navigate|log in|click|select|fill|enter|submit|send|screenshot)/i.test(
      content,
    );
  if (asksForInformation && !explicitRequest) return operations;

  const loginPageOnly = /登录(?:页|页面|界面)|\blogin page\b/i.test(content);
  if (
    /(?:打开|访问|进入|导航到|前往).{0,40}(?:网页|网站|页面|浏览器|https?:\/\/|www\.|[A-Za-z0-9.-]+\.(?:com|cn|net|org))|(?:打开|访问|进入|导航到|前往)\s*\S+|\b(?:open|visit|navigate to|go to)\b/i.test(
      content,
    ) ||
    (!loginPageOnly &&
      /(?:帮我|替我|请|现在|直接)?\s*登录\s*\S+/i.test(content))
  )
    operations.add("open");

  if (
    !loginPageOnly &&
    /(?:填写|输入|键入|登录)|\b(?:fill|enter|type|log in)\b/i.test(content)
  )
    operations.add("type");
  if (
    !loginPageOnly &&
    /(?:点击|选择|提交|发送|登录)|\b(?:click|select|submit|send|log in)\b/i.test(
      content,
    )
  )
    operations.add("click");
  if (
    operations.has("type") ||
    operations.has("click") ||
    /(?:查看|刷新|截图).{0,16}(?:网页|页面)|\b(?:snapshot|screenshot)\b/i.test(
      content,
    )
  )
    operations.add("verify");
  return operations;
}

export function successfulBrowserEvidence(
  history: BrowserVerificationHistoryItem[],
) {
  const calls = new Map<string, string>();
  for (const item of history)
    if (item.kind === "calls")
      for (const call of item.calls) calls.set(call.id, call.name);

  const operations = new Set<BrowserOperation>();
  let sequence = 0;
  let lastInteraction = -1;
  let lastVerification = -1;
  for (const item of history) {
    if (item.kind !== "result") continue;
    sequence += 1;
    let success = false;
    try {
      success = Boolean(
        (JSON.parse(item.content) as { success?: boolean }).success,
      );
    } catch {
      // Legacy unstructured output is not execution proof.
    }
    if (!success) continue;
    const name = calls.get(item.callId);
    let childEvidence: BrowserOperation[] = [];
    try {
      const data = (
        JSON.parse(item.content) as { data?: Record<string, unknown> }
      ).data;
      childEvidence = Array.isArray(data?.browserOperationEvidence)
        ? data.browserOperationEvidence.filter(
            (operation): operation is BrowserOperation =>
              ["open", "type", "click", "verify"].includes(String(operation)),
          )
        : [];
    } catch {
      // Ignore malformed optional child evidence.
    }
    if (name === "browser_open") operations.add("open");
    if (name === "browser_type") {
      operations.add("type");
      lastInteraction = sequence;
    }
    if (name === "browser_click") {
      operations.add("click");
      lastInteraction = sequence;
    }
    if (name === "browser_snapshot" || name === "browser_screenshot")
      lastVerification = sequence;
    for (const operation of childEvidence) {
      operations.add(operation);
      if (operation === "type" || operation === "click")
        lastInteraction = sequence;
      if (operation === "verify") lastVerification = sequence + 0.5;
    }
  }
  if (lastVerification > lastInteraction) operations.add("verify");
  return operations;
}

export function missingRequestedBrowserOperations(
  requested: ReadonlySet<BrowserOperation>,
  evidence: ReadonlySet<BrowserOperation>,
) {
  return [...requested].filter((operation) => !evidence.has(operation));
}

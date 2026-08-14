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
    /(?:修复|修改|改为|改成|切换为|替换为|开发|实现|优化|重构|排查|调试|代码|项目|组件|函数|逻辑|样式|页面交互|前端|弹窗|bug|问题|卡住|卡顿|报错|没出来|没有出来|没出现|未出现|没显示|不显示|没渲染|没反应|不生效|没生效|不见了|消失|加载不出|小程序|开发者工具|wxml|wxss)/i.test(
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

  // Self-report guard: the user describing an action they performed themselves
  // ("我现在用这个账号登录上去了") is NOT a request for the agent to drive a
  // browser. Requires a first-person subject + a browser verb immediately
  // followed by a completion marker (上去/了/过/成功…), and no explicit
  // agent-directed request phrasing ("帮我登录…").
  const selfReport =
    /(?:我|我们|俺|咱)(?:现在|已经|刚|刚才|之前|先|在)?.{0,30}(?:登录|打开|访问|进入|填写|输入|键入|点击|选择|提交|发送)(?:进去|进来|上去|上来)?(?:了|过|好|成功|完成|上去|上来)/i.test(
      content,
    );
  if (selfReport && !explicitRequest) return operations;

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

/** Browser actions the assistant says already happened in a completed turn. */
export function claimedBrowserOperations(text: string) {
  const proseText = text
    .replace(/```[\s\S]*?```/g, "")
    .replace(
      /(?:如果|若|假如|一旦|\bif\b|\bwhen\b)[^。！？!?\n]{0,160}[。！？!?]?/gi,
      "",
    );
  const assertedText = proseText.replace(
    /(?:未|没有|尚未|无法|不能|并未).{0,10}(?:打开|访问|进入|导航|填写|输入|键入|登录|点击|选择|提交|发送|验证|确认|检查|刷新|截图)|\b(?:not|never|did not|could not|unable to)\b[^.!?\n]{0,40}\b(?:open|visit|navigate|fill|enter|type|log in|click|select|submit|verify|capture)\b/gi,
    "",
  );
  const operations = new Set<BrowserOperation>();
  // Classify each assertion independently. Generic backend prose such as
  // "已输入记录 ID，提交数据库查询并确认返回结果" must never inherit browser
  // meaning from another sentence or from the verbs alone.
  const assertions = assertedText
    .split(/[。！？!?；;\n]+/)
    .map((value) => value.trim())
    .filter(Boolean);
  for (const assertion of assertions) {
    const browserUiContext =
      /(?:网页|网站|页面|浏览器|表单|按钮|链接|网址|地址栏|输入框|搜索框|菜单|下拉|选项|复选框|单选框|下一步|购物车|结算页)|\b(?:web(?:site|page)?|browser|form|button|link|url|input (?:field|box)|menu|dropdown|checkbox|radio|next step)\b/i.test(
        assertion,
      );
    const browserAddressAction =
      /(?:我|我们)?(?:已|已经)(?:成功)?(?:打开|访问|进入|导航到).{0,28}(?:https?:\/\/|www\.|[A-Za-z0-9.-]+\.(?:com|cn|net|org))|(?:我|我们)(?:已经|已)?(?:打开|访问|进入|导航到)(?:了|过).{0,28}(?:https?:\/\/|www\.|[A-Za-z0-9.-]+\.(?:com|cn|net|org))|\b(?:i|we)(?:'ve| have)?\s+(?:opened|visited|navigated to)\s+(?:https?:\/\/|www\.|[A-Za-z0-9.-]+\.(?:com|cn|net|org))/i.test(
        assertion,
      );
    const strongBrowserContext = browserUiContext || browserAddressAction;
    const authenticationContext =
      /(?:账号|密码|验证码|登录)|\b(?:account|password|captcha|log(?:ged)? in)\b/i.test(
        assertion,
      );
    const nonBrowserTechnicalContext =
      /(?:SSH|MySQL|SQL\s*Server|MongoDB|数据库|数据表|SQL|接口|API|请求|响应|返回值|记录\s*ID|配置文件|环境变量|命令|脚本|队列|服务端)|\b(?:database|query|request|response|record id|config(?:uration)?|environment variable|command|script|queue|server)\b/i.test(
        assertion,
      );
    // A bare "登录成功" is only accepted for a first-person performed action.
    // SSH/database login statements are explicitly excluded unless the same
    // assertion also names a browser or page.
    const loginCompleted =
      (!nonBrowserTechnicalContext || strongBrowserContext) &&
      (/(?:我|我们)(?:现在|已经|已|刚|刚才)?.{0,6}(?:成功)?登录(?!页|页面|界面)/i.test(
        assertion,
      ) ||
        /(?:已|已经)成功登录(?!页|页面|界面)/i.test(assertion) ||
        /登录成功.{0,12}(?:网站|网页|浏览器|https?:\/\/)|(?:网站|网页|浏览器|https?:\/\/).{0,12}(?:登录成功|已登录)/i.test(
          assertion,
        ) ||
        /\b(?:i|we)(?:'ve| have)?\s+logged in\b/i.test(assertion));
    const browserContext =
      strongBrowserContext ||
      (authenticationContext && !nonBrowserTechnicalContext) ||
      loginCompleted;
    if (!browserContext) continue;

    const opened =
      /(?:我|我们)?(?:已|已经)(?:成功)?(?:打开|访问|进入|导航到).{0,28}(?:网页|网站|页面|浏览器|https?:\/\/)|(?:我|我们)(?:已经|已)?(?:打开|访问|进入|导航到)(?:了|过).{0,28}(?:网页|网站|页面|浏览器|https?:\/\/)|(?:网页|网站|页面).{0,14}(?:已打开|打开成功|已进入)|\b(?:opened|visited|navigated to)\s+(?:the\s+)?(?:web(?:site|page)?|browser|https?:\/\/)/i.test(
        assertion,
      );
    if (opened) operations.add("open");

    const typed =
      /(?:我|我们)?(?:已|已经)(?:成功)?(?:填写|输入|键入)|(?:我|我们)(?:已经|已)?(?:填写|输入|键入)(?:了|过)|(?:表单|账号|密码|验证码|输入框|搜索框).{0,14}(?:已填写|已输入|填写完成|输入完成)|\b(?:i|we)(?:'ve| have)?\s+(?:filled|entered|typed)\b|\b(?:form|account|password|input)\b.{0,20}\b(?:was|has been)\s+(?:filled|entered|typed)\b/i.test(
        assertion,
      ) ||
      (opened &&
        /(?:填写|输入|键入)|\b(?:fill|enter|type)\b/i.test(assertion)) ||
      loginCompleted;
    if (typed) operations.add("type");

    const clicked =
      /(?:我|我们)?(?:已|已经)(?:成功)?(?:点击|选择|提交|发送)|(?:我|我们)(?:已经|已)?(?:点击|选择|提交|发送)(?:了|过)|(?:按钮|菜单|选项|表单).{0,14}(?:已点击|已选择|已提交)|\b(?:i|we)(?:'ve| have)?\s+(?:clicked|selected|submitted|sent)\b/i.test(
        assertion,
      ) ||
      (opened &&
        /(?:点击|选择|提交|发送)|\b(?:click|select|submit|send)\b/i.test(
          assertion,
        )) ||
      loginCompleted;
    if (clicked) operations.add("click");

    if (
      /(?:我|我们)?(?:已|已经)(?:成功)?(?:验证|确认|检查|刷新|截图).{0,20}(?:网页|网站|页面|页面结果|页面状态)|(?:网页|网站|页面).{0,16}(?:验证通过|确认正常|截图完成|显示正常)|\b(?:verified|confirmed|captured)\s+(?:the\s+)?(?:page|screenshot)\b/i.test(
        assertion,
      ) ||
      ((typed || clicked) &&
        /(?:最后|随后|然后|并)?(?:验证|确认|检查|刷新|截图).{0,20}(?:网页|网站|页面|结果|状态)|(?:页面|结果|状态).{0,12}(?:正常|成功|通过)/i.test(
          assertion,
        )) ||
      loginCompleted
    )
      operations.add("verify");
  }
  return operations;
}

export function reportsMissingBrowserTarget(text: string) {
  return /(?:未|没有|缺少|未提供|没有提供|找不到|无法确定).{0,28}(?:URL|网址|网页地址|页面地址|网页链接|页面链接|目标页面|点击目标)|(?:URL|网址|网页地址|页面地址|网页链接|页面链接|目标页面|点击目标).{0,20}(?:未|没有|缺少|未提供|不明确|无法确定)/i.test(
    text,
  );
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

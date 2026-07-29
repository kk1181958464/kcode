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

type VerificationMessage = Extract<
  BrowserVerificationHistoryItem,
  { kind: "message" }
>;

const CONTINUATION_REQUEST =
  /^(?:好|好的|可以|行|继续|继续吧|开始|开始吧|执行吧|就这么做|按(?:你|上面|这个).{0,12}做|都弄|全部(?:做|弄))(?:了|吧|啊|呀)?[。！!，,\s]*$/i;

function relevantRequestContent(history: BrowserVerificationHistoryItem[]) {
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

export function requestedBrowserOperations(
  history: BrowserVerificationHistoryItem[],
) {
  const content = relevantRequestContent(history);
  const operations = new Set<BrowserOperation>();
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

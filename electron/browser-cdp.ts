export type CdpAxValue = { value?: unknown };

export type CdpAxNode = {
  nodeId?: string;
  ignored?: boolean;
  role?: CdpAxValue;
  name?: CdpAxValue;
  description?: CdpAxValue;
  value?: CdpAxValue;
  properties?: { name?: string; value?: CdpAxValue }[];
  backendDOMNodeId?: number;
  frameId?: string;
};

export type BrowserAccessibilityEntry = {
  backendNodeId: number;
  role: string;
  name: string;
  value: string;
  description: string;
  disabled?: boolean;
  checked?: string;
  expanded?: boolean;
  selected?: boolean;
  sensitive?: boolean;
};

export type BrowserVerificationKind =
  "captcha" | "one-time-code" | "passkey" | "two-factor" | "security-check";

export type BrowserVerification = {
  kind: BrowserVerificationKind;
  message: string;
};

const INTERACTIVE_ROLES = new Set([
  "button",
  "checkbox",
  "combobox",
  "iframe",
  "link",
  "listbox",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "option",
  "radio",
  "searchbox",
  "slider",
  "spinbutton",
  "switch",
  "tab",
  "textbox",
  "treeitem",
]);

const SILENT_TEXT_ROLES = new Set([
  "generic",
  "group",
  "none",
  "presentation",
  "rootwebarea",
  "webarea",
]);

const textValue = (value: CdpAxValue | undefined) =>
  value?.value === undefined || value.value === null
    ? ""
    : String(value.value).replace(/\s+/g, " ").trim();

function propertyValue(node: CdpAxNode, name: string) {
  return node.properties?.find((property) => property.name === name)?.value
    ?.value;
}

export function extractAccessibilityFrame(nodes: CdpAxNode[]) {
  const entries: BrowserAccessibilityEntry[] = [];
  const text: string[] = [];
  const seenText = new Set<string>();
  for (const node of nodes) {
    if (node.ignored) continue;
    const role = textValue(node.role).toLowerCase();
    const name = textValue(node.name);
    const value = textValue(node.value);
    const description = textValue(node.description);
    const focusable = propertyValue(node, "focusable") === true;
    const editable = propertyValue(node, "editable");
    const settable = propertyValue(node, "settable") === true;
    const sensitive = propertyValue(node, "protected") === true;
    if (
      node.backendDOMNodeId &&
      (INTERACTIVE_ROLES.has(role) ||
        focusable ||
        Boolean(editable) ||
        settable)
    ) {
      entries.push({
        backendNodeId: node.backendDOMNodeId,
        role: role || "element",
        name,
        value,
        description,
        disabled: propertyValue(node, "disabled") === true ? true : undefined,
        checked:
          propertyValue(node, "checked") === undefined
            ? undefined
            : String(propertyValue(node, "checked")),
        expanded:
          propertyValue(node, "expanded") === undefined
            ? undefined
            : Boolean(propertyValue(node, "expanded")),
        selected:
          propertyValue(node, "selected") === undefined
            ? undefined
            : Boolean(propertyValue(node, "selected")),
        sensitive: sensitive ? true : undefined,
      });
    }
    for (const candidate of [name, sensitive ? "" : value, description]) {
      if (
        candidate &&
        !SILENT_TEXT_ROLES.has(role) &&
        !seenText.has(candidate)
      ) {
        seenText.add(candidate);
        text.push(candidate);
      }
    }
  }
  return { entries, text };
}

export function boxModelCenter(model: {
  border?: number[];
  padding?: number[];
  content?: number[];
}) {
  const quad = model.border ?? model.padding ?? model.content;
  if (!quad || quad.length < 8) throw new Error("页面元素没有可点击区域");
  const xs = [quad[0], quad[2], quad[4], quad[6]];
  const ys = [quad[1], quad[3], quad[5], quad[7]];
  return {
    x: Math.round((Math.min(...xs) + Math.max(...xs)) / 2),
    y: Math.round((Math.min(...ys) + Math.max(...ys)) / 2),
  };
}

export function detectHumanVerification(input: {
  text: string;
  title?: string;
  url?: string;
  elements?: { text?: unknown; name?: unknown; frame?: unknown }[];
}): BrowserVerification | undefined {
  const text = String(input.text || "").slice(0, 40_000);
  const title = String(input.title || "");
  const url = String(input.url || "");
  const controls = (input.elements || [])
    .map((element) =>
      [element.text, element.name]
        .filter((value) => typeof value === "string")
        .join(" "),
    )
    .join("\n");
  const frameUrls = (input.elements || [])
    .map((element) => element.frame)
    .filter((value) => typeof value === "string")
    .join("\n");
  const page = `${title}\n${text}`;
  const combined = `${page}\n${controls}\n${frameUrls}\n${url}`;
  const captcha =
    /验证码|人机验证|滑块验证|图形验证|captcha|recaptcha|hcaptcha|turnstile|verify you are human|not a robot|challenge-platform/i;
  const oneTimeCode =
    /(?:短信|邮箱|邮件|动态|一次性|verification|security|one[- ]time|otp).{0,16}(?:验证码|校验码|code|密码)|(?:验证码|校验码|code).{0,16}(?:短信|邮箱|邮件|verification|security|one[- ]time|otp)/i;
  const passkey = /passkey|通行密钥|安全密钥|security key/i;
  const twoFactor =
    /two[- ]factor|two step|2fa|二次验证|双重验证|两步验证|身份验证器|authenticator/i;
  const securityCheck =
    /cloudflare|security verification|安全验证|安全检查|checking your browser|just a moment/i;
  const verificationTerm = new RegExp(
    [
      captcha.source,
      oneTimeCode.source,
      passkey.source,
      twoFactor.source,
      securityCheck.source,
    ].join("|"),
    "i",
  );
  if (!verificationTerm.test(combined)) return undefined;

  const actionCue =
    /请输入|请完成|请验证|拖动|滑动|点击验证|完成验证|enter|complete|continue with|verify|checking|confirm|use your/i.test(
      page,
    );
  const controlCue = verificationTerm.test(controls);
  const locationCue =
    /captcha|recaptcha|hcaptcha|turnstile|challenge|verify|verification|two-factor|2fa|passkey/i.test(
      `${url}\n${frameUrls}`,
    );
  const titleCue =
    /验证|captcha|verify|verification|two-factor|2fa|passkey|just a moment|security check/i.test(
      title,
    );
  const intrinsicallyActionable =
    /verify you are human|请输入.{0,12}(?:验证码|校验码)|拖动.{0,12}滑块|checking your browser/i.test(
      page,
    );
  const score =
    (intrinsicallyActionable ? 3 : actionCue ? 2 : 0) +
    (controlCue ? 2 : 0) +
    (locationCue ? 2 : 0) +
    (titleCue ? 1 : 0);
  if (!(actionCue || intrinsicallyActionable || controlCue) || score < 3)
    return undefined;

  if (passkey.test(combined))
    return { kind: "passkey", message: "请完成通行密钥或安全密钥验证" };
  if (twoFactor.test(combined))
    return { kind: "two-factor", message: "请完成双重验证" };
  if (oneTimeCode.test(combined))
    return { kind: "one-time-code", message: "请输入收到的一次性验证码" };
  if (captcha.test(combined))
    return { kind: "captcha", message: "请完成人机验证" };
  return { kind: "security-check", message: "请完成网页安全验证" };
}

export function isLikelyHumanVerification(text: string) {
  return /验证码|人机验证|短信验证|二次验证|安全验证|滑块验证|captcha|verify you are human|challenge-platform|two[- ]factor|\b2fa\b|cloudflare/i.test(
    text,
  );
}

export function hasUserSuppliedVerificationCode(
  messages: { role: string; content: string }[],
) {
  let latestUserIndex = messages.length - 1;
  while (latestUserIndex >= 0 && messages[latestUserIndex].role !== "user")
    latestUserIndex -= 1;
  if (latestUserIndex < 0) return false;
  const latest = messages[latestUserIndex].content.trim();
  const code = /\b\d{4,10}\b/;
  const cue =
    /验证码|校验码|动态码|短信码|邮件码|一次性密码|otp|2fa|verification code|security code|one[- ]time code/i;
  if (cue.test(latest) && code.test(latest)) return true;
  if (!/^\d{4,10}$/.test(latest)) return false;
  return messages
    .slice(Math.max(0, latestUserIndex - 3), latestUserIndex)
    .some((message) => cue.test(message.content));
}

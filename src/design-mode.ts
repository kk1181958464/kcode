/** Design Mode v1 — click-to-context helpers (pure, testable). */

export type DesignElementBoundingBox = {
  x: number;
  y: number;
  width: number;
  height: number;
  top: number;
  left: number;
  right: number;
  bottom: number;
};

export type DesignElementContext = {
  id: string;
  capturedAt: number;
  tagName: string;
  elementId?: string;
  classes: string[];
  textSnippet: string;
  boundingBox: DesignElementBoundingBox;
  cssSelector: string;
  xpath: string;
  outerHTML?: string;
  pageUrl?: string;
  pageTitle?: string;
  role?: string;
  name?: string;
  type?: string;
};

export type DesignElementCaptureInput = {
  tagName?: unknown;
  elementId?: unknown;
  id?: unknown;
  classes?: unknown;
  className?: unknown;
  textSnippet?: unknown;
  text?: unknown;
  boundingBox?: Partial<DesignElementBoundingBox> | null;
  cssSelector?: unknown;
  xpath?: unknown;
  outerHTML?: unknown;
  pageUrl?: unknown;
  pageTitle?: unknown;
  role?: unknown;
  name?: unknown;
  type?: unknown;
  capturedAt?: unknown;
};

export const DESIGN_PICK_CONSOLE_PREFIX = "__kcode_design_pick__:";
export const MAX_DESIGN_OUTER_HTML = 1200;
export const MAX_DESIGN_TEXT_SNIPPET = 160;
export const MAX_DESIGN_ELEMENTS = 5;

const asString = (value: unknown, fallback = "") =>
  typeof value === "string"
    ? value
    : value === undefined || value === null
      ? fallback
      : String(value);

function clampNumber(value: unknown, fallback = 0) {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeClasses(input: DesignElementCaptureInput): string[] {
  if (Array.isArray(input.classes))
    return input.classes
      .map((item) => asString(item).trim())
      .filter(Boolean)
      .slice(0, 24);
  const className = asString(input.className).trim();
  if (!className) return [];
  return className
    .split(/\s+/)
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 24);
}

function normalizeBoundingBox(
  box: DesignElementCaptureInput["boundingBox"],
): DesignElementBoundingBox {
  const width = Math.max(0, clampNumber(box?.width));
  const height = Math.max(0, clampNumber(box?.height));
  const left = clampNumber(box?.left ?? box?.x);
  const top = clampNumber(box?.top ?? box?.y);
  return {
    x: clampNumber(box?.x, left),
    y: clampNumber(box?.y, top),
    width,
    height,
    top,
    left,
    right: clampNumber(box?.right, left + width),
    bottom: clampNumber(box?.bottom, top + height),
  };
}

function escapeCssIdent(value: string) {
  return value.replace(/([^\w-])/g, "\\$1");
}

/** Build a readable CSS selector from tag/id/classes (no live DOM). */
export function buildCssSelectorFromParts(input: {
  tagName: string;
  elementId?: string;
  classes?: string[];
}): string {
  const tag = (input.tagName || "div").toLowerCase();
  const id = (input.elementId || "").trim();
  if (id && /^[A-Za-z_][\w:-]*$/.test(id)) return `${tag}#${escapeCssIdent(id)}`;
  const classes = (input.classes || [])
    .map((item) => item.trim())
    .filter((item) => item && !item.startsWith("__kcode"))
    .slice(0, 3);
  if (classes.length)
    return `${tag}${classes.map((c) => `.${escapeCssIdent(c)}`).join("")}`;
  return tag;
}

/** Escape a value for use inside an XPath string literal. */
export function xpathStringLiteral(value: string): string {
  if (!value.includes("'")) return `'${value}'`;
  if (!value.includes('"')) return `"${value}"`;
  return `concat('${value.split("'").join("',\"'\",'")}')`;
}

export function buildXPathFromParts(input: {
  tagName: string;
  elementId?: string;
  classes?: string[];
  textSnippet?: string;
}): string {
  const tag = (input.tagName || "*").toLowerCase();
  const id = (input.elementId || "").trim();
  if (id) return `//*[@id=${xpathStringLiteral(id)}]`;
  const classes = (input.classes || []).filter(
    (item) => item && !item.startsWith("__kcode"),
  );
  if (classes[0])
    return `//${tag}[contains(concat(' ', normalize-space(@class), ' '), ${xpathStringLiteral(` ${classes[0]} `)})]`;
  const text = (input.textSnippet || "").trim().slice(0, 40);
  if (text)
    return `//${tag}[contains(normalize-space(.), ${xpathStringLiteral(text)})]`;
  return `//${tag}`;
}

export function designElementChipLabel(element: DesignElementContext): string {
  const tag = element.tagName || "element";
  if (element.elementId) return `${tag}#${element.elementId}`;
  if (element.classes[0]) return `${tag}.${element.classes[0]}`;
  if (element.textSnippet) {
    const text =
      element.textSnippet.length > 18
        ? `${element.textSnippet.slice(0, 18)}…`
        : element.textSnippet;
    return `${tag} “${text}”`;
  }
  return tag;
}

export function serializeDesignElementForAgent(
  element: DesignElementContext,
): string {
  const lines = [
    `<design_element>`,
    `tag: ${element.tagName}`,
    element.elementId ? `id: ${element.elementId}` : "",
    element.classes.length ? `classes: ${element.classes.join(" ")}` : "",
    element.role ? `role: ${element.role}` : "",
    element.name ? `name: ${element.name}` : "",
    element.type ? `type: ${element.type}` : "",
    element.textSnippet ? `text: ${element.textSnippet}` : "",
    `cssSelector: ${element.cssSelector}`,
    `xpath: ${element.xpath}`,
    `boundingBox: ${JSON.stringify(element.boundingBox)}`,
    element.pageUrl ? `pageUrl: ${element.pageUrl}` : "",
    element.pageTitle ? `pageTitle: ${element.pageTitle}` : "",
    element.outerHTML ? `outerHTML:\n${element.outerHTML}` : "",
    `</design_element>`,
  ].filter(Boolean);
  return lines.join("\n");
}

export function serializeDesignElementsForAgent(
  elements: DesignElementContext[],
): string {
  if (!elements.length) return "";
  return elements.map(serializeDesignElementForAgent).join("\n\n");
}

let designIdCounter = 0;
export function nextDesignElementId(now = Date.now()): string {
  designIdCounter += 1;
  return `design:${now.toString(36)}:${designIdCounter.toString(36)}`;
}

/** Normalize a raw page capture into a stable DesignElementContext. */
export function normalizeDesignElementCapture(
  input: DesignElementCaptureInput,
  options?: { id?: string; capturedAt?: number },
): DesignElementContext {
  const tagName = asString(input.tagName || "div").toLowerCase() || "div";
  const elementId =
    asString(input.elementId || input.id).trim() || undefined;
  const classes = normalizeClasses(input).filter(
    (item) => !item.startsWith("__kcode"),
  );
  const textSnippet = asString(input.textSnippet || input.text)
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_DESIGN_TEXT_SNIPPET);
  const boundingBox = normalizeBoundingBox(input.boundingBox);
  const cssSelector =
    asString(input.cssSelector).trim() ||
    buildCssSelectorFromParts({ tagName, elementId, classes });
  const xpath =
    asString(input.xpath).trim() ||
    buildXPathFromParts({ tagName, elementId, classes, textSnippet });
  const outerHTMLRaw = asString(input.outerHTML);
  const outerHTML = outerHTMLRaw
    ? outerHTMLRaw.slice(0, MAX_DESIGN_OUTER_HTML)
    : undefined;
  const capturedAt =
    options?.capturedAt ??
    (Number.isFinite(Number(input.capturedAt))
      ? Number(input.capturedAt)
      : Date.now());
  return {
    id: options?.id || nextDesignElementId(capturedAt),
    capturedAt,
    tagName,
    elementId,
    classes,
    textSnippet,
    boundingBox,
    cssSelector,
    xpath,
    outerHTML,
    pageUrl: asString(input.pageUrl).trim() || undefined,
    pageTitle: asString(input.pageTitle).trim() || undefined,
    role: asString(input.role).trim() || undefined,
    name: asString(input.name).trim() || undefined,
    type: asString(input.type).trim() || undefined,
  };
}

export function parseDesignPickConsoleMessage(
  message: string,
): DesignElementCaptureInput | undefined {
  const text = asString(message);
  if (!text.startsWith(DESIGN_PICK_CONSOLE_PREFIX)) return undefined;
  const payload = text.slice(DESIGN_PICK_CONSOLE_PREFIX.length);
  try {
    const parsed = JSON.parse(payload) as DesignElementCaptureInput;
    if (!parsed || typeof parsed !== "object") return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

export function mergeDesignElements(
  existing: DesignElementContext[],
  next: DesignElementContext,
  limit = MAX_DESIGN_ELEMENTS,
): DesignElementContext[] {
  const withoutDup = existing.filter(
    (item) =>
      !(
        item.cssSelector === next.cssSelector &&
        item.xpath === next.xpath &&
        item.textSnippet === next.textSnippet
      ),
  );
  return [...withoutDup, next].slice(-limit);
}

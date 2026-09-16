import { DESIGN_PICK_CONSOLE_PREFIX, MAX_DESIGN_OUTER_HTML, MAX_DESIGN_TEXT_SNIPPET } from "../src/design-mode";

/**
 * Self-contained page script for Design Mode v1.
 * Injected via webContents.executeJavaScript; no bundler imports at runtime.
 */
export function designModeInjectSource(enabled: boolean): string {
  return `(() => {
  const PREFIX = ${JSON.stringify(DESIGN_PICK_CONSOLE_PREFIX)};
  const MAX_HTML = ${MAX_DESIGN_OUTER_HTML};
  const MAX_TEXT = ${MAX_DESIGN_TEXT_SNIPPET};
  const STYLE_ID = "__kcode-design-style";
  const HOVER_ATTR = "data-kcode-design-hover";
  const SELECTED_ATTR = "data-kcode-design-selected";
  const root = window;
  const existing = root.__kcodeDesignMode;

  function cleanup() {
    if (!existing) return;
    try {
      document.removeEventListener("click", existing.onClick, true);
      document.removeEventListener("pointerdown", existing.onPointerDown, true);
      document.removeEventListener("mouseover", existing.onMouseOver, true);
      document.removeEventListener("mouseout", existing.onMouseOut, true);
      document.removeEventListener("keydown", existing.onKeyDown, true);
    } catch (_) {}
    try {
      document.querySelectorAll("[" + HOVER_ATTR + "],[" + SELECTED_ATTR + "]").forEach((el) => {
        el.removeAttribute(HOVER_ATTR);
        el.removeAttribute(SELECTED_ATTR);
      });
    } catch (_) {}
    try {
      document.getElementById(STYLE_ID)?.remove();
    } catch (_) {}
    try {
      document.documentElement.style.cursor = existing.prevCursor || "";
    } catch (_) {}
    root.__kcodeDesignMode = undefined;
  }

  if (!${enabled ? "true" : "false"}) {
    cleanup();
    return { enabled: false };
  }
  if (existing && existing.enabled) return { enabled: true, already: true };

  cleanup();

  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = [
    "[" + HOVER_ATTR + "]{outline:2px solid rgba(59,130,246,.85)!important;outline-offset:2px!important;cursor:crosshair!important;}",
    "[" + SELECTED_ATTR + "]{outline:2px solid rgba(16,185,129,.95)!important;outline-offset:2px!important;box-shadow:0 0 0 4px rgba(16,185,129,.22)!important;}",
    "html.__kcode-design-on,html.__kcode-design-on *{cursor:crosshair!important;}"
  ].join("");
  (document.head || document.documentElement).appendChild(style);
  document.documentElement.classList.add("__kcode-design-on");
  const prevCursor = document.documentElement.style.cursor;
  document.documentElement.style.cursor = "crosshair";

  function cssEscape(value) {
    if (window.CSS && typeof CSS.escape === "function") return CSS.escape(value);
    return String(value).replace(/[^a-zA-Z0-9_-]/g, "\\\\$&");
  }

  function collectClasses(el) {
    const list = [];
    if (!el || !el.classList) return list;
    for (const name of el.classList) {
      if (!name || String(name).startsWith("__kcode")) continue;
      list.push(String(name));
      if (list.length >= 8) break;
    }
    return list;
  }

  function buildCssSelector(el) {
    if (!(el instanceof Element)) return "";
    if (el.id && /^[A-Za-z_][\\w:-]*$/.test(el.id))
      return el.tagName.toLowerCase() + "#" + cssEscape(el.id);
    const parts = [];
    let node = el;
    let depth = 0;
    while (node && node.nodeType === 1 && depth < 5 && node !== document.body && node !== document.documentElement) {
      const tag = node.tagName.toLowerCase();
      let part = tag;
      if (node.id && /^[A-Za-z_][\\w:-]*$/.test(node.id)) {
        parts.unshift(tag + "#" + cssEscape(node.id));
        break;
      }
      const classes = collectClasses(node).slice(0, 2);
      if (classes.length) part += classes.map((c) => "." + cssEscape(c)).join("");
      else {
        const parent = node.parentElement;
        if (parent) {
          const siblings = Array.from(parent.children).filter((child) => child.tagName === node.tagName);
          if (siblings.length > 1) {
            const index = siblings.indexOf(node) + 1;
            part += ":nth-of-type(" + index + ")";
          }
        }
      }
      parts.unshift(part);
      node = node.parentElement;
      depth += 1;
    }
    return parts.join(" > ");
  }

  function buildXPath(el) {
    if (!(el instanceof Element)) return "";
    if (el.id) return '//*[@id="' + String(el.id).replace(/"/g, '\\\\"') + '"]';
    const segments = [];
    let node = el;
    let depth = 0;
    while (node && node.nodeType === 1 && depth < 8) {
      const tag = node.tagName.toLowerCase();
      const parent = node.parentElement;
      let segment = tag;
      if (parent) {
        const siblings = Array.from(parent.children).filter((child) => child.tagName === node.tagName);
        if (siblings.length > 1) {
          segment += "[" + (siblings.indexOf(node) + 1) + "]";
        }
      }
      segments.unshift(segment);
      if (!parent || parent === document.documentElement) break;
      node = parent;
      depth += 1;
    }
    return "/" + segments.join("/");
  }

  function textOf(el) {
    try {
      const raw = (el.innerText || el.textContent || el.getAttribute?.("aria-label") || el.getAttribute?.("title") || el.value || "");
      return String(raw).replace(/\\s+/g, " ").trim().slice(0, MAX_TEXT);
    } catch (_) {
      return "";
    }
  }

  function capture(el) {
    const rect = el.getBoundingClientRect();
    let outer = "";
    try {
      outer = String(el.outerHTML || "").slice(0, MAX_HTML);
    } catch (_) {}
    return {
      tagName: String(el.tagName || "div").toLowerCase(),
      elementId: el.id ? String(el.id) : "",
      classes: collectClasses(el),
      textSnippet: textOf(el),
      boundingBox: {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        top: Math.round(rect.top),
        left: Math.round(rect.left),
        right: Math.round(rect.right),
        bottom: Math.round(rect.bottom),
      },
      cssSelector: buildCssSelector(el),
      xpath: buildXPath(el),
      outerHTML: outer,
      pageUrl: String(location.href || ""),
      pageTitle: String(document.title || ""),
      role: el.getAttribute?.("role") || "",
      name: el.getAttribute?.("name") || "",
      type: el.getAttribute?.("type") || "",
      capturedAt: Date.now(),
    };
  }

  function clearHover() {
    document.querySelectorAll("[" + HOVER_ATTR + "]").forEach((el) => el.removeAttribute(HOVER_ATTR));
  }

  function onMouseOver(event) {
    const el = event.target;
    if (!(el instanceof Element)) return;
    clearHover();
    if (!el.hasAttribute(SELECTED_ATTR)) el.setAttribute(HOVER_ATTR, "1");
  }

  function onMouseOut(event) {
    const el = event.target;
    if (el instanceof Element) el.removeAttribute(HOVER_ATTR);
  }

  function onPointerDown(event) {
    if (event.button !== undefined && event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    if (typeof event.stopImmediatePropagation === "function") event.stopImmediatePropagation();
  }

  function onClick(event) {
    if (event.button !== undefined && event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    if (typeof event.stopImmediatePropagation === "function") event.stopImmediatePropagation();
    const el = event.target;
    if (!(el instanceof Element)) return;
    document.querySelectorAll("[" + SELECTED_ATTR + "]").forEach((node) => node.removeAttribute(SELECTED_ATTR));
    el.removeAttribute(HOVER_ATTR);
    el.setAttribute(SELECTED_ATTR, "1");
    try {
      console.debug(PREFIX + JSON.stringify(capture(el)));
    } catch (_) {}
  }

  function onKeyDown(event) {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      cleanup();
      try { console.debug(PREFIX + JSON.stringify({ __kcodeDesignDisabled: true })); } catch (_) {}
    }
  }

  document.addEventListener("click", onClick, true);
  document.addEventListener("pointerdown", onPointerDown, true);
  document.addEventListener("mouseover", onMouseOver, true);
  document.addEventListener("mouseout", onMouseOut, true);
  document.addEventListener("keydown", onKeyDown, true);

  root.__kcodeDesignMode = {
    enabled: true,
    prevCursor,
    onClick,
    onPointerDown,
    onMouseOver,
    onMouseOut,
    onKeyDown,
    disable: cleanup,
  };
  return { enabled: true };
})()`;
}

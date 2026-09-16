import test from "node:test";
import assert from "node:assert/strict";
import {
  DESIGN_PICK_CONSOLE_PREFIX,
  buildCssSelectorFromParts,
  buildXPathFromParts,
  designElementChipLabel,
  mergeDesignElements,
  normalizeDesignElementCapture,
  parseDesignPickConsoleMessage,
  serializeDesignElementForAgent,
  serializeDesignElementsForAgent,
  xpathStringLiteral,
} from "../src/design-mode";
import { designModeInjectSource } from "./design-mode-inject";

test("buildCssSelectorFromParts prefers id then classes", () => {
  assert.equal(
    buildCssSelectorFromParts({
      tagName: "BUTTON",
      elementId: "save-btn",
      classes: ["primary"],
    }),
    "button#save-btn",
  );
  assert.equal(
    buildCssSelectorFromParts({
      tagName: "button",
      classes: ["btn", "primary", "extra"],
    }),
    "button.btn.primary.extra",
  );
  assert.equal(
    buildCssSelectorFromParts({
      tagName: "button",
      classes: ["btn", "primary"],
    }),
    "button.btn.primary",
  );
  assert.equal(buildCssSelectorFromParts({ tagName: "span" }), "span");
});

test("buildXPathFromParts and xpathStringLiteral escape quotes", () => {
  assert.equal(
    buildXPathFromParts({ tagName: "div", elementId: "hero" }),
    "//*[@id='hero']",
  );
  assert.equal(
    buildXPathFromParts({ tagName: "a", classes: ["nav-link"] }),
    "//a[contains(concat(' ', normalize-space(@class), ' '), ' nav-link ')]",
  );
  assert.equal(xpathStringLiteral("it's"), `"it's"`);
  assert.ok(xpathStringLiteral(`a'b"c`).startsWith("concat("));
});

test("normalizeDesignElementCapture fills selectors and truncates", () => {
  const element = normalizeDesignElementCapture(
    {
      tagName: "BUTTON",
      elementId: "ok",
      classes: ["cta", "__kcode-design-highlight"],
      textSnippet: "  确认提交  ",
      boundingBox: { x: 10, y: 20, width: 100, height: 40 },
      outerHTML: `<button id="ok" class="cta">${"x".repeat(5000)}</button>`,
      pageUrl: "https://example.com/app",
      pageTitle: "Demo",
    },
    { id: "design:test", capturedAt: 1 },
  );
  assert.equal(element.id, "design:test");
  assert.equal(element.tagName, "button");
  assert.equal(element.elementId, "ok");
  assert.deepEqual(element.classes, ["cta"]);
  assert.equal(element.textSnippet, "确认提交");
  assert.equal(element.cssSelector, "button#ok");
  assert.equal(element.xpath, "//*[@id='ok']");
  assert.ok((element.outerHTML?.length || 0) <= 1200);
  assert.equal(element.boundingBox.width, 100);
  assert.equal(element.pageUrl, "https://example.com/app");
});

test("serializeDesignElementForAgent is readable for the model", () => {
  const element = normalizeDesignElementCapture(
    {
      tagName: "button",
      elementId: "send",
      classes: ["primary"],
      textSnippet: "发送",
      cssSelector: "button#send",
      xpath: "//*[@id='send']",
      boundingBox: {
        x: 1,
        y: 2,
        width: 3,
        height: 4,
        top: 2,
        left: 1,
        right: 4,
        bottom: 6,
      },
    },
    { id: "design:1", capturedAt: 10 },
  );
  const text = serializeDesignElementForAgent(element);
  assert.match(text, /<design_element>/);
  assert.match(text, /tag: button/);
  assert.match(text, /id: send/);
  assert.match(text, /cssSelector: button#send/);
  assert.match(text, /xpath: \/\/\*\[@id='send'\]/);
  assert.match(text, /text: 发送/);
  assert.equal(designElementChipLabel(element), "button#send");
  assert.match(
    serializeDesignElementsForAgent([element]),
    /<design_element>/,
  );
});

test("parseDesignPickConsoleMessage reads prefixed JSON", () => {
  const payload = {
    tagName: "a",
    elementId: "home",
    classes: ["link"],
    textSnippet: "首页",
  };
  const parsed = parseDesignPickConsoleMessage(
    DESIGN_PICK_CONSOLE_PREFIX + JSON.stringify(payload),
  );
  assert.equal(parsed?.tagName, "a");
  assert.equal(parseDesignPickConsoleMessage("noise"), undefined);
  assert.equal(
    parseDesignPickConsoleMessage(DESIGN_PICK_CONSOLE_PREFIX + "{"),
    undefined,
  );
});

test("mergeDesignElements de-dupes and caps", () => {
  const a = normalizeDesignElementCapture(
    { tagName: "button", elementId: "a", cssSelector: "button#a", xpath: "//*[@id='a']" },
    { id: "1", capturedAt: 1 },
  );
  const b = normalizeDesignElementCapture(
    { tagName: "button", elementId: "b", cssSelector: "button#b", xpath: "//*[@id='b']" },
    { id: "2", capturedAt: 2 },
  );
  const again = normalizeDesignElementCapture(
    { tagName: "button", elementId: "a", cssSelector: "button#a", xpath: "//*[@id='a']" },
    { id: "3", capturedAt: 3 },
  );
  const merged = mergeDesignElements([a, b], again, 2);
  assert.equal(merged.length, 2);
  assert.equal(merged[1]?.id, "3");
  assert.equal(merged[0]?.id, "2");
});

test("designModeInjectSource toggles enable/disable script text", () => {
  const on = designModeInjectSource(true);
  const off = designModeInjectSource(false);
  assert.match(on, /__kcode_design_pick__/);
  assert.match(on, /crosshair/);
  assert.match(on, /buildCssSelector/);
  assert.match(off, /enabled: false/);
  assert.notEqual(on, off);
});

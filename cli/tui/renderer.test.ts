import assert from "node:assert/strict";
import test from "node:test";
import { DifferentialRenderer, type WriteSink } from "./renderer";
import { visibleWidth, truncateToWidth, stripAnsi, wrapText } from "./ansi";

/** Captures every write so tests can assert on the exact ANSI stream. */
class FakeSink implements WriteSink {
  writes: string[] = [];
  constructor(
    public columns = 40,
    public rows = 10,
  ) {}
  write(data: string): void {
    this.writes.push(data);
  }
  last(): string {
    return this.writes.at(-1) ?? "";
  }
  clear(): void {
    this.writes = [];
  }
}

const SYNC_OPEN = "\x1b[?2026h";
const SYNC_CLOSE = "\x1b[?2026l";

test("ansi: visibleWidth ignores escapes and counts wide chars", () => {
  assert.equal(visibleWidth("hello"), 5);
  assert.equal(visibleWidth("\x1b[31mred\x1b[0m"), 3);
  assert.equal(visibleWidth("你好"), 4); // two wide glyphs
  assert.equal(visibleWidth("a你b"), 4);
});

test("ansi: stripAnsi removes SGR codes", () => {
  assert.equal(stripAnsi("\x1b[1m\x1b[36mx\x1b[0m"), "x");
});

test("ansi: truncateToWidth preserves escapes and resets color", () => {
  const out = truncateToWidth("\x1b[31mredtext\x1b[0m", 3);
  assert.equal(visibleWidth(out), 3);
  assert.ok(out.startsWith("\x1b[31m"));
  assert.ok(out.endsWith("\x1b[0m"));
});

test("ansi: truncateToWidth never splits a wide glyph", () => {
  // maxWidth 3 cannot fit the second wide glyph (would need 4), so stop at 1.
  assert.equal(truncateToWidth("你好", 3), "你");
});

test("ansi: wrapText hard-wraps to width", () => {
  assert.deepEqual(wrapText("abcdef", 3), ["abc", "def"]);
  assert.deepEqual(wrapText("", 5), [""]);
  assert.deepEqual(wrapText("a\nb", 5), ["a", "b"]);
});

test("renderer: first frame writes all lines without clearing", () => {
  const sink = new FakeSink();
  const r = new DifferentialRenderer(sink);
  r.render(["line one", "line two"]);
  const out = sink.last();
  assert.ok(out.startsWith(SYNC_OPEN));
  assert.ok(out.endsWith(SYNC_CLOSE));
  assert.ok(!out.includes("\x1b[2J")); // no clear on first frame
  assert.ok(out.includes("line one"));
  assert.ok(out.includes("line two"));
});

test("renderer: unchanged frame emits nothing", () => {
  const sink = new FakeSink();
  const r = new DifferentialRenderer(sink);
  r.render(["a", "b"]);
  sink.clear();
  r.render(["a", "b"]);
  assert.equal(sink.writes.length, 0);
});

test("renderer: single changed line repaints only that row", () => {
  const sink = new FakeSink();
  const r = new DifferentialRenderer(sink);
  r.render(["alpha", "beta", "gamma"]);
  sink.clear();
  r.render(["alpha", "BETA", "gamma"]); // only row 1 changes
  const out = sink.last();
  assert.ok(out.includes("BETA"));
  assert.ok(!out.includes("alpha")); // untouched rows not repainted
  assert.ok(!out.includes("gamma"));
  assert.ok(out.includes("\x1b[2K")); // cleared the changed row
});

test("renderer: appended line is written after existing content", () => {
  const sink = new FakeSink();
  const r = new DifferentialRenderer(sink);
  r.render(["one", "two"]);
  sink.clear();
  r.render(["one", "two", "three"]);
  const out = sink.last();
  assert.ok(out.includes("three"));
  assert.ok(!out.includes("one")); // existing rows untouched
});

test("renderer: shrinking content clears trailing rows via full redraw", () => {
  const sink = new FakeSink();
  const r = new DifferentialRenderer(sink);
  r.render(["a", "b", "c", "d"]);
  sink.clear();
  r.render(["a", "b"]); // shrink below high-water mark
  const out = sink.last();
  assert.ok(out.includes("\x1b[2J")); // clearOnShrink → full clear
  assert.ok(out.includes("a"));
  assert.ok(out.includes("b"));
});

test("renderer: width change forces a full clear+redraw", () => {
  const sink = new FakeSink(40);
  const r = new DifferentialRenderer(sink);
  r.render(["hello"]);
  sink.clear();
  sink.columns = 30; // terminal resized narrower
  r.render(["hello"]);
  const out = sink.last();
  assert.ok(out.includes("\x1b[2J"));
});

test("renderer: throws on a line wider than the terminal", () => {
  const sink = new FakeSink(5);
  const r = new DifferentialRenderer(sink);
  assert.throws(() => r.render(["this line is far too wide"]), /exceeds terminal width/);
});

test("renderer: every frame is wrapped in synchronized output", () => {
  const sink = new FakeSink();
  const r = new DifferentialRenderer(sink);
  r.render(["x"]);
  r.render(["y"]);
  for (const w of sink.writes) {
    assert.ok(w.startsWith(SYNC_OPEN));
    assert.ok(w.endsWith(SYNC_CLOSE));
  }
});

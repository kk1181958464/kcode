/**
 * ANSI-aware width and truncation helpers for the terminal renderer.
 *
 * The differential renderer measures the *visible* width of every line so it
 * can enforce that no line exceeds the terminal width (an overflowing line
 * would wrap and corrupt the row-based diff). These helpers ignore ANSI SGR
 * escapes and count East-Asian wide characters as two columns.
 */

// Matches ANSI escape sequences (CSI/SGR and the like). Kept deliberately broad
// so color codes, cursor moves, and synchronized-output markers are all skipped
// when measuring visible width.
// eslint-disable-next-line no-control-regex
const ANSI_PATTERN =
  /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07|\x1b[PX^_][^\x1b]*\x1b\\/g;

// Terminal-originated text is allowed to contain line feeds and tabs, but not
// control sequences. Model and tool output is untrusted: OSC 52 can modify the
// clipboard, CSI can move the cursor, and carriage returns can overwrite prior
// output. Strip those before the text reaches the renderer.
const TERMINAL_ESCAPE_PATTERN =
  /\x1b\][\s\S]*?(?:\x07|\x1b\\)|\x1b[PX^_][\s\S]*?\x1b\\|\x1b\[[0-?]*[ -/]*[@-~]|\x1b[@-_]/g;

/** Strip all ANSI escape sequences, leaving only printable characters. */
export function stripAnsi(input: string): string {
  return input.replace(ANSI_PATTERN, "");
}

/** Remove terminal control sequences from model/tool supplied text. */
export function sanitizeTerminalText(input: string): string {
  return (
    input
      .replace(/\r\n?/g, "\n")
      .replace(TERMINAL_ESCAPE_PATTERN, "")
      // Keep tab and LF; remove the remaining C0/C1 controls and DEL.
      // eslint-disable-next-line no-control-regex
      .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, "")
  );
}

/** True for code points rendered two columns wide in a monospace terminal. */
function isWideCodePoint(cp: number): boolean {
  return (
    cp >= 0x1100 &&
    (cp <= 0x115f || // Hangul Jamo
      cp === 0x2329 ||
      cp === 0x232a ||
      (cp >= 0x2e80 && cp <= 0x303e) || // CJK radicals … Kangxi
      (cp >= 0x3041 && cp <= 0x33ff) || // Hiragana … CJK symbols
      (cp >= 0x3400 && cp <= 0x4dbf) || // CJK Ext A
      (cp >= 0x4e00 && cp <= 0x9fff) || // CJK Unified
      (cp >= 0xa000 && cp <= 0xa4cf) || // Yi
      (cp >= 0xac00 && cp <= 0xd7a3) || // Hangul syllables
      (cp >= 0xf900 && cp <= 0xfaff) || // CJK compat
      (cp >= 0xfe10 && cp <= 0xfe19) || // vertical forms
      (cp >= 0xfe30 && cp <= 0xfe6f) || // CJK compat forms
      (cp >= 0xff00 && cp <= 0xff60) || // fullwidth forms
      (cp >= 0xffe0 && cp <= 0xffe6) ||
      (cp >= 0x1f300 && cp <= 0x1faff) || // emoji & pictographs
      (cp >= 0x20000 && cp <= 0x3fffd)) // CJK Ext B+
  );
}

/** Visible column width of a string, ignoring ANSI escapes. */
export function visibleWidth(input: string): number {
  const text = stripAnsi(input);
  let width = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    // Zero-width: combining marks, zero-width space/joiner, BOM.
    if (
      cp === 0x200b ||
      cp === 0x200d ||
      cp === 0xfeff ||
      (cp >= 0x0300 && cp <= 0x036f)
    )
      continue;
    width += isWideCodePoint(cp) ? 2 : 1;
  }
  return width;
}

/**
 * Truncate a string to at most `maxWidth` visible columns, preserving ANSI
 * escape sequences (they carry no width) and never splitting a surrogate pair
 * or a wide glyph across the boundary. Appends a reset (\x1b[0m) if any SGR
 * codes were emitted, so truncation cannot leak color into the next line.
 */
export function truncateToWidth(input: string, maxWidth: number): string {
  if (maxWidth <= 0) return "";
  if (visibleWidth(input) <= maxWidth) return input;
  let out = "";
  let width = 0;
  let sawEscape = false;
  let i = 0;
  while (i < input.length) {
    ANSI_PATTERN.lastIndex = i;
    const match = ANSI_PATTERN.exec(input);
    if (match && match.index === i) {
      // Pass ANSI escapes through untouched; they consume no columns.
      out += match[0];
      sawEscape = true;
      i += match[0].length;
      continue;
    }
    const ch = String.fromCodePoint(input.codePointAt(i)!);
    const cp = ch.codePointAt(0)!;
    const w = isWideCodePoint(cp) ? 2 : 1;
    if (width + w > maxWidth) break;
    out += ch;
    width += w;
    i += ch.length;
  }
  if (sawEscape) out += "\x1b[0m";
  return out;
}

/**
 * Hard-wrap a string to `width` columns, returning one entry per visual row.
 * Wraps on width only (no word boundaries) so it is ANSI- and wide-char-safe;
 * empty input yields a single empty line. Existing newlines split first.
 */
export function wrapText(input: string, width: number): string[] {
  if (width <= 0) return [input];
  const rows: string[] = [];
  for (const paragraph of input.split("\n")) {
    if (visibleWidth(paragraph) <= width) {
      rows.push(paragraph);
      continue;
    }
    let rest = paragraph;
    while (visibleWidth(rest) > width) {
      const head = truncateToWidth(rest, width);
      rows.push(head);
      // Advance past exactly the code points consumed by `head`.
      rest = rest.slice(sliceLengthForVisible(rest, head));
    }
    rows.push(rest);
  }
  return rows.length ? rows : [""];
}

/** Number of source chars in `rest` that produced the visible prefix `head`. */
function sliceLengthForVisible(rest: string, head: string): number {
  // head is a prefix of rest minus a possible trailing reset we appended.
  const reset = "\x1b[0m";
  const body = head.endsWith(reset) ? head.slice(0, -reset.length) : head;
  return body.length;
}

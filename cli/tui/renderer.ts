import { visibleWidth } from "./ansi";

/**
 * A minimal write sink — `process.stdout` satisfies it. Kept as an interface so
 * tests can capture the exact ANSI byte stream the renderer emits.
 */
export interface WriteSink {
  write(data: string): void;
  columns: number;
  rows: number;
}

/**
 * Main-screen differential renderer, ported from pi's TuiMainScreen
 * (packages/tui/src/tui-main-screen.ts). The terminal owns scrollback; we only
 * ever repaint the range of lines that changed relative to the previous frame,
 * wrapped in a synchronized-output block so partial frames never tear.
 *
 * Contract: callers hand a full `string[]` snapshot each frame. Every line's
 * visibleWidth() must be <= terminal columns — an overflowing line would wrap
 * and desync the row model, so we throw rather than corrupt the display.
 *
 * Not ported (out of scope for the CLI): alt-screen, Kitty images, overlays,
 * viewport/scrollback diffing above the fold. When the changed region would sit
 * above what we can address, we fall back to a full redraw.
 */
export class DifferentialRenderer {
  private previousLines: string[] = [];
  private previousWidth = 0;
  private previousHeight = 0;
  private cursorRow = 0;
  private maxLinesRendered = 0;
  private clearOnShrink = true;

  constructor(private readonly sink: WriteSink) {}

  setClearOnShrink(value: boolean): void {
    this.clearOnShrink = value;
  }

  /** Render a full-frame snapshot, emitting only the minimal ANSI diff. */
  render(newLines: string[]): void {
    const width = this.sink.columns || 80;
    const height = this.sink.rows || 24;
    const widthChanged = this.previousWidth !== 0 && this.previousWidth !== width;
    const heightChanged =
      this.previousHeight !== 0 && this.previousHeight !== height;

    this.assertLineWidths(newLines, width);

    // First frame — assume a clean screen and just lay everything out.
    if (this.previousLines.length === 0 && !widthChanged && !heightChanged) {
      this.fullRender(newLines, width, height, false);
      return;
    }
    // Width change reflows wrapping; height change shifts the viewport. Both
    // invalidate the row model, so repaint everything.
    if (widthChanged || heightChanged) {
      this.fullRender(newLines, width, height, true);
      return;
    }
    // Content shrank below the high-water mark: clear stale trailing rows.
    if (this.clearOnShrink && newLines.length < this.maxLinesRendered) {
      this.fullRender(newLines, width, height, true);
      return;
    }

    this.diffRender(newLines, width, height);
  }

  /** Reset internal state (e.g. after committing a block to scrollback). */
  reset(): void {
    this.previousLines = [];
    this.previousWidth = 0;
    this.previousHeight = 0;
    this.cursorRow = 0;
    this.maxLinesRendered = 0;
  }

  /**
   * Push finalized lines into terminal scrollback above the live region and
   * reset the diff state. Used to "freeze" completed output (an activity row,
   * a settled paragraph) so the live region stays small enough to always take
   * the cheap diff path instead of falling back to full redraws.
   */
  commit(lines: string[]): void {
    if (!lines.length) return;
    const width = this.sink.columns || 80;
    this.assertLineWidths(lines, width);
    // Overwrite the current live region from its top, print the committed
    // lines, then a newline so the next live frame starts fresh below.
    let buffer = "\x1b[?2026h";
    if (this.previousLines.length) {
      if (this.cursorRow > 0) buffer += `\x1b[${this.cursorRow}A`;
      buffer += "\r";
      // Clear every row the live region currently occupies.
      for (let i = 0; i < this.previousLines.length; i++) {
        buffer += "\x1b[2K";
        if (i < this.previousLines.length - 1) buffer += "\r\n";
      }
      if (this.previousLines.length > 1)
        buffer += `\x1b[${this.previousLines.length - 1}A`;
      buffer += "\r";
    }
    for (let i = 0; i < lines.length; i++) {
      buffer += "\x1b[2K" + lines[i] + "\r\n";
    }
    buffer += "\x1b[?2026l";
    this.sink.write(buffer);
    // The live region is gone; next render() starts as a fresh first frame.
    this.previousLines = [];
    this.previousWidth = 0;
    this.previousHeight = 0;
    this.cursorRow = 0;
    this.maxLinesRendered = 0;
  }

  private assertLineWidths(lines: string[], width: number): void {
    for (let i = 0; i < lines.length; i++) {
      if (visibleWidth(lines[i]) > width) {
        throw new Error(
          `Rendered line ${i} exceeds terminal width ` +
            `(${visibleWidth(lines[i])} > ${width}). ` +
            `A renderer component must truncate its output with truncateToWidth().`,
        );
      }
    }
  }

  /** Repaint the whole screen (optionally clearing scrollback first). */
  private fullRender(
    newLines: string[],
    width: number,
    height: number,
    clear: boolean,
  ): void {
    let buffer = "\x1b[?2026h"; // begin synchronized output
    // Clear the visible screen + home, but NEVER \x1b[3J: that wipes the
    // terminal's scrollback and would rob the user of scroll-up history.
    if (clear) buffer += "\x1b[2J\x1b[H";
    for (let i = 0; i < newLines.length; i++) {
      if (i > 0) buffer += "\r\n";
      buffer += newLines[i];
    }
    buffer += "\x1b[?2026l"; // end synchronized output
    this.sink.write(buffer);

    this.cursorRow = Math.max(0, newLines.length - 1);
    this.maxLinesRendered = clear
      ? newLines.length
      : Math.max(this.maxLinesRendered, newLines.length);
    this.previousLines = newLines;
    this.previousWidth = width;
    this.previousHeight = height;
  }

  /** Repaint only the [firstChanged, lastChanged] span, then trim extra rows. */
  private diffRender(newLines: string[], width: number, height: number): void {
    let firstChanged = -1;
    let lastChanged = -1;
    const maxLines = Math.max(newLines.length, this.previousLines.length);
    for (let i = 0; i < maxLines; i++) {
      const oldLine = i < this.previousLines.length ? this.previousLines[i] : "";
      const newLine = i < newLines.length ? newLines[i] : "";
      if (oldLine !== newLine) {
        if (firstChanged === -1) firstChanged = i;
        lastChanged = i;
      }
    }

    // Nothing changed — leave the screen (and cursor) as-is.
    if (firstChanged === -1) {
      this.previousHeight = height;
      return;
    }

    // The changed region begins beyond what fits on screen from the cursor;
    // we cannot address it with relative moves, so repaint everything.
    if (firstChanged >= height || newLines.length > height) {
      this.fullRender(newLines, width, height, true);
      return;
    }

    let buffer = "\x1b[?2026h";
    // Move from the current cursor row to the first changed row.
    const up = this.cursorRow - firstChanged;
    if (up > 0) buffer += `\x1b[${up}A`;
    else if (up < 0) buffer += `\x1b[${-up}B`;
    buffer += "\r"; // column 0

    // Repaint changed lines only — this is what keeps a spinner tick from
    // redrawing the entire transcript and flickering.
    const renderEnd = Math.min(lastChanged, newLines.length - 1);
    for (let i = firstChanged; i <= renderEnd; i++) {
      if (i > firstChanged) buffer += "\r\n";
      buffer += "\x1b[2K"; // clear the row
      buffer += newLines[i];
    }
    let finalRow = renderEnd;

    // Previous frame had more rows: clear the now-orphaned trailing lines.
    if (this.previousLines.length > newLines.length) {
      if (renderEnd < newLines.length - 1) {
        const moveDown = newLines.length - 1 - renderEnd;
        buffer += `\x1b[${moveDown}B`;
        finalRow = newLines.length - 1;
      }
      const extraLines = this.previousLines.length - newLines.length;
      for (let i = 0; i < extraLines; i++) buffer += "\r\n\x1b[2K";
      buffer += `\x1b[${extraLines}A`; // back to end of real content
    }

    buffer += "\x1b[?2026l";
    this.sink.write(buffer);

    this.cursorRow = finalRow;
    this.maxLinesRendered = Math.max(this.maxLinesRendered, newLines.length);
    this.previousLines = newLines;
    this.previousWidth = width;
    this.previousHeight = height;
  }
}

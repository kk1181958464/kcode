import type { AgentEvent } from "../../src/types";
import { truncateToWidth, wrapText } from "./ansi";
import { DifferentialRenderer, type WriteSink } from "./renderer";

const RESET = "\x1b[0m";
const DIM = "\x1b[2m";
const CYAN = "\x1b[36m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const BOLD = "\x1b[1m";

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

type Row =
  | { kind: "answer"; text: string }
  | { kind: "reasoning"; text: string }
  | { kind: "progress"; text: string }
  | { kind: "activity"; id: string; tool: string; title: string; status: string };

/**
 * Turns the AgentEvent stream into a live, diff-rendered terminal view.
 *
 * The transcript is modeled as an ordered list of rows; each frame flattens
 * them into wrapped, width-clamped lines and hands the snapshot to the
 * DifferentialRenderer, which repaints only what changed. Committed activity
 * and settled answer text is flushed into scrollback so the live region stays
 * small (and the diff cheap) as a long turn progresses.
 */
export class LiveView {
  private readonly renderer: DifferentialRenderer;
  private rows: Row[] = [];
  private spinnerFrame = 0;
  private spinnerTimer: ReturnType<typeof setInterval> | undefined;
  private hasActiveWork = false;

  constructor(private readonly sink: WriteSink) {
    this.renderer = new DifferentialRenderer(sink);
  }

  /** Feed one AgentEvent. Returns true on a terminal event (done/error). */
  push(event: AgentEvent): boolean {
    switch (event.type) {
      case "text":
        this.appendText("answer", event.delta);
        this.startSpinner();
        break;
      case "reasoning":
        this.appendText("reasoning", event.delta);
        this.startSpinner();
        break;
      case "text_reset":
        // Upstream retried; drop the answer rows streamed so far.
        this.rows = this.rows.filter((r) => r.kind !== "answer");
        break;
      case "progress":
        this.setEphemeral("progress", event.message);
        this.startSpinner();
        break;
      case "activity": {
        const a = event.activity;
        this.upsertActivity(a.id, a.tool, a.title, a.status);
        this.startSpinner();
        break;
      }
      case "usage":
        return false;
      case "done":
        this.stopSpinner();
        this.setEphemeral("progress", "");
        this.commitAll();
        this.sink.write(
          `${DIM}[完成 · ${(event as any).outcome ?? "completed"}]${RESET}\r\n`,
        );
        return true;
      case "error":
        this.stopSpinner();
        this.commitAll();
        this.sink.write(`${RED}[错误] ${(event as any).message}${RESET}\r\n`);
        return true;
      default:
        return false;
    }
    this.frame();
    return false;
  }

  /** Final visible answer text, for multi-turn context carry-over. */
  answerText(): string {
    return this.rows
      .filter((r): r is Extract<Row, { kind: "answer" }> => r.kind === "answer")
      .map((r) => r.text)
      .join("");
  }

  dispose(): void {
    this.stopSpinner();
  }

  /**
   * Freeze the current live region into scrollback and stop animating. Used
   * before an interactive approval prompt so the prompt renders on clean lines
   * below the settled output; subsequent events start a fresh live region.
   */
  freeze(): void {
    this.stopSpinner();
    this.commitAll();
  }

  // --- row mutation -------------------------------------------------------

  private appendText(kind: "answer" | "reasoning", delta: string): void {
    const last = this.rows.at(-1);
    if (last && last.kind === kind) last.text += delta;
    else this.rows.push({ kind, text: delta } as Row);
  }

  private setEphemeral(kind: "progress", text: string): void {
    this.rows = this.rows.filter((r) => r.kind !== kind);
    if (text) this.rows.push({ kind, text });
  }

  private activityIds = new Map<string, number>();

  private upsertActivity(
    id: string,
    tool: string,
    title: string,
    status: string,
  ): void {
    const existing = this.activityIds.get(id);
    if (existing !== undefined && this.rows[existing]?.kind === "activity") {
      const row = this.rows[existing] as Extract<Row, { kind: "activity" }>;
      row.title = title;
      row.status = status;
      return;
    }
    // A new activity supersedes any transient progress line.
    this.rows = this.rows.filter((r) => r.kind !== "progress");
    this.rows.push({ kind: "activity", id, tool, title, status });
    this.activityIds.set(id, this.rows.length - 1);
  }

  // --- rendering ----------------------------------------------------------

  private renderRow(row: Row, width: number): string[] {
    switch (row.kind) {
      case "answer":
        return wrapText(row.text, width);
      case "reasoning":
        return wrapText(row.text, width).map((l) => `${DIM}${l}${RESET}`);
      case "progress":
        return [
          truncateToWidth(`${DIM}${this.spin()} ${row.text}${RESET}`, width),
        ];
      case "activity": {
        // Running/waiting uses a STATIC marker, not the spinner: animating a
        // scattered high-up row would force the diff renderer to repaint a
        // large span every tick and flicker. Only the bottom progress line
        // animates, so per-tick repaint stays to a single line.
        const mark =
          row.status === "failed" || row.status === "denied"
            ? `${RED}✗${RESET}`
            : row.status === "success" || row.status === "completed"
              ? `${GREEN}✓${RESET}`
              : `${CYAN}▸${RESET}`;
        return [
          truncateToWidth(`${mark} ${BOLD}${row.tool}${RESET} ${row.title}`, width),
        ];
      }
    }
  }

  private frame(): void {
    const width = this.sink.columns || 80;
    const height = this.sink.rows || 24;
    // Keep the live region within the viewport. As a long turn accumulates
    // rows, commit the oldest settled rows into terminal scrollback so the
    // diff renderer never has to full-redraw (which would fight the terminal's
    // native scrollback and make the page unscrollable). Committed rows become
    // real, scrollable history above the live region.
    const maxLive = Math.max(1, height - 1);
    let lines = this.renderAll(width);
    while (lines.length > maxLive && this.rows.length > 1) {
      const first = this.rows.shift()!;
      this.renderer.commit(this.renderRow(first, width));
      this.reindexActivities();
      lines = this.renderAll(width);
    }
    this.renderer.render(lines);
  }

  private renderAll(width: number): string[] {
    const lines: string[] = [];
    for (const row of this.rows)
      for (const line of this.renderRow(row, width)) lines.push(line);
    return lines;
  }

  /** Rebuild id→index map after rows shift (e.g. after committing leading rows). */
  private reindexActivities(): void {
    this.activityIds.clear();
    this.rows.forEach((row, i) => {
      if (row.kind === "activity") this.activityIds.set(row.id, i);
    });
  }

  /** Flush all rows to scrollback and clear the model. */
  private commitAll(): void {
    const width = this.sink.columns || 80;
    this.renderer.commit(this.renderAll(width));
    this.rows = [];
    this.activityIds.clear();
  }

  // --- spinner ------------------------------------------------------------

  private spin(): string {
    return SPINNER[this.spinnerFrame % SPINNER.length];
  }

  private startSpinner(): void {
    this.hasActiveWork = true;
    if (this.spinnerTimer) return;
    this.spinnerTimer = setInterval(() => {
      this.spinnerFrame += 1;
      // The bottom progress line is the only animated element; re-render only
      // when one is present so idle ticks don't churn the diff renderer.
      if (this.rows.some((r) => r.kind === "progress")) this.frame();
    }, 120);
    this.spinnerTimer.unref?.();
  }

  private stopSpinner(): void {
    this.hasActiveWork = false;
    if (this.spinnerTimer) {
      clearInterval(this.spinnerTimer);
      this.spinnerTimer = undefined;
    }
  }
}

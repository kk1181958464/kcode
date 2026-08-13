import readline from "node:readline";
import { sanitizeTerminalText, truncateToWidth, visibleWidth } from "./ansi";
import type { WriteSink } from "./renderer";

const RESET = "\x1b[0m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const BLUE = "\x1b[38;5;75m";
const CYAN = "\x1b[36m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const MUTED = "\x1b[38;5;245m";
const INVERT = "\x1b[7m";

export interface PromptCommand {
  name: string;
  desc: string;
}

export interface PromptOptions {
  label?: string;
  placeholder?: string;
  initialValue?: string;
  secret?: boolean;
  commands?: PromptCommand[];
}

export interface SelectOption<T> {
  label: string;
  description?: string;
  value: T;
}

export interface PromptIO {
  input: NodeJS.ReadStream;
  output: WriteSink;
}

export interface EditorState {
  value: string;
  cursor: number;
  selectedCommand: number;
}

export function matchingCommands(
  value: string,
  commands: PromptCommand[],
): PromptCommand[] {
  if (!value.startsWith("/") || value.includes(" ")) return [];
  const needle = value.toLowerCase();
  return commands.filter((command) =>
    command.name.toLowerCase().startsWith(needle),
  );
}

export function editPromptValue(
  state: EditorState,
  key: { name?: string; sequence?: string; ctrl?: boolean },
): EditorState {
  if (key.name === "left")
    return { ...state, cursor: Math.max(0, state.cursor - 1) };
  if (key.name === "right")
    return { ...state, cursor: Math.min(state.value.length, state.cursor + 1) };
  if (key.name === "home") return { ...state, cursor: 0 };
  if (key.name === "end") return { ...state, cursor: state.value.length };
  if (key.name === "backspace") {
    if (!state.cursor) return state;
    return {
      ...state,
      value:
        state.value.slice(0, state.cursor - 1) +
        state.value.slice(state.cursor),
      cursor: state.cursor - 1,
      selectedCommand: 0,
    };
  }
  if (key.name === "delete") {
    return {
      ...state,
      value:
        state.value.slice(0, state.cursor) +
        state.value.slice(state.cursor + 1),
      selectedCommand: 0,
    };
  }
  const sequence = key.sequence ?? "";
  if (
    sequence &&
    !key.ctrl &&
    key.name !== "return" &&
    key.name !== "enter" &&
    key.name !== "tab" &&
    !/^\x1b/.test(sequence) &&
    !/[\x00-\x1f\x7f]/.test(sequence)
  ) {
    return {
      ...state,
      value:
        state.value.slice(0, state.cursor) +
        sequence +
        state.value.slice(state.cursor),
      cursor: state.cursor + sequence.length,
      selectedCommand: 0,
    };
  }
  return state;
}

function inputViewport(
  value: string,
  cursor: number,
  width: number,
  secret: boolean,
): { text: string; cursorColumn: number } {
  const beforeCursor = value.slice(0, cursor);
  const display = secret ? "•".repeat(Array.from(value).length) : value;
  const displayBeforeCursor = secret
    ? "•".repeat(Array.from(beforeCursor).length)
    : beforeCursor;
  const totalCursorColumn = visibleWidth(displayBeforeCursor);
  if (visibleWidth(display) <= width)
    return { text: display, cursorColumn: totalCursorColumn };

  const targetStart = Math.max(0, totalCursorColumn - width + 1);
  let startColumn = 0;
  let startIndex = 0;
  for (const ch of display) {
    const next = startColumn + visibleWidth(ch);
    if (next > targetStart) break;
    startColumn = next;
    startIndex += ch.length;
  }
  const text = truncateToWidth(display.slice(startIndex), width);
  return {
    text,
    cursorColumn: Math.max(0, totalCursorColumn - startColumn),
  };
}

export class TerminalPrompt {
  private renderedLines = 0;
  private cursorRow = 0;
  private activeRender: (() => void) | null = null;
  private pendingNotifications: string[][] = [];

  constructor(private readonly io: PromptIO) {
    readline.emitKeypressEvents(io.input);
  }

  notify(message: string): void {
    const width = Math.max(24, this.io.output.columns || 80);
    const lines = sanitizeTerminalText(message)
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => `${YELLOW}${truncateToWidth(line, width)}${RESET}`);
    if (!lines.length) return;
    const rerender = this.activeRender;
    if (!rerender) {
      this.pendingNotifications.push(lines);
      return;
    }
    this.clearRendered();
    this.io.output.write(`${lines.join("\r\n")}\r\n`);
    rerender();
  }

  async ask(options: PromptOptions = {}): Promise<string | null> {
    const input = this.io.input;
    if (!input.isTTY || typeof input.setRawMode !== "function") return null;

    const commands = options.commands ?? [];
    let state: EditorState = {
      value: options.initialValue ?? "",
      cursor: options.initialValue?.length ?? 0,
      selectedCommand: 0,
    };

    const render = () => {
      const width = Math.max(24, this.io.output.columns || 80);
      const innerWidth = Math.max(20, width - 4);
      const suggestions = matchingCommands(state.value, commands).slice(0, 7);
      if (state.selectedCommand >= suggestions.length)
        state.selectedCommand = Math.max(0, suggestions.length - 1);

      const lines: string[] = [];
      if (options.label)
        lines.push(
          `${BOLD}${truncateToWidth(sanitizeTerminalText(options.label), width)}${RESET}`,
        );
      lines.push(`${BLUE}╭${"─".repeat(innerWidth + 2)}╮${RESET}`);
      const safeValue = sanitizeTerminalText(state.value);
      const viewport = inputViewport(
        safeValue,
        Math.min(state.cursor, safeValue.length),
        innerWidth,
        Boolean(options.secret),
      );
      const empty = !safeValue;
      const content = empty
        ? `${DIM}${sanitizeTerminalText(options.placeholder ?? "输入任务，/ 查看命令")}${RESET}`
        : viewport.text;
      const visibleContent = truncateToWidth(content, innerWidth);
      lines.push(
        `${BLUE}│${RESET} ${visibleContent}${" ".repeat(Math.max(0, innerWidth - visibleWidth(visibleContent)))} ${BLUE}│${RESET}`,
      );
      lines.push(`${BLUE}╰${"─".repeat(innerWidth + 2)}╯${RESET}`);

      if (suggestions.length) {
        for (let i = 0; i < suggestions.length; i++) {
          const command = suggestions[i];
          const active = i === state.selectedCommand;
          const row = ` ${command.name.padEnd(12)} ${command.desc}`;
          lines.push(
            active
              ? `${INVERT}${truncateToWidth(row, width)}${RESET}`
              : `${MUTED}${truncateToWidth(row, width)}${RESET}`,
          );
        }
        lines.push(
          `${DIM}${truncateToWidth(" ↑↓ 选择  Tab 补全  Enter 执行", width)}${RESET}`,
        );
      } else {
        lines.push(
          `${DIM}${truncateToWidth(" Enter 发送 · Ctrl+C 退出", width)}${RESET}`,
        );
      }

      const inputRow = options.label ? 2 : 1;
      const col = 3 + (empty ? 0 : viewport.cursorColumn);
      this.redraw(lines, inputRow, col);
    };

    this.flushPendingNotifications();
    input.setRawMode(true);
    input.resume();
    this.activeRender = render;
    render();

    return new Promise((resolve) => {
      const cleanup = (value: string | null) => {
        this.activeRender = null;
        input.off("keypress", onKeypress);
        input.setRawMode(false);
        this.clearRendered();
        if (value !== null) {
          const safe = options.secret
            ? "••••••••"
            : sanitizeTerminalText(value);
          this.io.output.write(`${CYAN}›${RESET} ${safe}\r\n`);
        }
        resolve(value);
      };

      const onKeypress = (
        _value: string,
        key: {
          name?: string;
          sequence?: string;
          ctrl?: boolean;
          shift?: boolean;
        },
      ) => {
        if (key.ctrl && key.name === "c") return cleanup(null);
        const suggestions = matchingCommands(state.value, commands).slice(0, 7);
        if (key.name === "up" && suggestions.length) {
          state.selectedCommand =
            (state.selectedCommand - 1 + suggestions.length) %
            suggestions.length;
          return render();
        }
        if (key.name === "down" && suggestions.length) {
          state.selectedCommand =
            (state.selectedCommand + 1) % suggestions.length;
          return render();
        }
        if (key.name === "tab" && suggestions.length) {
          const selected = suggestions[state.selectedCommand];
          state.value = `${selected.name} `;
          state.cursor = state.value.length;
          return render();
        }
        if (key.name === "return" || key.name === "enter") {
          if (suggestions.length && state.value.startsWith("/")) {
            const exact = suggestions.find((item) => item.name === state.value);
            if (!exact && state.value.length <= suggestions[0].name.length) {
              state.value = suggestions[state.selectedCommand].name;
            }
          }
          return cleanup(state.value);
        }
        state = editPromptValue(state, key);
        render();
      };
      input.on("keypress", onKeypress);
    });
  }

  async select<T>(
    title: string,
    options: SelectOption<T>[],
    initialIndex = 0,
  ): Promise<T | null> {
    const input = this.io.input;
    if (!input.isTTY || typeof input.setRawMode !== "function") return null;
    let selected = Math.min(Math.max(0, initialIndex), options.length - 1);

    const render = () => {
      const width = Math.max(24, this.io.output.columns || 80);
      const windowSize = Math.max(
        3,
        Math.min(10, (this.io.output.rows || 24) - 4),
      );
      const start = Math.max(
        0,
        Math.min(
          selected - Math.floor(windowSize / 2),
          options.length - windowSize,
        ),
      );
      const visible = options.slice(start, start + windowSize);
      const lines = [
        `${BOLD}${truncateToWidth(sanitizeTerminalText(title), width)}${RESET}`,
      ];
      visible.forEach((option, visibleIndex) => {
        const index = start + visibleIndex;
        const marker =
          index === selected ? `${GREEN}●${RESET}` : `${DIM}○${RESET}`;
        const detail = option.description
          ? `  ${DIM}${option.description}${RESET}`
          : "";
        const row = `${marker} ${sanitizeTerminalText(option.label)}${detail}`;
        const clamped = truncateToWidth(row, width);
        lines.push(index === selected ? `${BOLD}${clamped}${RESET}` : clamped);
      });
      if (options.length > windowSize)
        lines.push(
          `${DIM}${start + 1}-${Math.min(options.length, start + windowSize)} / ${options.length}${RESET}`,
        );
      lines.push(
        `${DIM}${truncateToWidth("↑↓ 选择 · Enter 确认 · Esc 取消", width)}${RESET}`,
      );
      this.redraw(lines, lines.length - 1, 0);
    };

    this.flushPendingNotifications();
    input.setRawMode(true);
    input.resume();
    this.activeRender = render;
    render();
    return new Promise((resolve) => {
      const cleanup = (value: T | null) => {
        this.activeRender = null;
        input.off("keypress", onKeypress);
        input.setRawMode(false);
        this.clearRendered();
        resolve(value);
      };
      const onKeypress = (
        _value: string,
        key: { name?: string; ctrl?: boolean },
      ) => {
        if ((key.ctrl && key.name === "c") || key.name === "escape")
          return cleanup(null);
        if (key.name === "up") {
          selected = (selected - 1 + options.length) % options.length;
          return render();
        }
        if (key.name === "down") {
          selected = (selected + 1) % options.length;
          return render();
        }
        if (key.name === "return" || key.name === "enter")
          return cleanup(options[selected].value);
      };
      input.on("keypress", onKeypress);
    });
  }

  private redraw(
    lines: string[],
    cursorRow: number,
    cursorColumn: number,
  ): void {
    let out = "\x1b[?25l";
    if (this.renderedLines) {
      if (this.cursorRow > 0) out += `\x1b[${this.cursorRow}A`;
      out += "\r";
      for (let i = 0; i < this.renderedLines; i++) {
        out += "\x1b[2K";
        if (i < this.renderedLines - 1) out += "\r\n";
      }
      if (this.renderedLines > 1) out += `\x1b[${this.renderedLines - 1}A\r`;
    }
    out += lines.join("\r\n");
    const rowsUp = lines.length - 1 - cursorRow;
    if (rowsUp > 0) out += `\x1b[${rowsUp}A`;
    out += "\r";
    if (cursorColumn > 0) out += `\x1b[${cursorColumn}C`;
    out += "\x1b[?25h";
    this.renderedLines = lines.length;
    this.cursorRow = cursorRow;
    this.io.output.write(out);
  }

  private clearRendered(): void {
    if (!this.renderedLines) return;
    let out = this.cursorRow > 0 ? `\x1b[${this.cursorRow}A\r` : "\r";
    for (let i = 0; i < this.renderedLines; i++) {
      out += "\x1b[2K";
      if (i < this.renderedLines - 1) out += "\r\n";
    }
    if (this.renderedLines > 1) out += `\x1b[${this.renderedLines - 1}A\r`;
    this.io.output.write(out);
    this.renderedLines = 0;
    this.cursorRow = 0;
  }

  private flushPendingNotifications(): void {
    if (!this.pendingNotifications.length) return;
    for (const lines of this.pendingNotifications)
      this.io.output.write(`${lines.join("\r\n")}\r\n`);
    this.pendingNotifications = [];
  }
}

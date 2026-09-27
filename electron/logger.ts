import { app } from "electron";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import path from "node:path";

const maxBytes = 5 * 1024 * 1024;
const flushDelayMs = 200;
export const logsDirectory = () => path.join(app.getPath("userData"), "logs");
const logFile = () => path.join(logsDirectory(), "kcode.log");

// Lines are buffered and appended in one write per batch; the file size is
// tracked in memory so rotation does not stat the file on every line.
let pending: string[] = [];
let flushTimer: ReturnType<typeof setTimeout> | undefined;
let currentSize: number | undefined;

function rotate(file: string) {
  rmSync(`${file}.5`, { force: true });
  for (let i = 4; i >= 1; i--) {
    const from = `${file}.${i}`,
      to = `${file}.${i + 1}`;
    if (existsSync(from)) renameSync(from, to);
  }
  renameSync(file, `${file}.1`);
  currentSize = 0;
}

export function flushLogs() {
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = undefined;
  if (!pending.length) return;
  const text = pending.join("");
  pending = [];
  try {
    const file = logFile();
    if (currentSize === undefined) {
      mkdirSync(logsDirectory(), { recursive: true });
      currentSize = existsSync(file) ? statSync(file).size : 0;
    }
    if (currentSize >= maxBytes) rotate(file);
    appendFileSync(file, text, "utf8");
    currentSize += Buffer.byteLength(text);
  } catch {
    // Retry directory/size discovery next time (e.g. logs folder was removed).
    currentSize = undefined;
  }
}

export function writeLog(
  level: "info" | "warn" | "error",
  context: string,
  value: unknown,
) {
  try {
    const detail =
      value instanceof Error
        ? { name: value.name, message: value.message, stack: value.stack }
        : value;
    pending.push(
      `${JSON.stringify({ time: new Date().toISOString(), level, context, detail })}\n`,
    );
    // Errors may precede a crash, so write them out immediately.
    if (level === "error") flushLogs();
    else if (!flushTimer) {
      flushTimer = setTimeout(flushLogs, flushDelayMs);
      flushTimer.unref?.();
    }
  } catch {
    /* Logging must not crash the app. */
  }
}
export function installProcessLogging() {
  process.on("uncaughtException", (error) =>
    writeLog("error", "main.uncaughtException", error),
  );
  process.on("unhandledRejection", (error) =>
    writeLog("error", "main.unhandledRejection", error),
  );
  process.on("exit", flushLogs);
}

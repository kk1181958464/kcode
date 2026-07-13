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
export const logsDirectory = () => path.join(app.getPath("userData"), "logs");
const logFile = () => path.join(logsDirectory(), "kcode.log");
function rotate() {
  const file = logFile();
  if (!existsSync(file) || statSync(file).size < maxBytes) return;
  rmSync(`${file}.5`, { force: true });
  for (let i = 4; i >= 1; i--) {
    const from = `${file}.${i}`,
      to = `${file}.${i + 1}`;
    if (existsSync(from)) renameSync(from, to);
  }
  renameSync(file, `${file}.1`);
}
export function writeLog(
  level: "info" | "warn" | "error",
  context: string,
  value: unknown,
) {
  try {
    mkdirSync(logsDirectory(), { recursive: true });
    rotate();
    const detail =
      value instanceof Error
        ? { name: value.name, message: value.message, stack: value.stack }
        : value;
    appendFileSync(
      logFile(),
      `${JSON.stringify({ time: new Date().toISOString(), level, context, detail })}\n`,
      "utf8",
    );
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
}

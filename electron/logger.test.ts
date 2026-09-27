import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";
import { flushLogs, logsDirectory, writeLog } from "./logger";

const file = () => path.join(logsDirectory(), "kcode.log");
const lines = () =>
  fs.existsSync(file()) ? fs.readFileSync(file(), "utf8").trim().split("\n") : [];

test("buffers info logs until flush and writes errors immediately", () => {
  flushLogs();
  const before = lines().length;
  writeLog("info", "logger.test.info", { n: 1 });
  writeLog("warn", "logger.test.warn", { n: 2 });
  assert.equal(lines().length, before);
  writeLog("error", "logger.test.error", new Error("boom"));
  const written = lines().slice(before).map((line) => JSON.parse(line));
  assert.deepEqual(
    written.map((entry) => entry.context),
    ["logger.test.info", "logger.test.warn", "logger.test.error"],
  );
  assert.equal(written[2].detail.message, "boom");
});

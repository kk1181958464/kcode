import { readdir } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

const root = path.resolve(import.meta.dirname, "..");
const testDir = path.join(root, "electron");
const files = (await readdir(testDir))
  .filter((name) => name.endsWith(".test.ts"))
  .sort()
  .map((name) => path.join(testDir, name));

const tsx = path.join(root, "node_modules", "tsx", "dist", "cli.mjs");
const child = spawn(process.execPath, [tsx, "--test", ...files], {
  cwd: root,
  stdio: "inherit",
  shell: false,
});

child.on("error", (error) => {
  console.error(error);
  process.exitCode = 1;
});
child.on("exit", (code, signal) => {
  process.exitCode = code ?? (signal ? 1 : 0);
});
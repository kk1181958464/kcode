import { readdir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";

const root = path.resolve(import.meta.dirname, "..");
const testDir = path.join(root, "electron");
const files = (await readdir(testDir))
  .filter((name) => name.endsWith(".test.ts"))
  .sort()
  .map((name) => path.join(testDir, name));

const tsx = path.join(root, "node_modules", "tsx", "dist", "cli.mjs");
const shimRegister = path.join(root, "scripts", "register-electron-shim.mjs");
// The electron shim must load in every test worker tsx spawns, so pass it via
// NODE_OPTIONS (inherited by children) rather than a top-level --import.
const child = spawn(process.execPath, [tsx, "--test", ...files], {
  cwd: root,
  stdio: "inherit",
  shell: false,
  env: {
    ...process.env,
    NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import ${pathToFileURL(shimRegister).href}`.trim(),
  },
});

child.on("error", (error) => {
  console.error(error);
  process.exitCode = 1;
});
child.on("exit", (code, signal) => {
  process.exitCode = code ?? (signal ? 1 : 0);
});
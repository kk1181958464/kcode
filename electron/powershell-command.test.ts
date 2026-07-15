import test from "node:test";
import assert from "node:assert/strict";
import { powershellCommand } from "./powershell-command";

test("refreshes machine and user PATH for every PowerShell command", () => {
  const command = powershellCommand("git status");
  assert.match(command, /GetEnvironmentVariable\('Path','Machine'\)/);
  assert.match(command, /GetEnvironmentVariable\('Path','User'\)/);
  assert.match(command, /git status$/);
});

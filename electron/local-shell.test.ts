import assert from "node:assert/strict";
import test from "node:test";
import {
  localShellInvocation,
  localShellPromptInstruction,
  localShellToolDescription,
} from "./local-shell";

test("uses PowerShell only on Windows", () => {
  const invocation = localShellInvocation("node --check app.js", "win32");
  assert.equal(invocation.executable, "powershell.exe");
  assert.deepEqual(invocation.args.slice(0, 3), [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
  ]);
  assert.match(invocation.args[3], /node --check app\.js/);
  assert.match(localShellToolDescription(false, "win32"), /PowerShell 5\.1/);
  assert.match(localShellPromptInstruction("win32"), /not Bash/);
});

test("uses a POSIX shell on macOS and Linux", () => {
  for (const platform of ["darwin", "linux"] as const) {
    assert.deepEqual(localShellInvocation("npm test", platform), {
      executable: "/bin/sh",
      args: ["-lc", "npm test"],
      label: "POSIX shell (/bin/sh)",
    });
    assert.match(localShellToolDescription(true, platform), /POSIX shell/);
    assert.match(localShellPromptInstruction(platform), /not PowerShell/);
  }
});

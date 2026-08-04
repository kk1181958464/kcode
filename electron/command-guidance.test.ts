import assert from "node:assert/strict";
import test from "node:test";
import {
  effectiveCommandExitCode,
  reportedChildExitCode,
  windowsCommandIssue,
} from "./command-guidance";

test("flags Start-Process headless screenshot commands that produce Chrome exit 13", () => {
  const command =
    "$chrome='C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'; " +
    "$args=@('--headless=new','--screenshot='+$out,$url); " +
    "Start-Process -FilePath $chrome -ArgumentList $args -Wait -PassThru";
  const issue = windowsCommandIssue(command);
  assert.match(issue ?? "", /exit 13/);
  assert.match(issue ?? "", /browser_screenshot/);
  assert.match(issue ?? "", /width、height/);
});

test("routes all raw headless browser screenshots to the native browser tool", () => {
  assert.match(
    windowsCommandIssue('& $chrome --headless=new "--screenshot=$out" $url') ??
      "",
    /browser_screenshot/,
  );
});

test("rejects other headless Start-Process argument arrays before PowerShell rewrites them", () => {
  const command =
    "$edge='C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'; " +
    "$args=@('--headless=new','--print-to-pdf='+$out,$url); " +
    "Start-Process -FilePath $edge -ArgumentList $args -Wait";
  assert.match(windowsCommandIssue(command) ?? "", /重新拼接浏览器参数/);
});

test("blocks Windows browser version launches that can leave a GUI process waiting", () => {
  assert.match(
    windowsCommandIssue(
      "& 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' --version",
    ) ?? "",
    /VersionInfo\.ProductVersion/,
  );
});

test("explains PowerShell alternatives for Bash heredocs", () => {
  assert.match(
    windowsCommandIssue("python - <<'PY'\nprint('ok')\nPY") ?? "",
    /PowerShell here-string/,
  );
});

test("allows unrelated Start-Process commands", () => {
  assert.equal(
    windowsCommandIssue(
      "Start-Process -FilePath node -ArgumentList @('server.js')",
    ),
    undefined,
  );
});

test("allows commands that only search for risky command text", () => {
  assert.equal(
    windowsCommandIssue(
      'rg -n "chrome.exe --headless --screenshot --version" docs',
    ),
    undefined,
  );
  assert.equal(
    windowsCommandIssue("Write-Output \"python - <<'PY'\""),
    undefined,
  );
});

test("explains unsupported Windows PowerShell 5.1 command forms", () => {
  assert.match(
    windowsCommandIssue("node --check game.js && npm test") ?? "",
    /不支持 &&/,
  );
  assert.match(
    windowsCommandIssue("npm test || Write-Output 'failed'") ?? "",
    /不支持 \|\|/,
  );
  assert.match(
    windowsCommandIssue(
      "Set-Content -LiteralPath $out -Value $text -Encoding utf8NoBOM",
    ) ?? "",
    /WriteAllText/,
  );
});

test("allows chain characters inside strings, here-strings, and comments", () => {
  assert.equal(
    windowsCommandIssue('node -e "if (ready && valid) console.log(1)"'),
    undefined,
  );
  assert.equal(
    windowsCommandIssue(
      "$url='https://example.test/?a=1&&b=2'; Invoke-WebRequest $url",
    ),
    undefined,
  );
  assert.equal(
    windowsCommandIssue("@'\na && b\n'@ | Set-Content out.txt"),
    undefined,
  );
  assert.equal(windowsCommandIssue("Write-Output ok # a && b"), undefined);
});

test("promotes an explicit child exit marker when PowerShell itself exits zero", () => {
  assert.equal(reportedChildExitCode("exit=13 png_bytes=0\n"), 13);
  assert.equal(effectiveCommandExitCode(0, "exit=13 png_bytes=0\n"), 13);
  assert.equal(effectiveCommandExitCode(7, "exit=13\n"), 7);
});

test("does not confuse application response codes with process exit markers", () => {
  const output =
    "https://example.test/profile => code=10010, message=login required";
  assert.equal(reportedChildExitCode(output), undefined);
  assert.equal(effectiveCommandExitCode(0, output), 0);
});

const WINDOWS_BROWSER =
  /(?:\bchrome(?:\.exe)?\b|\bmsedge(?:\.exe)?\b|Google[\\/]Chrome|Microsoft[\\/]Edge)/i;

function launchesWindowsBrowser(command: string) {
  if (
    /\bStart-Process\b/i.test(command) &&
    /-FilePath\b/i.test(command) &&
    WINDOWS_BROWSER.test(command)
  )
    return true;
  return command.split(/[;\r\n]+/).some((part) => {
    const segment = part.trim();
    return (
      /^&\s+\$(?:chrome|edge|browser)(?:Path)?\b/i.test(segment) ||
      /^&\s+['"][^'"]*(?:chrome|msedge)\.exe['"](?:\s|$)/i.test(segment) ||
      /^&?\s*(?:chrome|msedge)(?:\.exe)?(?:\s|$)/i.test(segment)
    );
  });
}

function unquotedPowerShellChainOperator(command: string) {
  let quote: "single" | "double" | "here-single" | "here-double" | undefined;
  let blockComment = false;
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    const next = command[index + 1];
    if (blockComment) {
      if (char === "#" && next === ">") {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote === "here-single" || quote === "here-double") {
      const delimiter = quote === "here-single" ? "'" : '"';
      if (char === delimiter && next === "@") {
        const lineStart = command.lastIndexOf("\n", index - 1) + 1;
        if (!command.slice(lineStart, index).trim()) {
          quote = undefined;
          index += 1;
        }
      }
      continue;
    }
    if (quote === "single") {
      if (char === "'" && next === "'") index += 1;
      else if (char === "'") quote = undefined;
      continue;
    }
    if (quote === "double") {
      if (char === "`") index += 1;
      else if (char === '"') quote = undefined;
      continue;
    }
    if (char === "<" && next === "#") {
      blockComment = true;
      index += 1;
      continue;
    }
    if (char === "#") {
      const newline = command.indexOf("\n", index + 1);
      if (newline < 0) break;
      index = newline;
      continue;
    }
    if (char === "@" && (next === "'" || next === '"')) {
      const after = command[index + 2];
      if (after === "\n" || (after === "\r" && command[index + 3] === "\n")) {
        quote = next === "'" ? "here-single" : "here-double";
        index += 1;
        continue;
      }
    }
    if (char === "'") {
      quote = "single";
      continue;
    }
    if (char === '"') {
      quote = "double";
      continue;
    }
    if (char === "`") {
      index += 1;
      continue;
    }
    if ((char === "&" && next === "&") || (char === "|" && next === "|"))
      return `${char}${next}` as "&&" | "||";
  }
  return undefined;
}

/**
 * Reject command shapes that are known to be invalid in KCode's PowerShell
 * runner and point the model at the native tool that replaces them.
 */
export function windowsCommandIssue(command: string) {
  const browserCommand = WINDOWS_BROWSER.test(command);
  const browserLaunch = browserCommand && launchesWindowsBrowser(command);
  const headless = /--headless(?:=\w+)?\b/i.test(command);
  const screenshot = /--screenshot(?:\b|=)/i.test(command);

  if (
    browserLaunch &&
    headless &&
    screenshot &&
    /\bStart-Process\b/i.test(command) &&
    /-ArgumentList\b/i.test(command)
  )
    return (
      "命令未执行：Windows PowerShell 的 Start-Process -ArgumentList 会把 Chrome/Edge 的 " +
      "--screenshot=<文件> 参数错误拆分，浏览器会将文件路径识别为第二个页面目标并返回 " +
      "exit 13（Multiple targets are not supported in headless mode）。请改用 browser_screenshot，" +
      "并通过 width、height 指定桌面或手机视口。"
    );

  if (
    browserLaunch &&
    headless &&
    /\bStart-Process\b/i.test(command) &&
    /-ArgumentList\b/i.test(command)
  )
    return (
      "命令未执行：Windows PowerShell 的 Start-Process -ArgumentList 会重新拼接浏览器参数，" +
      "路径、引号和 --flag=value 很容易被改写。页面操作请使用 browser_open、browser_snapshot " +
      "及 browser_screenshot；确无原生替代时应直接调用可执行文件并显式检查退出码。"
    );

  if (browserLaunch && headless && screenshot)
    return (
      "命令未执行：页面截图应使用 browser_screenshot；该工具支持 width、height 和 fullPage，" +
      "无需直接启动 Chrome/Edge，也不会残留浏览器进程。"
    );

  if (browserLaunch && headless && /--dump-dom\b/i.test(command))
    return (
      "命令未执行：页面结构读取应使用 browser_snapshot，交互后再取新快照；" +
      "无需通过 Chrome/Edge --dump-dom 启动额外进程。"
    );

  if (browserLaunch && /--version\b/i.test(command))
    return (
      "命令未执行：Windows 上直接运行 Chrome/Edge --version 可能启动 GUI 进程并持续等待。" +
      "读取文件版本即可，例如：(Get-Item $browserPath).VersionInfo.ProductVersion。"
    );

  if (
    /(?:^|[;\r\n])\s*&?\s*(?:python|python3|py|node|php)(?:\.exe)?\s+(?:-\s*)?<<\s*['\"]?[A-Za-z_]/i.test(
      command,
    )
  )
    return (
      "命令未执行：当前命令由 PowerShell 执行，不支持 Bash 的 <<EOF/heredoc 语法。" +
      "请优先使用 read_file、write_file 或 apply_patch；确需向解释器传入多行脚本时，" +
      "使用 PowerShell here-string：\n@'\n...\n'@ | python -。"
    );

  if (
    /(?:^|[;\r\n])\s*(?:Set-Content|Add-Content|Out-File|Export-Csv)\b[^;\r\n]*-Encoding\s+utf8NoBOM\b/i.test(
      command,
    )
  )
    return (
      "命令未执行：KCode 使用的 Windows PowerShell 5.1 不支持 -Encoding utf8NoBOM。" +
      "可接受 BOM 时使用 -Encoding UTF8；必须写无 BOM UTF-8 时使用 " +
      "[IO.File]::WriteAllText($path, $text, [Text.UTF8Encoding]::new($false))。"
    );

  const chainOperator = unquotedPowerShellChainOperator(command);
  if (chainOperator)
    return chainOperator === "&&"
      ? "命令未执行：Windows PowerShell 5.1 不支持 &&。请改为：command1; if ($LASTEXITCODE -eq 0) { command2 }。"
      : "命令未执行：Windows PowerShell 5.1 不支持 ||。请改为：command1; if ($LASTEXITCODE -ne 0) { command2 }。";

  return undefined;
}

/** Return a child exit code only when the command prints an explicit marker. */
export function reportedChildExitCode(output: string) {
  let reported: number | undefined;
  for (const line of output.split(/\r?\n/)) {
    const match =
      /^\s*(?:exit|exitcode|child[_ -]?exit(?:code)?)\s*[:=]\s*(-?\d+)\b/i.exec(
        line,
      );
    if (match) reported = Number(match[1]);
  }
  return reported;
}

export function effectiveCommandExitCode(
  shellExitCode: number,
  output: string,
) {
  if (shellExitCode !== 0) return shellExitCode;
  return reportedChildExitCode(output) ?? shellExitCode;
}

import { createRequire } from "node:module";
import type { ToolResult } from "./agent-types";
import { hasUserSuppliedVerificationCode } from "./browser-cdp";
import {
  currentBrowserWebsiteOrigin,
  sameWebsiteOrigin,
  type BrowserOriginDeps,
} from "./credential-tools";
import type { ResolvedCredential } from "./credential-vault";

const requireProduction = createRequire(__filename);

export type BrowserToolDeps = BrowserOriginDeps & {
  openBrowser: (
    sessionId: string,
    url: string,
    requestId: string,
  ) => Promise<unknown>;
  snapshotBrowser: (
    sessionId: string,
    options: {
      signal?: AbortSignal;
      onProgress?: (output: string) => void;
      waitForVerification?: boolean;
    },
  ) => Promise<unknown>;
  clickBrowser: (sessionId: string, ref: string) => Promise<unknown>;
  typeBrowser: (
    sessionId: string,
    ref: string,
    text: string,
  ) => Promise<unknown>;
  screenshotBrowser: (
    sessionId: string,
    options: {
      width?: number;
      height?: number;
      mobile?: boolean;
      fullPage?: boolean;
    },
  ) => Promise<{ path?: string }>;
  startBrowserRecording: (
    sessionId: string,
    name: string,
  ) => Promise<unknown>;
  stopBrowserRecording: (sessionId: string) => Promise<unknown>;
  resolveCredentialProfile: (
    kind: "website",
    selector: string,
  ) => Promise<ResolvedCredential>;
};

function productionBrowserDeps(): BrowserToolDeps {
  const browser = requireProduction("./browser") as typeof import("./browser");
  const vault = requireProduction(
    "./credential-vault",
  ) as typeof import("./credential-vault");
  return {
    browserIsOpen: browser.browserIsOpen,
    browserSessionUrl: browser.browserSessionUrl,
    openBrowser: browser.openBrowser,
    snapshotBrowser: browser.snapshotBrowser,
    clickBrowser: browser.clickBrowser,
    typeBrowser: browser.typeBrowser,
    screenshotBrowser: browser.screenshotBrowser,
    startBrowserRecording: browser.startBrowserRecording,
    stopBrowserRecording: browser.stopBrowserRecording,
    resolveCredentialProfile: vault.resolveCredentialProfile,
  };
}

export async function executeBrowserTool(
  name: string,
  input: Record<string, unknown>,
  browserSessionId: string,
  requestId: string,
  messages: { role: string; content: string }[],
  signal: AbortSignal,
  onProgress: (output: string) => void = () => undefined,
  deps?: BrowserToolDeps,
): Promise<ToolResult> {
  const resolved = deps ?? productionBrowserDeps();
  if (name === "browser_open") {
    const result = await resolved.openBrowser(
      browserSessionId,
      String(input.url || ""),
      requestId,
    );
    return { output: JSON.stringify(result, null, 2) };
  }
  if (name === "browser_snapshot")
    return {
      output: JSON.stringify(
        await resolved.snapshotBrowser(browserSessionId, {
          signal,
          onProgress,
          waitForVerification: !hasUserSuppliedVerificationCode(messages),
        }),
        null,
        2,
      ),
    };
  if (name === "browser_click")
    return {
      output: JSON.stringify(
        await resolved.clickBrowser(browserSessionId, String(input.ref || "")),
        null,
        2,
      ),
    };
  if (name === "browser_type")
    return {
      output: JSON.stringify(
        await resolved.typeBrowser(
          browserSessionId,
          String(input.ref || ""),
          String(input.text ?? ""),
        ),
        null,
        2,
      ),
    };
  if (name === "browser_fill_credential") {
    const saved = await resolved.resolveCredentialProfile(
      "website",
      String(input.credentialName || ""),
    );
    const currentUrl = currentBrowserWebsiteOrigin(browserSessionId, resolved);
    if (
      !saved.descriptor.url ||
      !sameWebsiteOrigin(currentUrl, saved.descriptor.url)
    )
      throw new Error(
        `当前网页与凭据“${saved.descriptor.name}”保存的网站不一致，已拒绝填充。`,
      );
    const username = String(saved.payload.username || "");
    const password = String(saved.payload.password || "");
    if (!username || !password)
      throw new Error(`网站凭据“${saved.descriptor.name}”缺少账号或密码。`);
    const filled: string[] = [];
    const usernameRef = String(input.usernameRef || "").trim();
    const passwordRef = String(input.passwordRef || "").trim();
    if (usernameRef) {
      await resolved.typeBrowser(browserSessionId, usernameRef, username);
      filled.push("username");
    }
    if (!passwordRef) throw new Error("缺少密码输入框引用。");
    await resolved.typeBrowser(browserSessionId, passwordRef, password);
    filled.push("password");
    return {
      output: JSON.stringify(
        {
          filled,
          credentialName: saved.descriptor.name,
          origin: saved.descriptor.url,
          secretsReturned: false,
        },
        null,
        2,
      ),
      executed: true,
      browserOperationEvidence: ["type"],
    };
  }
  if (name === "browser_screenshot") {
    const result = await resolved.screenshotBrowser(browserSessionId, {
      width: input.width === undefined ? undefined : Number(input.width),
      height: input.height === undefined ? undefined : Number(input.height),
      mobile: typeof input.mobile === "boolean" ? input.mobile : undefined,
      fullPage: input.fullPage === true,
    });
    return { output: JSON.stringify(result, null, 2), path: result.path };
  }
  if (name === "browser_record_start")
    return {
      output: JSON.stringify(
        await resolved.startBrowserRecording(
          browserSessionId,
          String(input.name || ""),
        ),
        null,
        2,
      ),
    };
  if (name === "browser_record_stop")
    return {
      output: JSON.stringify(
        await resolved.stopBrowserRecording(browserSessionId),
        null,
        2,
      ),
    };
  throw new Error(`不支持的浏览器工具：${name}`);
}

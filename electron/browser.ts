import { app, BrowserWindow, WebContentsView } from "electron";
import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import type { BrowserRecordingFile } from "../src/types";

type BrowserState = {
  open: boolean;
  // A session exists but its view is detached (hidden). The front-end uses this
  // to offer a "show" affordance instead of forcing a fresh browser_open.
  hidden?: boolean;
  sessionId?: string;
  requestId?: string;
  title?: string;
  url?: string;
  width?: number;
  recording?: boolean;
  canGoBack?: boolean;
  canGoForward?: boolean;
};
type RecordedOperation = {
  at: number;
  action: "goto" | "click" | "type" | "manual";
  url?: string;
  selector?: string;
  text?: string;
};
type RecordedRequest = {
  id: string;
  at: number;
  method: string;
  url: string;
  requestHeaders?: Record<string, string>;
  postData?: string;
  status?: number;
  responseHeaders?: Record<string, string>;
  mimeType?: string;
  responseBody?: string;
  bodyBase64?: boolean;
};
type BrowserRecording = {
  sessionId: string;
  name: string;
  startedAt: number;
  operations: RecordedOperation[];
  requests: Map<string, RecordedRequest>;
  listener?: (_event: Electron.Event, method: string, params: any) => void;
  attachedView?: WebContentsView;
  bodyBytes: number;
  draftPath: string;
  draftTimer?: ReturnType<typeof setTimeout>;
  draftWrite?: Promise<void>;
};
let host: BrowserWindow | undefined;
type BrowserSession = {
  sessionId: string;
  requestId: string;
  view: WebContentsView;
  attached: boolean;
  lastUsed: number;
};
const sessions = new Map<string, BrowserSession>();
let activeSessionId: string | undefined;
let selectedSessionId: string | undefined;
const recordings = new Map<string, BrowserRecording>();
let stateChanged: ((state: BrowserState) => void) | undefined;
let closedByUser: ((requestId: string) => void) | undefined;

export function setBrowserHost(
  window: BrowserWindow,
  callbacks: {
    onState(state: BrowserState): void;
    onUserClose(requestId: string): void;
  },
) {
  host = window;
  stateChanged = callbacks.onState;
  closedByUser = callbacks.onUserClose;
  const layout = () => layoutBrowser();
  window.on("resize", layout);
  window.on("closed", () => {
    for (const sessionId of recordings.keys())
      void stopBrowserRecording(sessionId, "interrupted").catch(
        () => undefined,
      );
    host = undefined;
    sessions.clear();
    activeSessionId = undefined;
    selectedSessionId = undefined;
  });
}
const activeSession = () =>
  activeSessionId ? sessions.get(activeSessionId) : undefined;
const MIN_BROWSER_WIDTH = 360;
let userBrowserWidth: number | undefined;
function browserWidth() {
  if (!host) return userBrowserWidth ?? 520;
  // Leave the main column at least 360px so the panel can never swallow the app.
  const max = Math.max(
    MIN_BROWSER_WIDTH,
    host.getContentBounds().width - MIN_BROWSER_WIDTH,
  );
  const preferred =
    userBrowserWidth ?? Math.round(host.getContentBounds().width * 0.42);
  return Math.min(max, Math.max(MIN_BROWSER_WIDTH, preferred));
}
export function setBrowserWidth(width: number) {
  if (!Number.isFinite(width)) return;
  userBrowserWidth = Math.max(MIN_BROWSER_WIDTH, Math.round(width));
  layoutBrowser();
}
// The native view is inset from the panel's left edge so the DOM resize handle
// that sits there keeps receiving pointer events instead of being covered.
const RESIZE_HANDLE_WIDTH = 6;
function layoutBrowser() {
  const active = activeSession();
  if (!host || !active) return;
  const bounds = host.getContentBounds(),
    width = browserWidth();
  active.view.setBounds({
    x: bounds.width - width + RESIZE_HANDLE_WIDTH,
    y: 77,
    width: Math.max(100, width - RESIZE_HANDLE_WIDTH),
    height: Math.max(100, bounds.height - 77),
  });
  stateChanged?.({
    open: true,
    sessionId: active.sessionId,
    requestId: active.requestId,
    title: active.view.webContents.getTitle(),
    url: active.view.webContents.getURL(),
    width,
    recording: recordings.has(active.sessionId),
    canGoBack: active.view.webContents.navigationHistory.canGoBack(),
    canGoForward: active.view.webContents.navigationHistory.canGoForward(),
  });
}
function page(sessionId: string) {
  const session = sessions.get(sessionId);
  if (!session || session.view.webContents.isDestroyed())
    throw new Error("浏览器页面已关闭");
  if (selectedSessionId === sessionId) layoutBrowser();
  session.lastUsed = Date.now();
  return session.view;
}
function pruneBackgroundSessions() {
  if (sessions.size <= 6) return;
  const candidates = [...sessions.values()]
    .filter(
      (session) =>
        session.sessionId !== activeSessionId &&
        !recordings.has(session.sessionId),
    )
    .sort((a, b) => a.lastUsed - b.lastUsed);
  while (sessions.size > 6 && candidates.length)
    destroySession(candidates.shift()!.sessionId, false);
}
function validUrl(input: string) {
  const url = new URL(input);
  if (!/^https?:$/.test(url.protocol))
    throw new Error("浏览器只允许打开 HTTP/HTTPS 地址");
  return url.href;
}
const script = (fn: string, value: unknown) =>
  `(${fn})(${JSON.stringify(value)})`;
async function executePage<T>(
  view: WebContentsView,
  source: string,
): Promise<T> {
  const result = (await view.webContents.executeJavaScript(
    `Promise.resolve().then(() => (${source})).catch(error => ({ __kcodeError: String(error?.message || error), __kcodeStack: String(error?.stack || '') }))`,
    true,
  )) as T | { __kcodeError: string; __kcodeStack?: string };
  if (result && typeof result === "object" && "__kcodeError" in result)
    throw new Error(
      `网页脚本执行失败：${result.__kcodeError}${result.__kcodeStack ? `\n${result.__kcodeStack}` : ""}`,
    );
  return result as T;
}
const safeName = (value: string) =>
  (value.trim() || `browser-${new Date().toISOString().replace(/[:.]/g, "-")}`)
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .slice(0, 80);
const recordingsDir = () => path.join(app.getPath("userData"), "recordings");
const recordingData = (
  recording: BrowserRecording,
  status: "recording" | "completed" | "interrupted",
) => ({
  name: recording.name,
  startedAt: recording.startedAt,
  completedAt: status === "recording" ? undefined : Date.now(),
  status,
  operations: recording.operations,
  requests: [...recording.requests.values()],
});
async function flushRecordingDraft(recording: BrowserRecording) {
  if (recording.draftTimer) clearTimeout(recording.draftTimer);
  recording.draftTimer = undefined;
  const write = async () => {
    await mkdir(path.dirname(recording.draftPath), { recursive: true });
    const temporary = `${recording.draftPath}.${process.pid}.tmp`;
    await writeFile(
      temporary,
      JSON.stringify(recordingData(recording, "recording"), null, 2),
      "utf8",
    );
    await rename(temporary, recording.draftPath);
  };
  recording.draftWrite = (recording.draftWrite ?? Promise.resolve())
    .catch(() => undefined)
    .then(write);
  await recording.draftWrite;
}
function scheduleRecordingDraft(recording: BrowserRecording) {
  if (recording.draftTimer) return;
  recording.draftTimer = setTimeout(
    () => void flushRecordingDraft(recording).catch(() => undefined),
    750,
  );
}
async function attachRecorder(sessionId: string, view: WebContentsView) {
  const recording = recordings.get(sessionId);
  if (!recording || recording.attachedView === view) return;
  if (view.webContents.debugger.isAttached())
    throw new Error("浏览器调试协议已被其他功能占用，无法开始录制");
  view.webContents.debugger.attach("1.3");
  await view.webContents.debugger.sendCommand("Network.enable", {
    maxTotalBufferSize: 50_000_000,
    maxResourceBufferSize: 2_000_000,
  });
  const listener = (_event: Electron.Event, method: string, p: any) => {
    if (
      method === "Network.requestWillBeSent" &&
      recording.requests.size < 5000
    ) {
      recording.requests.set(p.requestId, {
        id: p.requestId,
        at: Date.now(),
        method: p.request.method,
        url: p.request.url,
        requestHeaders: p.request.headers,
        postData: p.request.postData?.slice(0, 1_000_000),
      });
      scheduleRecordingDraft(recording);
    } else if (method === "Network.responseReceived") {
      const item = recording.requests.get(p.requestId);
      if (item)
        Object.assign(item, {
          status: p.response.status,
          responseHeaders: p.response.headers,
          mimeType: p.response.mimeType,
        });
      scheduleRecordingDraft(recording);
    } else if (method === "Network.loadingFinished") {
      const item = recording.requests.get(p.requestId);
      if (
        !item ||
        recording.bodyBytes >= 50_000_000 ||
        !/(json|text|javascript|xml|html|form)/i.test(item.mimeType || "")
      )
        return;
      void view.webContents.debugger
        .sendCommand("Network.getResponseBody", { requestId: p.requestId })
        .then((body: any) => {
          const value = String(body.body || "");
          const bytes = Buffer.byteLength(value);
          if (bytes <= 1_000_000 && recording.bodyBytes + bytes <= 50_000_000) {
            item.responseBody = value;
            item.bodyBase64 = Boolean(body.base64Encoded);
            recording.bodyBytes += bytes;
            scheduleRecordingDraft(recording);
          }
        })
        .catch(() => undefined);
    }
  };
  view.webContents.debugger.on("message", listener);
  recording.listener = listener;
  recording.attachedView = view;
}
function recordOperation(requestId: string, operation: RecordedOperation) {
  const recording = recordings.get(requestId);
  if (!recording) return;
  recording.operations.push(operation);
  scheduleRecordingDraft(recording);
}
function destroySession(sessionId: string, notifyUser = false) {
  const session = sessions.get(sessionId);
  if (!session) return;
  const { requestId, view } = session;
  sessions.delete(sessionId);
  if (recordings.has(sessionId))
    void stopBrowserRecording(sessionId, "interrupted").catch(() => undefined);
  if (activeSessionId === sessionId) activeSessionId = undefined;
  // Clear the selected pointer too, otherwise a later browser_open for the same
  // session id sees a stale selection and fails to attach, leaving it unopenable.
  if (selectedSessionId === sessionId) selectedSessionId = undefined;
  try {
    host?.contentView.removeChildView(view);
  } catch {
    /* Already detached. */
  }
  if (!view.webContents.isDestroyed()) view.webContents.close();
  if (!activeSessionId) stateChanged?.({ open: false });
  if (notifyUser) closedByUser?.(requestId);
}
export function closeBrowserPanel(sessionId?: string, userInitiated = true) {
  const target = sessionId ?? activeSessionId;
  if (target) destroySession(target, userInitiated);
}
// Detach the native view from the window but keep the session (and its process)
// alive so it can be shown again later. Unlike closeBrowserPanel this does not
// destroy the page or stop the underlying browser task.
export function hideBrowserPanel(sessionId?: string) {
  const target = sessionId ?? activeSessionId ?? selectedSessionId;
  const session = target ? sessions.get(target) : undefined;
  if (!session) return;
  if (session.attached) {
    try {
      host?.contentView.removeChildView(session.view);
    } catch {
      /* Already detached. */
    }
    session.attached = false;
  }
  if (activeSessionId === target) activeSessionId = undefined;
  // Keep selectedSessionId so activate() can re-show this exact session later.
  selectedSessionId = target;
  stateChanged?.({
    open: false,
    hidden: true,
    sessionId: target,
    title: session.view.webContents.getTitle(),
    url: session.view.webContents.getURL(),
  });
}
export function browserIsOpen(sessionId: string) {
  const session = sessions.get(sessionId);
  return Boolean(session && !session.view.webContents.isDestroyed());
}
export function bindBrowserRequest(sessionId: string, requestId: string) {
  const session = sessions.get(sessionId);
  if (session) {
    session.requestId = requestId;
    if (activeSessionId === sessionId) layoutBrowser();
  }
}
export function activateBrowserSession(sessionId?: string) {
  selectedSessionId = sessionId;
  const next = sessionId ? sessions.get(sessionId) : undefined;
  const current = activeSession();
  if (current && current.attached && current !== next) {
    try {
      host?.contentView.removeChildView(current.view);
    } catch {}
    current.attached = false;
  }
  activeSessionId = next?.sessionId;
  if (!next) {
    stateChanged?.({ open: false });
    return;
  }
  if (!next.attached) {
    host?.contentView.addChildView(next.view);
    next.attached = true;
  }
  next.lastUsed = Date.now();
  layoutBrowser();
}

export async function navigateBrowser(
  sessionId: string | undefined,
  input: string,
) {
  const target = sessionId ?? activeSessionId;
  if (!target) throw new Error("没有可导航的浏览器页面");
  const session = sessions.get(target);
  if (!session) throw new Error("浏览器页面已关闭");
  const url = validUrl(input);
  await session.view.webContents.loadURL(url);
  recordOperation(target, { at: Date.now(), action: "goto", url });
  layoutBrowser();
}

export function backBrowser(sessionId?: string) {
  const view = page(sessionId ?? activeSessionId ?? "");
  if (view.webContents.navigationHistory.canGoBack())
    view.webContents.navigationHistory.goBack();
}

export function forwardBrowser(sessionId?: string) {
  const view = page(sessionId ?? activeSessionId ?? "");
  if (view.webContents.navigationHistory.canGoForward())
    view.webContents.navigationHistory.goForward();
}

export function reloadBrowser(sessionId?: string) {
  const view = page(sessionId ?? activeSessionId ?? "");
  view.webContents.reload();
  // On Windows a WebContentsView often keeps a stale compositor surface after a
  // reload and paints white until its bounds change. Nudge the bounds once the
  // new document starts painting to force a repaint.
  view.webContents.once("did-stop-loading", () => forceBrowserRepaint(sessionId));
}
// Toggle the active view's width by a pixel and back to force the compositor to
// re-attach its surface. Used after operations that can leave a blank view.
function forceBrowserRepaint(sessionId?: string) {
  const session = sessions.get(sessionId ?? activeSessionId ?? "");
  if (!host || !session || session.view.webContents.isDestroyed()) return;
  if (selectedSessionId && session.sessionId !== selectedSessionId) return;
  const bounds = session.view.getBounds();
  session.view.setBounds({ ...bounds, width: bounds.width + 1 });
  session.view.setBounds(bounds);
}
export async function openBrowser(
  sessionId: string,
  input: string,
  requestId = sessionId,
) {
  if (!host || host.isDestroyed()) throw new Error("主窗口不可用");
  const url = validUrl(input);
  let session = sessions.get(sessionId);
  if (!session || session.view.webContents.isDestroyed()) {
    const view = new WebContentsView({
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        partition: `persist:kcode-browser-${sessionId.replace(/[^a-zA-Z0-9_-]/g, "_")}`,
      },
    });
    session = {
      sessionId,
      requestId,
      view,
      attached: false,
      lastUsed: Date.now(),
    };
    sessions.set(sessionId, session);
    pruneBackgroundSessions();
    if (selectedSessionId === sessionId) activateBrowserSession(sessionId);
    view.webContents.setWindowOpenHandler(({ url: next }) => {
      if (/^https?:\/\//i.test(next)) void view.webContents.loadURL(next);
      return { action: "deny" };
    });
    const update = () => {
      if (activeSessionId !== sessionId) return;
      stateChanged?.({
        open: true,
        sessionId,
        requestId: sessions.get(sessionId)?.requestId,
        title: view.webContents.getTitle(),
        url: view.webContents.getURL(),
        width: browserWidth(),
        recording: recordings.has(sessionId),
        canGoBack: view.webContents.navigationHistory.canGoBack(),
        canGoForward: view.webContents.navigationHistory.canGoForward(),
      });
    };
    view.webContents.on("page-title-updated", update);
    view.webContents.on("did-navigate", update);
    view.webContents.on("did-navigate-in-page", update);
    view.webContents.on("render-process-gone", () => {
      if (sessions.get(sessionId)?.view === view)
        destroySession(sessionId, true);
    });
  }
  session.requestId = requestId;
  if (selectedSessionId === sessionId) activateBrowserSession(sessionId);
  if (recordings.has(sessionId)) await attachRecorder(sessionId, session.view);
  await session.view.webContents.loadURL(url);
  layoutBrowser();
  if (recordings.has(sessionId))
    recordOperation(sessionId, { at: Date.now(), action: "goto", url });
  return {
    url: session.view.webContents.getURL(),
    title: session.view.webContents.getTitle(),
    embedded: true,
  };
}
export async function snapshotBrowser(requestId: string) {
  const result = await executePage<any>(
    page(requestId),
    `(() => {
    document.querySelectorAll('[data-kcode-ref]').forEach(el => el.removeAttribute('data-kcode-ref'));
    const nodes=[...document.querySelectorAll('a,button,input,textarea,select,[role="button"],[contenteditable="true"]')];
    const visible=nodes.filter(el=>{const r=el.getBoundingClientRect(),s=getComputedStyle(el);return r.width>0&&r.height>0&&s.visibility!=='hidden'&&s.display!=='none';}).slice(0,300);
    const elements=visible.map((el,i)=>{const ref='r'+(i+1);el.setAttribute('data-kcode-ref',ref);const input=el;return{ref,tag:el.tagName.toLowerCase(),type:input.type||'',text:(el.innerText||(input.type==='password'?'':input.value)||'').slice(0,160),placeholder:(input.placeholder||'').slice(0,120),ariaLabel:(el.getAttribute('aria-label')||'').slice(0,120)};});
    const text=(document.body?.innerText||'').replace(/\\n{3,}/g,'\\n\\n').slice(0,20000);const requiresUserAction=/(验证码|人机验证|短信验证|二次验证|captcha|verify you are human|two[- ]factor|\\b2fa\\b|cloudflare)/i.test(text);return{url:location.href,title:document.title,text,elements,requiresUserAction};
  })()`,
  );
  if (result.requiresUserAction) {
    const recording = recordings.get(requestId),
      recent = recording?.operations.at(-1);
    if (
      recording &&
      !(recent?.action === "manual" && Date.now() - recent.at < 30_000)
    )
      recordOperation(requestId, {
        at: Date.now(),
        action: "manual",
        text: "请在浏览器中完成人机验证、短信、Passkey 或双重验证，然后按 Enter 继续",
      });
  }
  return result;
}
export async function inspectBrowserRef(requestId: string, ref: string) {
  return executePage<{ text: string; type: string; tag: string } | null>(
    page(requestId),
    script(
      `ref=>{const el=document.querySelector('[data-kcode-ref="'+CSS.escape(ref)+'"]');if(!el)return null;return{text:(el.innerText||el.value||el.getAttribute('aria-label')||'').slice(0,200),type:el.type||'',tag:el.tagName.toLowerCase()};}`,
      ref,
    ),
  );
}
export async function clickBrowser(requestId: string, ref: string) {
  const view = page(requestId);
  const target = await executePage<{
    x: number;
    y: number;
    text: string;
    selector: string;
  }>(
    view,
    script(
      `ref=>{const el=document.querySelector('[data-kcode-ref="'+CSS.escape(ref)+'"]');if(!el)throw new Error('页面元素已失效，请重新获取快照');el.scrollIntoView({block:'center',inline:'center'});const r=el.getBoundingClientRect();if(r.width<=0||r.height<=0)throw new Error('页面元素当前不可见，请重新获取快照');const selector=el.id?'#'+CSS.escape(el.id):el.getAttribute('name')?el.tagName.toLowerCase()+'[name="'+CSS.escape(el.getAttribute('name'))+'"]':el.getAttribute('aria-label')?'[aria-label="'+CSS.escape(el.getAttribute('aria-label'))+'"]':el.getAttribute('placeholder')?'[placeholder="'+CSS.escape(el.getAttribute('placeholder'))+'"]':'text='+((el.innerText||el.value||'').trim().slice(0,100));return{x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2),text:(el.innerText||el.value||el.getAttribute('aria-label')||'').slice(0,160),selector};}`,
      ref,
    ),
  );
  view.webContents.sendInputEvent({
    type: "mouseMove",
    x: target.x,
    y: target.y,
  });
  view.webContents.sendInputEvent({
    type: "mouseDown",
    x: target.x,
    y: target.y,
    button: "left",
    clickCount: 1,
  });
  view.webContents.sendInputEvent({
    type: "mouseUp",
    x: target.x,
    y: target.y,
    button: "left",
    clickCount: 1,
  });
  recordOperation(requestId, {
    at: Date.now(),
    action: "click",
    selector: target.selector,
  });
  await new Promise((resolve) => setTimeout(resolve, 800));
  return {
    clicked: true,
    text: target.text,
    url: view.webContents.getURL(),
    trustedInput: true,
  };
}
export async function typeBrowser(
  requestId: string,
  ref: string,
  text: string,
) {
  const result = await executePage<any>(
    page(requestId),
    script(
      `arg=>{const el=document.querySelector('[data-kcode-ref="'+CSS.escape(arg.ref)+'"]');if(!el)throw new Error('页面元素已失效，请重新获取快照');el.focus();const proto=el instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;const setter=Object.getOwnPropertyDescriptor(proto,'value')?.set;setter?.call(el,arg.text);if(!setter)el.textContent=arg.text;el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));const selector=el.id?'#'+CSS.escape(el.id):el.getAttribute('name')?el.tagName.toLowerCase()+'[name="'+CSS.escape(el.getAttribute('name'))+'"]':el.getAttribute('aria-label')?'[aria-label="'+CSS.escape(el.getAttribute('aria-label'))+'"]':el.getAttribute('placeholder')?'[placeholder="'+CSS.escape(el.getAttribute('placeholder'))+'"]':el.tagName.toLowerCase();return{typed:true,ref:arg.ref,characters:arg.text.length,sensitive:el.type==='password',selector};}`,
      { ref, text },
    ),
  );
  recordOperation(requestId, {
    at: Date.now(),
    action: "type",
    selector: result.selector,
    text,
  });
  return result;
}
export async function startBrowserRecording(requestId: string, name = "") {
  if (recordings.has(requestId)) throw new Error("当前浏览器任务已经在录制");
  const recording: BrowserRecording = {
    sessionId: requestId,
    name: safeName(name),
    startedAt: Date.now(),
    operations: [],
    requests: new Map(),
    bodyBytes: 0,
    draftPath: path.join(
      recordingsDir(),
      `${safeName(name)}-${Date.now()}.draft.json`,
    ),
  };
  recordings.set(requestId, recording);
  await flushRecordingDraft(recording);
  const session = sessions.get(requestId);
  if (session && !session.view.webContents.isDestroyed())
    await attachRecorder(requestId, session.view);
  layoutBrowser();
  return { recording: true, name: recording.name };
}
const py = (value: string) => JSON.stringify(value);
export async function stopBrowserRecording(
  requestId: string,
  status: "completed" | "interrupted" = "completed",
) {
  const recording = recordings.get(requestId);
  if (!recording) throw new Error("当前浏览器任务没有开启录制");
  if (
    recording.attachedView &&
    recording.listener &&
    !recording.attachedView.webContents.isDestroyed()
  ) {
    recording.attachedView.webContents.debugger.removeListener(
      "message",
      recording.listener,
    );
    if (recording.attachedView.webContents.debugger.isAttached())
      recording.attachedView.webContents.debugger.detach();
  }
  await flushRecordingDraft(recording);
  recordings.delete(requestId);
  layoutBrowser();
  const dir = recordingsDir();
  await mkdir(dir, { recursive: true });
  const base = path.join(dir, `${recording.name}-${recording.startedAt}`),
    jsonPath = `${base}.json`,
    pythonPath = `${base}.py`;
  const data = recordingData(recording, status);
  await writeFile(jsonPath, JSON.stringify(data, null, 2), "utf8");
  const lines = [
    "from pathlib import Path",
    "from playwright.sync_api import sync_playwright",
    "",
    'ARTIFACTS = Path(__file__).with_suffix("")',
    "ARTIFACTS.mkdir(exist_ok=True)",
    "",
    "def current_page(context):",
    "    pages = [page for page in context.pages if not page.is_closed()]",
    '    if not pages: raise RuntimeError("No active browser page")',
    "    return pages[-1]",
    "",
    "def locate(context, selector):",
    "    page = current_page(context)",
    "    for frame in page.frames:",
    "        locator = frame.locator(selector).first",
    "        try:",
    "            if locator.count() and locator.is_visible(timeout=500): return locator",
    "        except Exception: pass",
    '    raise RuntimeError(f"Element not found: {selector}")',
    "",
    "def run():",
    "    with sync_playwright() as p:",
    '        browser = p.chromium.launch(headless=False, downloads_path=str(ARTIFACTS / "downloads"))',
    "        context = browser.new_context(accept_downloads=True)",
    "        context.tracing.start(screenshots=True, snapshots=True, sources=True)",
    "        context.new_page()",
    "        try:",
  ];
  for (const op of recording.operations) {
    if (op.action === "goto" && op.url)
      lines.push(
        `            current_page(context).goto(${py(op.url)}, wait_until="domcontentloaded", timeout=60000)`,
      );
    else if (op.action === "click" && op.selector)
      lines.push(
        `            locate(context, ${py(op.selector)}).click(timeout=30000)`,
        "            current_page(context).wait_for_timeout(500)",
      );
    else if (op.action === "type" && op.selector)
      lines.push(
        `            locate(context, ${py(op.selector)}).fill(${py(op.text || "")}, timeout=30000)`,
      );
    else if (op.action === "manual")
      lines.push(
        `            input(${py(op.text || "请在浏览器中完成人工验证，然后按 Enter 继续")})`,
      );
  }
  lines.push(
    '            context.storage_state(path=str(ARTIFACTS / "storage-state.json"))',
    '            context.tracing.stop(path=str(ARTIFACTS / "trace.zip"))',
    "        except Exception:",
    '            current_page(context).screenshot(path=str(ARTIFACTS / "failure.png"), full_page=True)',
    '            context.tracing.stop(path=str(ARTIFACTS / "trace.zip"))',
    "            raise",
    "        finally:",
    "            browser.close()",
    "",
    'if __name__ == "__main__":',
    "    run()",
    "",
  );
  await writeFile(pythonPath, lines.join("\n"), "utf8");
  await rm(recording.draftPath, { force: true });
  return {
    recording: false,
    status,
    name: recording.name,
    operations: recording.operations.length,
    requests: recording.requests.size,
    jsonPath,
    pythonPath,
  };
}
export async function recoverBrowserRecordingDrafts() {
  const dir = recordingsDir();
  await mkdir(dir, { recursive: true });
  const drafts = (await readdir(dir)).filter((name) =>
    name.endsWith(".draft.json"),
  );
  for (const draft of drafts) {
    try {
      const source = path.join(dir, draft);
      const data = JSON.parse(await readFile(source, "utf8"));
      const target = path.join(dir, draft.replace(/\.draft\.json$/, ".json"));
      await writeFile(
        target,
        JSON.stringify(
          {
            ...data,
            status: "interrupted",
            completedAt: Number(data.completedAt) || Date.now(),
          },
          null,
          2,
        ),
        "utf8",
      );
      await rm(source, { force: true });
    } catch {
      // Keep an unreadable draft for manual recovery instead of deleting it.
    }
  }
}
export async function listBrowserRecordings(): Promise<BrowserRecordingFile[]> {
  try {
    const dir = recordingsDir(),
      files = (await readdir(dir)).filter(
        (name) => name.endsWith(".json") && !name.endsWith(".draft.json"),
      );
    const items = await Promise.all(
      files.map(async (id) => {
        const file = path.join(dir, id),
          data = JSON.parse(await readFile(file, "utf8")),
          base = id.slice(0, -5);
        return {
          id,
          name: String(data.name || base),
          startedAt: Number(data.startedAt) || 0,
          completedAt: Number(data.completedAt) || 0,
          status: data.status === "interrupted" ? "interrupted" : "completed",
          operations: Array.isArray(data.operations)
            ? data.operations.length
            : 0,
          requests: Array.isArray(data.requests) ? data.requests.length : 0,
          jsonPath: file,
          pythonPath: path.join(dir, `${base}.py`),
        } as BrowserRecordingFile;
      }),
    );
    return items.sort((a, b) => b.startedAt - a.startedAt);
  } catch {
    return [];
  }
}
export async function removeBrowserRecording(id: string) {
  const safe = path.basename(id);
  if (safe !== id || !safe.endsWith(".json"))
    throw new Error("录制记录 ID 无效");
  const dir = recordingsDir(),
    base = safe.slice(0, -5);
  await Promise.all([
    rm(path.join(dir, safe), { force: true }),
    rm(path.join(dir, `${base}.py`), { force: true }),
  ]);
  return listBrowserRecordings();
}
export async function screenshotBrowser(requestId: string) {
  const view = page(requestId),
    image = await view.webContents.capturePage(),
    dir = path.join(app.getPath("userData"), "browser-screenshots");
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `${Date.now()}.png`);
  await writeFile(file, image.toPNG());
  return { path: file, url: view.webContents.getURL() };
}
export function cleanupBrowsers(sessionIds: string[]) {
  for (const [sessionId, session] of sessions)
    if (
      sessionIds.includes(sessionId) ||
      sessionIds.includes(session.requestId)
    )
      destroySession(sessionId, false);
}

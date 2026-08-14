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
import {
  boxModelCenter,
  detectHumanVerification,
  extractAccessibilityFrame,
  normalizeBrowserScreenshotOptions,
  type BrowserAccessibilityEntry,
  type BrowserScreenshotOptions,
  type BrowserVerification,
  type CdpAxNode,
} from "./browser-cdp";
import { browserStoragePartition } from "./browser-profile";

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
  verificationRequired?: boolean;
  verificationSince?: number;
  verificationMessage?: string;
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
  listener?: (
    _event: Electron.Event,
    method: string,
    params: any,
    debuggerSessionId: string,
  ) => void;
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
type BrowserElementRef = {
  ref: string;
  source: "accessibility" | "coordinate";
  backendNodeId?: number;
  role: string;
  name: string;
  value?: string;
  description?: string;
  nth: number;
  frameId?: string;
  debuggerSessionId?: string;
  x?: number;
  y?: number;
  sensitive?: boolean;
  selector?: string;
};
type BrowserAutomationState = {
  refs: Map<string, BrowserElementRef>;
  iframeSessions: Map<string, string>;
  iframePreparing: Map<string, Promise<void>>;
  prepared: boolean;
  preparing?: Promise<void>;
  verification?: BrowserVerification & { since: number };
  messageListener: (
    _event: Electron.Event,
    method: string,
    params: any,
    debuggerSessionId: string,
  ) => void;
  detachListener: (_event: Electron.Event, reason: string) => void;
};
const automationStates = new Map<string, BrowserAutomationState>();
let stateChanged: ((state: BrowserState) => void) | undefined;
let closedByUser: ((requestId: string) => void) | undefined;
let verificationRequired:
  | ((details: {
      sessionId: string;
      requestId: string;
      message: string;
    }) => void)
  | undefined;

const cdp = (
  view: WebContentsView,
  method: string,
  params: Record<string, unknown> = {},
  debuggerSessionId?: string,
) =>
  view.webContents.debugger.sendCommand(
    method,
    params,
    debuggerSessionId,
  ) as Promise<any>;

function browserOperationTimeout<T>(
  operation: Promise<T>,
  label: string,
  timeoutMs = 15_000,
) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new Error(`${label}超时（${Math.round(timeoutMs / 1_000)} 秒）`),
        ),
      timeoutMs,
    );
    timer.unref?.();
  });
  return Promise.race([operation, timeout]).finally(() => clearTimeout(timer));
}

function automationState(sessionId: string, view: WebContentsView) {
  const existing = automationStates.get(sessionId);
  if (existing) return existing;
  const state = {} as BrowserAutomationState;
  state.refs = new Map();
  state.iframeSessions = new Map();
  state.iframePreparing = new Map();
  state.prepared = false;
  state.messageListener = (_event, method, params) => {
    if (method === "Target.attachedToTarget") {
      const childSessionId = String(params?.sessionId || "");
      const target = params?.targetInfo;
      if (!childSessionId) return;
      if (target?.type === "iframe" && target?.targetId)
        state.iframeSessions.set(String(target.targetId), childSessionId);
      const preparation = prepareAttachedTarget(view, childSessionId)
        .catch(() => undefined)
        .finally(() => state.iframePreparing.delete(childSessionId));
      state.iframePreparing.set(childSessionId, preparation);
      return;
    }
    if (method === "Target.detachedFromTarget") {
      const detached = String(params?.sessionId || "");
      for (const [frameId, childSessionId] of state.iframeSessions)
        if (childSessionId === detached) state.iframeSessions.delete(frameId);
      state.iframePreparing.delete(detached);
    }
  };
  state.detachListener = () => {
    state.prepared = false;
    state.preparing = undefined;
    state.refs.clear();
    state.iframeSessions.clear();
    state.iframePreparing.clear();
  };
  view.webContents.debugger.on("message", state.messageListener);
  view.webContents.debugger.on("detach", state.detachListener);
  automationStates.set(sessionId, state);
  return state;
}

async function prepareAttachedTarget(
  view: WebContentsView,
  debuggerSessionId: string,
) {
  await Promise.allSettled([
    cdp(view, "DOM.enable", {}, debuggerSessionId),
    cdp(view, "Accessibility.enable", {}, debuggerSessionId),
    cdp(view, "Runtime.enable", {}, debuggerSessionId),
    cdp(view, "Page.enable", {}, debuggerSessionId),
    cdp(view, "Network.enable", {}, debuggerSessionId),
  ]);
  await cdp(
    view,
    "Target.setAutoAttach",
    { autoAttach: true, waitForDebuggerOnStart: false, flatten: true },
    debuggerSessionId,
  ).catch(() => undefined);
}

async function ensureBrowserDebugger(sessionId: string, view: WebContentsView) {
  const state = automationState(sessionId, view);
  if (state.prepared && view.webContents.debugger.isAttached()) return state;
  if (state.preparing) {
    await state.preparing;
    return state;
  }
  state.preparing = (async () => {
    if (!view.webContents.debugger.isAttached())
      view.webContents.debugger.attach("1.3");
    await Promise.all([
      cdp(view, "DOM.enable"),
      cdp(view, "Accessibility.enable"),
      cdp(view, "Runtime.enable"),
      cdp(view, "Page.enable"),
      cdp(view, "Network.enable"),
    ]);
    await cdp(view, "Target.setAutoAttach", {
      autoAttach: true,
      waitForDebuggerOnStart: false,
      flatten: true,
    });
    state.prepared = true;
  })().finally(() => {
    state.preparing = undefined;
  });
  await state.preparing;
  return state;
}

function invalidateBrowserRefs(sessionId: string) {
  automationStates.get(sessionId)?.refs.clear();
}

function disposeBrowserAutomation(sessionId: string, view: WebContentsView) {
  const state = automationStates.get(sessionId);
  if (!state) return;
  view.webContents.debugger.removeListener("message", state.messageListener);
  view.webContents.debugger.removeListener("detach", state.detachListener);
  automationStates.delete(sessionId);
}

export function setBrowserHost(
  window: BrowserWindow,
  callbacks: {
    onState(state: BrowserState): void;
    onUserClose(requestId: string): void;
    onVerificationRequired?(details: {
      sessionId: string;
      requestId: string;
      message: string;
    }): void;
  },
) {
  host = window;
  stateChanged = callbacks.onState;
  closedByUser = callbacks.onUserClose;
  verificationRequired = callbacks.onVerificationRequired;
  const layout = () => layoutBrowser();
  window.on("resize", layout);
  window.on("closed", () => {
    for (const sessionId of recordings.keys())
      void stopBrowserRecording(sessionId, "interrupted").catch(
        () => undefined,
      );
    for (const [sessionId, session] of sessions)
      disposeBrowserAutomation(sessionId, session.view);
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
// 32px title bar + 48px browser toolbar. Keep this aligned with BrowserPanel.
const BROWSER_CONTENT_TOP = 80;
const VERIFICATION_BAR_HEIGHT = 44;
function browserVerificationFields(sessionId: string) {
  const verification = automationStates.get(sessionId)?.verification;
  return verification
    ? {
        verificationRequired: true,
        verificationSince: verification.since,
        verificationMessage: verification.message,
      }
    : {};
}
function layoutBrowser() {
  const active = activeSession();
  if (!host || !active) return;
  const bounds = host.getContentBounds(),
    width = browserWidth(),
    contentTop =
      BROWSER_CONTENT_TOP +
      (automationStates.get(active.sessionId)?.verification
        ? VERIFICATION_BAR_HEIGHT
        : 0);
  active.view.setBounds({
    x: bounds.width - width + RESIZE_HANDLE_WIDTH,
    y: contentTop,
    width: Math.max(100, width - RESIZE_HANDLE_WIDTH),
    height: Math.max(100, bounds.height - contentTop),
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
    ...browserVerificationFields(active.sessionId),
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

function setBrowserVerification(
  sessionId: string,
  verification?: BrowserVerification,
) {
  const state = automationStates.get(sessionId);
  const session = sessions.get(sessionId);
  if (!state || !session) return;
  if (
    verification &&
    state.verification?.kind === verification.kind &&
    state.verification.message === verification.message
  )
    return;
  if (!verification && !state.verification) return;
  const wasRequired = Boolean(state.verification);
  if (verification)
    state.verification = {
      ...verification,
      since: state.verification?.since ?? Date.now(),
    };
  else state.verification = undefined;

  if (activeSessionId === sessionId) layoutBrowser();
  else if (selectedSessionId === sessionId)
    stateChanged?.({
      open: false,
      hidden: true,
      sessionId,
      requestId: session.requestId,
      title: session.view.webContents.getTitle(),
      url: session.view.webContents.getURL(),
      ...browserVerificationFields(sessionId),
    });

  if (verification && !wasRequired)
    verificationRequired?.({
      sessionId,
      requestId: session.requestId,
      message: verification.message,
    });
}
function pruneBackgroundSessions() {
  if (sessions.size <= 6) return;
  const candidates = [...sessions.values()]
    .filter(
      (session) =>
        session.sessionId !== activeSessionId &&
        !recordings.has(session.sessionId) &&
        !automationStates.get(session.sessionId)?.verification,
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
  if (!recording) return;
  await ensureBrowserDebugger(sessionId, view);
  if (recording.attachedView === view && recording.listener) return;
  await view.webContents.debugger.sendCommand("Network.enable", {
    maxTotalBufferSize: 50_000_000,
    maxResourceBufferSize: 2_000_000,
  });
  const listener = (
    _event: Electron.Event,
    method: string,
    p: any,
    debuggerSessionId: string,
  ) => {
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
      void cdp(
        view,
        "Network.getResponseBody",
        { requestId: p.requestId },
        debuggerSessionId || undefined,
      )
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
  disposeBrowserAutomation(sessionId, view);
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
  if (!target) return;
  const session = sessions.get(target);
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
    requestId: session.requestId,
    title: session.view.webContents.getTitle(),
    url: session.view.webContents.getURL(),
    ...browserVerificationFields(target),
  });
}
export function browserIsOpen(sessionId: string) {
  const session = sessions.get(sessionId);
  return Boolean(session && !session.view.webContents.isDestroyed());
}
export function browserSessionUrl(sessionId: string) {
  return page(sessionId).webContents.getURL();
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
  invalidateBrowserRefs(target);
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
  const target = sessionId ?? activeSessionId ?? "";
  const view = page(target);
  invalidateBrowserRefs(target);
  view.webContents.reload();
  // On Windows a WebContentsView often keeps a stale compositor surface after a
  // reload and paints white until its bounds change. Nudge the bounds once the
  // new document starts painting to force a repaint.
  view.webContents.once("did-stop-loading", () =>
    forceBrowserRepaint(sessionId),
  );
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
        partition: browserStoragePartition(sessionId),
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
        ...browserVerificationFields(sessionId),
      });
    };
    view.webContents.on("page-title-updated", update);
    view.webContents.on("did-start-navigation", () =>
      invalidateBrowserRefs(sessionId),
    );
    view.webContents.on("did-navigate", update);
    view.webContents.on("did-navigate-in-page", () => {
      invalidateBrowserRefs(sessionId);
      update();
    });
    view.webContents.on("render-process-gone", () => {
      if (sessions.get(sessionId)?.view === view)
        destroySession(sessionId, true);
    });
  }
  session.requestId = requestId;
  if (selectedSessionId === sessionId) activateBrowserSession(sessionId);
  if (recordings.has(sessionId)) await attachRecorder(sessionId, session.view);
  invalidateBrowserRefs(sessionId);
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
type BrowserFrame = { id: string; url: string; name?: string };

function flattenFrameTree(tree: any, frames: BrowserFrame[] = []) {
  const frame = tree?.frame;
  if (frame?.id)
    frames.push({
      id: String(frame.id),
      url: String(frame.url || ""),
      name: frame.name ? String(frame.name) : undefined,
    });
  for (const child of tree?.childFrames || []) flattenFrameTree(child, frames);
  return frames;
}

async function attachKnownIframeTargets(
  view: WebContentsView,
  state: BrowserAutomationState,
  frames: BrowserFrame[],
) {
  const frameIds = new Set(frames.map((frame) => frame.id));
  const targets = await cdp(view, "Target.getTargets").catch(() => null);
  for (const target of targets?.targetInfos || []) {
    const targetId = String(target?.targetId || "");
    if (
      target?.type !== "iframe" ||
      !frameIds.has(targetId) ||
      state.iframeSessions.has(targetId)
    )
      continue;
    try {
      const attached = await cdp(view, "Target.attachToTarget", {
        targetId,
        flatten: true,
      });
      if (attached?.sessionId) {
        const childSessionId = String(attached.sessionId);
        state.iframeSessions.set(targetId, childSessionId);
        await prepareAttachedTarget(view, childSessionId);
      }
    } catch {
      // Auto-attach may have won the race; its event updates the map.
    }
  }
}

async function pageDomSummary(view: WebContentsView) {
  return executePage<{
    url: string;
    title: string;
    text: string;
    controls: {
      role: string;
      name: string;
      x: number;
      y: number;
      selector: string;
    }[];
  }>(
    view,
    `(() => {
      const controls=[];
      const semanticTags=new Set(['a','button','input','select','textarea','details','summary']);
      const semanticRoles=new Set(['button','link','textbox','checkbox','radio','combobox','listbox','menuitem','menuitemcheckbox','menuitemradio','option','searchbox','slider','spinbutton','switch','tab','treeitem']);
      const walk=(root,offsetX,offsetY)=>{
        for(const el of root.querySelectorAll('*')){
          if(el.shadowRoot) walk(el.shadowRoot,offsetX,offsetY);
          if(el.tagName==='IFRAME'){
            try{
              const rect=el.getBoundingClientRect();
              if(el.contentDocument) walk(el.contentDocument,offsetX+rect.left+el.clientLeft,offsetY+rect.top+el.clientTop);
            }catch{}
          }
          if(controls.length>=120) continue;
          const tag=el.tagName.toLowerCase(),role=(el.getAttribute('role')||'').toLowerCase();
          if(semanticTags.has(tag)||semanticRoles.has(role)||el.closest('[hidden],[aria-hidden="true"]')) continue;
          const styles=el.ownerDocument.defaultView,style=styles.getComputedStyle(el),rect=el.getBoundingClientRect();
          if(rect.width<=1||rect.height<=1||style.display==='none'||style.visibility==='hidden'||Number(style.opacity)===0) continue;
          const parent=el.parentElement,parentPointer=parent&&styles.getComputedStyle(parent).cursor==='pointer';
          const ownHandler=typeof el.onclick==='function'||el.hasAttribute('onclick');
          const focusable=el.tabIndex>=0||el.isContentEditable;
          const pointer=style.cursor==='pointer'&&!parentPointer;
          if(!ownHandler&&!focusable&&!pointer) continue;
          const name=(el.getAttribute('aria-label')||el.getAttribute('title')||el.innerText||el.textContent||'').replace(/\\s+/g,' ').trim().slice(0,160);
          if(!name&&!el.isContentEditable) continue;
          controls.push({role:el.isContentEditable?'textbox':'clickable',name,x:Math.round(offsetX+rect.left+rect.width/2),y:Math.round(offsetY+rect.top+rect.height/2),selector:name?'text='+name:tag});
        }
      };
      if(document.documentElement) walk(document,0,0);
      return {url:location.href,title:document.title,text:(document.body?.innerText||'').replace(/\\n{3,}/g,'\\n\\n').slice(0,20000),controls};
    })()`,
  );
}

function elementText(entry: BrowserAccessibilityEntry) {
  return (
    entry.name ||
    (entry.sensitive ? "" : entry.value) ||
    entry.description
  )
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
}

async function accessibilitySnapshot(sessionId: string, view: WebContentsView) {
  const state = await ensureBrowserDebugger(sessionId, view);
  const frameTree = await cdp(view, "Page.getFrameTree");
  const frames = flattenFrameTree(frameTree?.frameTree);
  await attachKnownIframeTargets(view, state, frames);
  for (let depth = 0; depth < 3 && state.iframePreparing.size; depth += 1)
    await Promise.all([...state.iframePreparing.values()]);
  const knownFrameIds = new Set(frames.map((frame) => frame.id));
  for (const frameId of state.iframeSessions.keys())
    if (!knownFrameIds.has(frameId)) frames.push({ id: frameId, url: "" });
  const rootFrameId = frames[0]?.id;
  const dom = await pageDomSummary(view).catch(() => ({
    url: view.webContents.getURL(),
    title: view.webContents.getTitle(),
    text: "",
    controls: [],
  }));
  const elements: Record<string, unknown>[] = [];
  const textParts = new Set<string>();
  const counts = new Map<string, number>();
  state.refs.clear();
  let nextRef = 1;

  for (const frame of frames.slice(0, 40)) {
    if (nextRef > 240) break;
    const debuggerSessionId = state.iframeSessions.get(frame.id);
    const params =
      debuggerSessionId || frame.id === rootFrameId
        ? {}
        : { frameId: frame.id };
    let nodes: CdpAxNode[];
    try {
      const tree = await cdp(
        view,
        "Accessibility.getFullAXTree",
        params,
        debuggerSessionId,
      );
      nodes = Array.isArray(tree?.nodes) ? tree.nodes : [];
    } catch {
      continue;
    }
    const extracted = extractAccessibilityFrame(nodes);
    if (frame.id !== rootFrameId)
      for (const value of extracted.text) if (value) textParts.add(value);
    for (const entry of extracted.entries) {
      if (nextRef > 240) break;
      const countKey = `${frame.id}\u0000${entry.role}\u0000${entry.name}`;
      const nth = counts.get(countKey) || 0;
      counts.set(countKey, nth + 1);
      const ref = `r${nextRef++}`;
      const target: BrowserElementRef = {
        ref,
        source: "accessibility",
        backendNodeId: entry.backendNodeId,
        role: entry.role,
        name: entry.name,
        value: entry.sensitive ? undefined : entry.value,
        description: entry.description,
        nth,
        frameId: frame.id,
        debuggerSessionId,
        sensitive: entry.sensitive,
        selector: entry.name ? `text=${entry.name}` : entry.role,
      };
      state.refs.set(ref, target);
      elements.push({
        ref,
        tag: entry.role,
        role: entry.role,
        type: entry.role,
        text: elementText(entry),
        name: entry.name,
        value: entry.sensitive ? undefined : entry.value || undefined,
        description: entry.description || undefined,
        disabled: entry.disabled,
        checked: entry.checked,
        expanded: entry.expanded,
        selected: entry.selected,
        frame: frame.url || undefined,
      });
    }
  }

  const representedNames = new Set(
    [...state.refs.values()]
      .map((target) => target.name.trim().toLocaleLowerCase())
      .filter(Boolean),
  );
  for (const control of dom.controls) {
    if (nextRef > 300) break;
    if (
      control.name &&
      representedNames.has(control.name.trim().toLocaleLowerCase())
    )
      continue;
    const countKey = `coordinate\u0000${control.role}\u0000${control.name}`;
    const nth = counts.get(countKey) || 0;
    counts.set(countKey, nth + 1);
    const ref = `r${nextRef++}`;
    state.refs.set(ref, {
      ref,
      source: "coordinate",
      role: control.role,
      name: control.name,
      nth,
      x: control.x,
      y: control.y,
      selector: control.selector,
    });
    elements.push({
      ref,
      tag: control.role,
      role: control.role,
      type: control.role,
      text: control.name,
    });
  }

  const iframeText = [...textParts].join("\n");
  const text = [dom.text, iframeText]
    .filter(Boolean)
    .join("\n")
    .slice(0, 30000);
  const url = dom.url || view.webContents.getURL();
  const title = dom.title || view.webContents.getTitle();
  const verification = detectHumanVerification({
    text,
    url,
    title,
    elements,
  });
  return {
    url,
    title,
    text,
    elements,
    frames: frames.length,
    requiresUserAction: Boolean(verification),
    verification,
    engine: "cdp-accessibility",
  };
}

async function legacySnapshot(view: WebContentsView) {
  return executePage<any>(
    view,
    `(() => {
      document.querySelectorAll('[data-kcode-ref]').forEach(el => el.removeAttribute('data-kcode-ref'));
      const nodes=[...document.querySelectorAll('a,button,input,textarea,select,[role="button"],[contenteditable="true"]')];
      const visible=nodes.filter(el=>{const r=el.getBoundingClientRect(),s=getComputedStyle(el);return r.width>0&&r.height>0&&s.visibility!=='hidden'&&s.display!=='none';}).slice(0,300);
      const elements=visible.map((el,i)=>{const ref='r'+(i+1);el.setAttribute('data-kcode-ref',ref);const input=el;return{ref,tag:el.tagName.toLowerCase(),type:input.type||'',text:(el.innerText||(input.type==='password'?'':input.value)||'').slice(0,160),placeholder:(input.placeholder||'').slice(0,120),ariaLabel:(el.getAttribute('aria-label')||'').slice(0,120)};});
      const text=(document.body?.innerText||'').replace(/\\n{3,}/g,'\\n\\n').slice(0,20000);return{url:location.href,title:document.title,text,elements,requiresUserAction:/(验证码|人机验证|短信验证|二次验证|captcha|verify you are human|two[- ]factor|\\b2fa\\b|cloudflare)/i.test(text),engine:'dom-fallback'};
    })()`,
  );
}

function recordManualVerification(requestId: string, required: boolean) {
  if (!required) return;
  const recording = recordings.get(requestId),
    recent = recording?.operations.at(-1);
  if (
    recording &&
    !(recent?.action === "manual" && Date.now() - recent.at < 30_000)
  )
    recordOperation(requestId, {
      at: Date.now(),
      action: "manual",
      text: "请在浏览器中完成人机验证、短信、Passkey 或双重验证；完成后任务会自动继续",
    });
}

async function rawBrowserSnapshot(requestId: string, view: WebContentsView) {
  let result: any;
  try {
    result = await accessibilitySnapshot(requestId, view);
  } catch (error) {
    result = await legacySnapshot(view);
    result.automationWarning = `CDP 自动化暂时不可用，已降级到 DOM：${error instanceof Error ? error.message : String(error)}`;
    const verification = detectHumanVerification({
      text: String(result.text || ""),
      title: String(result.title || ""),
      url: String(result.url || ""),
      elements: Array.isArray(result.elements) ? result.elements : [],
    });
    result.requiresUserAction = Boolean(verification);
    result.verification = verification;
  }
  return result;
}

function delayWithSignal(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("任务已取消"));
      return;
    }
    const timer = setTimeout(finish, ms);
    function finish() {
      signal?.removeEventListener("abort", abort);
      resolve();
    }
    function abort() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(new Error("任务已取消"));
    }
    signal?.addEventListener("abort", abort, { once: true });
  });
}

async function focusVerificationControl(
  requestId: string,
  view: WebContentsView,
) {
  const state = automationStates.get(requestId);
  if (!state) return;
  const pattern =
    /验证码|验证|滑块|captcha|recaptcha|hcaptcha|turnstile|verify|not a robot|passkey|security key|two[- ]factor|2fa|code/i;
  const target = [...state.refs.values()].find(
    (candidate) =>
      pattern.test(
        `${candidate.name} ${candidate.description || ""} ${candidate.value || ""}`,
      ) || candidate.role === "iframe",
  );
  if (!target) return;
  await resolveBrowserTarget(view, state, target).catch(() => undefined);
}

function verificationProgress(message: string, startedAt: number) {
  const seconds = Math.max(1, Math.round((Date.now() - startedAt) / 1_000));
  return `[等待人工验证] ${message}。已等待 ${seconds} 秒；请直接在右侧浏览器完成，页面验证通过后模型会自动继续。`;
}

export async function snapshotBrowser(
  requestId: string,
  options: {
    signal?: AbortSignal;
    onProgress?: (output: string) => void;
    waitForVerification?: boolean;
  } = {},
) {
  const view = page(requestId);
  let result = await rawBrowserSnapshot(requestId, view);
  const initialVerification = result.verification as
    BrowserVerification | undefined;
  if (!initialVerification || options.waitForVerification === false) {
    setBrowserVerification(requestId, initialVerification);
    recordManualVerification(requestId, Boolean(initialVerification));
    return result;
  }

  const startedAt = Date.now();
  let activeVerification = initialVerification;
  recordManualVerification(requestId, true);
  setBrowserVerification(requestId, activeVerification);
  await focusVerificationControl(requestId, view);
  options.onProgress?.(
    verificationProgress(activeVerification.message, startedAt),
  );

  try {
    while (true) {
      await delayWithSignal(1_200, options.signal);
      if (view.webContents.isDestroyed()) throw new Error("浏览器页面已关闭");
      options.onProgress?.(
        verificationProgress(activeVerification.message, startedAt),
      );
      try {
        result = await rawBrowserSnapshot(requestId, view);
      } catch (error) {
        if (options.signal?.aborted) throw new Error("任务已取消");
        if (view.webContents.isDestroyed()) throw error;
        continue;
      }
      const nextVerification = result.verification as
        BrowserVerification | undefined;
      if (!nextVerification) {
        setBrowserVerification(requestId);
        return {
          ...result,
          requiresUserAction: false,
          verification: undefined,
          verificationResolved: {
            kind: initialVerification.kind,
            waitedMs: Date.now() - startedAt,
            continuedAutomatically: true,
          },
        };
      }
      activeVerification = nextVerification;
      setBrowserVerification(requestId, activeVerification);
    }
  } finally {
    if (options.signal?.aborted || view.webContents.isDestroyed())
      setBrowserVerification(requestId);
  }
}
export async function inspectBrowserRef(requestId: string, ref: string) {
  const target = automationStates.get(requestId)?.refs.get(ref);
  if (target)
    return {
      text: target.sensitive ? "" : target.name || target.value || "",
      type: target.role,
      tag: target.role,
    };
  return executePage<{ text: string; type: string; tag: string } | null>(
    page(requestId),
    script(
      `ref=>{const el=document.querySelector('[data-kcode-ref="'+CSS.escape(ref)+'"]');if(!el)return null;return{text:(el.innerText||el.value||el.getAttribute('aria-label')||'').slice(0,200),type:el.type||'',tag:el.tagName.toLowerCase()};}`,
      ref,
    ),
  );
}

async function refreshAccessibilityTarget(
  view: WebContentsView,
  state: BrowserAutomationState,
  target: BrowserElementRef,
) {
  const debuggerSessionId = target.frameId
    ? state.iframeSessions.get(target.frameId)
    : undefined;
  const params =
    debuggerSessionId || !target.frameId ? {} : { frameId: target.frameId };
  const tree = await cdp(
    view,
    "Accessibility.getFullAXTree",
    params,
    debuggerSessionId,
  );
  const entries = extractAccessibilityFrame(
    Array.isArray(tree?.nodes) ? tree.nodes : [],
  ).entries.filter(
    (entry) => entry.role === target.role && entry.name === target.name,
  );
  const fresh = entries[target.nth];
  if (!fresh)
    throw new Error(
      `页面元素已变化，找不到 ${target.role}${target.name ? `“${target.name}”` : ""}，请重新获取快照`,
    );
  target.backendNodeId = fresh.backendNodeId;
  target.debuggerSessionId = debuggerSessionId;
  target.sensitive = fresh.sensitive;
  return target;
}

async function resolveBrowserTarget(
  view: WebContentsView,
  state: BrowserAutomationState,
  target: BrowserElementRef,
) {
  if (target.source === "coordinate") {
    if (!Number.isFinite(target.x) || !Number.isFinite(target.y))
      throw new Error("页面元素坐标已失效，请重新获取快照");
    return {
      target,
      x: target.x!,
      y: target.y!,
      debuggerSessionId: undefined,
    };
  }
  let current = target;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const debuggerSessionId = current.frameId
      ? state.iframeSessions.get(current.frameId) || current.debuggerSessionId
      : undefined;
    try {
      await cdp(
        view,
        "DOM.scrollIntoViewIfNeeded",
        { backendNodeId: current.backendNodeId },
        debuggerSessionId,
      ).catch(() => undefined);
      const result = await cdp(
        view,
        "DOM.getBoxModel",
        { backendNodeId: current.backendNodeId },
        debuggerSessionId,
      );
      const point = boxModelCenter(result?.model || {});
      current.debuggerSessionId = debuggerSessionId;
      return { target: current, ...point, debuggerSessionId };
    } catch (error) {
      if (attempt) throw error;
      current = await refreshAccessibilityTarget(view, state, current);
    }
  }
  throw new Error("页面元素已失效，请重新获取快照");
}

async function dispatchCdpClick(
  view: WebContentsView,
  x: number,
  y: number,
  debuggerSessionId?: string,
) {
  await cdp(
    view,
    "Input.dispatchMouseEvent",
    { type: "mouseMoved", x, y },
    debuggerSessionId,
  );
  await cdp(
    view,
    "Input.dispatchMouseEvent",
    { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1 },
    debuggerSessionId,
  );
  await cdp(
    view,
    "Input.dispatchMouseEvent",
    { type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1 },
    debuggerSessionId,
  );
}

export async function clickBrowser(requestId: string, ref: string) {
  const view = page(requestId);
  let hadCdpRef = false;
  try {
    const state = await ensureBrowserDebugger(requestId, view);
    const refTarget = state.refs.get(ref);
    if (refTarget) {
      hadCdpRef = true;
      const resolved = await resolveBrowserTarget(view, state, refTarget);
      await dispatchCdpClick(
        view,
        resolved.x,
        resolved.y,
        resolved.debuggerSessionId,
      );
      recordOperation(requestId, {
        at: Date.now(),
        action: "click",
        selector: resolved.target.selector,
      });
      await new Promise((resolve) => setTimeout(resolve, 600));
      return {
        clicked: true,
        text: resolved.target.sensitive ? "" : resolved.target.name,
        url: view.webContents.getURL(),
        trustedInput: true,
        engine: "cdp",
      };
    }
  } catch (error) {
    if (hadCdpRef) throw error;
  }
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
  try {
    await ensureBrowserDebugger(requestId, view);
    await dispatchCdpClick(view, target.x, target.y);
  } catch {
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
  }
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
    engine: "dom-fallback",
  };
}

async function typeWithCdp(
  view: WebContentsView,
  state: BrowserAutomationState,
  target: BrowserElementRef,
  text: string,
) {
  const resolved = await resolveBrowserTarget(view, state, target);
  if (resolved.target.source === "coordinate") {
    await dispatchCdpClick(view, resolved.x, resolved.y);
    await cdp(view, "Input.dispatchKeyEvent", {
      type: "rawKeyDown",
      key: "a",
      code: "KeyA",
      modifiers: 2,
      windowsVirtualKeyCode: 65,
      nativeVirtualKeyCode: 65,
    });
    await cdp(view, "Input.dispatchKeyEvent", {
      type: "keyUp",
      key: "a",
      code: "KeyA",
      modifiers: 2,
      windowsVirtualKeyCode: 65,
      nativeVirtualKeyCode: 65,
    });
  } else {
    await cdp(
      view,
      "DOM.focus",
      { backendNodeId: resolved.target.backendNodeId },
      resolved.debuggerSessionId,
    );
  }
  let objectId: string | undefined;
  let metadata: { sensitive?: boolean; tag?: string; type?: string } = {};
  if (resolved.target.backendNodeId) {
    const node = await cdp(
      view,
      "DOM.resolveNode",
      { backendNodeId: resolved.target.backendNodeId },
      resolved.debuggerSessionId,
    );
    objectId = node?.object?.objectId;
    if (objectId) {
      const prepared = await cdp(
        view,
        "Runtime.callFunctionOn",
        {
          objectId,
          functionDeclaration: `function(){
            this.focus({preventScroll:true});
            if(typeof this.select==='function') this.select();
            else if(this.isContentEditable){
              const selection=this.ownerDocument.getSelection(),range=this.ownerDocument.createRange();
              range.selectNodeContents(this);selection.removeAllRanges();selection.addRange(range);
            }
            return {sensitive:this instanceof HTMLInputElement&&this.type==='password',tag:this.tagName?.toLowerCase()||'',type:this.type||''};
          }`,
          returnByValue: true,
        },
        resolved.debuggerSessionId,
      );
      metadata = prepared?.result?.value || {};
    }
  }
  if (text) await cdp(view, "Input.insertText", { text });
  else {
    await cdp(view, "Input.dispatchKeyEvent", {
      type: "rawKeyDown",
      key: "Backspace",
      code: "Backspace",
      windowsVirtualKeyCode: 8,
      nativeVirtualKeyCode: 8,
    });
    await cdp(view, "Input.dispatchKeyEvent", {
      type: "keyUp",
      key: "Backspace",
      code: "Backspace",
      windowsVirtualKeyCode: 8,
      nativeVirtualKeyCode: 8,
    });
  }
  if (objectId)
    await cdp(
      view,
      "Runtime.callFunctionOn",
      {
        objectId,
        functionDeclaration:
          "function(){this.dispatchEvent(new Event('change',{bubbles:true}));}",
      },
      resolved.debuggerSessionId,
    ).catch(() => undefined);
  return {
    typed: true,
    ref: target.ref,
    characters: text.length,
    sensitive: Boolean(resolved.target.sensitive || metadata.sensitive),
    selector: resolved.target.selector,
    engine: "cdp",
  };
}

export async function typeBrowser(
  requestId: string,
  ref: string,
  text: string,
) {
  const view = page(requestId);
  let hadCdpRef = false;
  try {
    const state = await ensureBrowserDebugger(requestId, view);
    const target = state.refs.get(ref);
    if (target) {
      hadCdpRef = true;
      const result = await typeWithCdp(view, state, target, text);
      recordOperation(requestId, {
        at: Date.now(),
        action: "type",
        selector: result.selector,
        text: result.sensitive ? "" : text,
      });
      return result;
    }
  } catch (error) {
    if (hadCdpRef) throw error;
  }
  const result = await executePage<any>(
    view,
    script(
      `arg=>{const el=document.querySelector('[data-kcode-ref="'+CSS.escape(arg.ref)+'"]');if(!el)throw new Error('页面元素已失效，请重新获取快照');el.focus();const proto=el instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;const setter=Object.getOwnPropertyDescriptor(proto,'value')?.set;setter?.call(el,arg.text);if(!setter)el.textContent=arg.text;el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));const selector=el.id?'#'+CSS.escape(el.id):el.getAttribute('name')?el.tagName.toLowerCase()+'[name="'+CSS.escape(el.getAttribute('name'))+'"]':el.getAttribute('aria-label')?'[aria-label="'+CSS.escape(el.getAttribute('aria-label'))+'"]':el.getAttribute('placeholder')?'[placeholder="'+CSS.escape(el.getAttribute('placeholder'))+'"]':el.tagName.toLowerCase();return{typed:true,ref:arg.ref,characters:arg.text.length,sensitive:el.type==='password',selector};}`,
      { ref, text },
    ),
  );
  recordOperation(requestId, {
    at: Date.now(),
    action: "type",
    selector: result.selector,
    text: result.sensitive ? "" : text,
  });
  return { ...result, engine: "dom-fallback" };
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
export async function screenshotBrowser(
  requestId: string,
  input: BrowserScreenshotOptions = {},
) {
  const view = page(requestId),
    options = normalizeBrowserScreenshotOptions(input),
    dir = path.join(app.getPath("userData"), "browser-screenshots");
  const session = sessions.get(requestId)!;
  let temporarySurface = false;
  if (!session.attached) {
    if (!host || host.isDestroyed()) throw new Error("主窗口不可用");
    const hostBounds = host.getContentBounds();
    view.setBounds({
      x: hostBounds.width + 16,
      y: 0,
      width: options.width ?? 1280,
      height: options.height ?? 800,
    });
    host.contentView.addChildView(view);
    session.attached = true;
    temporarySurface = true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  try {
    let png: Buffer;
    if (!options.width && !options.fullPage) {
      const image = await browserOperationTimeout(
        view.webContents.capturePage(),
        "浏览器截图",
      );
      png = image.toPNG();
    } else {
      await browserOperationTimeout(
        ensureBrowserDebugger(requestId, view),
        "浏览器调试器连接",
      );
      let emulated = false;
      try {
        if (options.width && options.height) {
          await browserOperationTimeout(
            cdp(view, "Emulation.setDeviceMetricsOverride", {
              width: options.width,
              height: options.height,
              screenWidth: options.width,
              screenHeight: options.height,
              deviceScaleFactor: 1,
              mobile: Boolean(options.mobile),
            }),
            "浏览器视口设置",
          );
          emulated = true;
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
        const capture = await browserOperationTimeout(
          cdp(view, "Page.captureScreenshot", {
            format: "png",
            fromSurface: true,
            captureBeyondViewport: Boolean(options.fullPage),
          }),
          "浏览器截图",
        );
        png = Buffer.from(String(capture?.data || ""), "base64");
        if (!png.length) throw new Error("浏览器没有返回截图数据");
      } finally {
        if (emulated)
          await browserOperationTimeout(
            cdp(view, "Emulation.clearDeviceMetricsOverride"),
            "浏览器视口恢复",
            3_000,
          ).catch(() => undefined);
        forceBrowserRepaint(requestId);
      }
    }
    await mkdir(dir, { recursive: true });
    const file = path.join(dir, `${Date.now()}.png`);
    await writeFile(file, png);
    return {
      path: file,
      url: view.webContents.getURL(),
      width: options.width,
      height: options.height,
      mobile: options.mobile,
      fullPage: Boolean(options.fullPage),
    };
  } finally {
    if (temporarySurface) {
      try {
        host?.contentView.removeChildView(view);
      } catch {
        /* Host may close while a background screenshot is finishing. */
      }
      session.attached = false;
    }
  }
}
export function cleanupBrowsers(sessionIds: string[]) {
  for (const [sessionId, session] of sessions)
    if (
      sessionIds.includes(sessionId) ||
      sessionIds.includes(session.requestId)
    )
      destroySession(sessionId, false);
}

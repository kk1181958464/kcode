import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  shell,
  Menu,
  nativeImage,
  Notification,
  Tray,
} from "electron";
import {
  mkdir,
  readFile,
  readdir,
  stat,
  writeFile,
  rm,
} from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import type {
  AgentEvent,
  ContextFile,
  ContextSummaryRequest,
  ModelRequest,
  ProviderConfig,
} from "../src/types";
import type { RemoteTaskSnapshot } from "../src/remote-types";
import { RendererEventBatcher } from "./renderer-event-batcher";
import { LatestWriteQueue } from "./latest-write-queue";
import {
  cancelContextSummary,
  discoverModels,
  probeProvider,
  summarizeContext,
} from "./gateway";
import {
  cleanupAllBackgroundProcesses,
  cleanupAgentRecords,
  clearAgentSteering,
  clearAgentToolTraces,
  resolveApproval,
  resolveApprovalWithScope,
  runAgent,
  stopBackgroundProcessById,
  steerAgent,
  undoActivity,
} from "./agent";
import { approvalCache } from "./approval-cache";
import {
  initializeManagedProcessRegistry,
  managedProcessSnapshot,
  startManagedProcessSupervisor,
  stopManagedProcessSupervisor,
} from "./process-registry";
import { closeAllSshSessions } from "./ssh";
import { closeAllMysqlSessions } from "./mysql";
import { closeAllSqlServerSessions } from "./sqlserver";
import { closeAllMongoSessions } from "./mongodb";
import { resolveGitExecutable } from "./executables";
import {
  closeAllSubagents,
  releaseSubagentRecords,
  setSubagentEventSink,
  stopSubagentsForParent,
  subagentCheckpoints,
} from "./subagents";
import { listProviders, removeProvider, saveProvider } from "./store";
import {
  closeStateDatabase,
  compactStateDatabase,
  deleteTask,
  appendRuntimeEvents,
  interruptStaleRuntimeEvents,
  listTaskHeaders,
  loadActivityPayload,
  loadTaskActivitiesForRequests,
  loadTaskActivityPage,
  loadTask,
  loadTaskMessagePage,
  loadTaskWindow,
  loadState,
  loadRuntimeEvents,
  loadRuntimeTaskStatuses,
  saveTask,
  saveTaskOrder,
  saveState,
  stateStorageStats,
} from "./state-db";
import { RuntimeEventJournal } from "./runtime-event-journal";
import { agentRuntimeService } from "./runtime-service";
import { classifyRuntimeError } from "../src/runtime-errors";
import { installProcessLogging, logsDirectory, writeLog } from "./logger";
import {
  activateBrowserSession,
  backBrowser,
  closeBrowserPanel,
  forwardBrowser,
  hideBrowserPanel,
  listBrowserRecordings,
  navigateBrowser,
  recoverBrowserRecordingDrafts,
  reloadBrowser,
  removeBrowserRecording,
  setBrowserHost,
  setBrowserWidth,
} from "./browser";
import {
  browserWidthSchema,
  idSchema,
  localPathSchema,
  modelRequestSchema,
  optionalIdSchema,
  saveTaskOptionsSchema,
  stateKeySchema,
  steerContentSchema,
  taskItemPageOptionsSchema,
  taskRequestIdsSchema,
  runtimeEventPageOptionsSchema,
  sshRemoteConnectSchema,
  sshRemoteContentSchema,
  sshRemoteExpectedContentSchema,
  sshRemotePathSchema,
  urlSchema,
  workspacePathSchema,
} from "./ipc-validation";
import {
  adoptActiveSshRemote,
  connectSavedSshRemote,
  connectSshRemote,
  disconnectSshRemote,
  forgetSshRemoteProfile,
  listSshRemoteDirectory,
  listSshRemoteProfiles,
  readSshRemoteFile,
  sshRemoteState,
  writeSshRemoteFile,
} from "./ssh-remote";
import { resolveRevealPath } from "./reveal-path";
import { initializeAppUpdater, scheduleUpdateChecks } from "./app-updater";
import { createSkillStore, type ListedSkill } from "./skill-store";
import { clearAgentSkillCache, configureAgentSkills } from "./agent-skills";
import { networkFetch } from "./network";
import { existingDirectory } from "./dialog-path";
import {
  closeMcpServers,
  configureMcpServers,
  listMcpServerConfigs,
  listMcpTools,
  removeMcpServerConfig,
  saveMcpServerConfig,
  testMcpServer,
} from "./mcp";
import { countTextLines, parseGitNumstat } from "./git-workspace-state";
import {
  CONTEXT_FILE_DIALOG_EXTENSIONS,
  MAX_CONTEXT_FILES,
  MAX_CONTEXT_FILE_BYTES,
  MAX_CONTEXT_SOURCE_BYTES,
  MAX_CONTEXT_TOTAL_SOURCE_BYTES,
  MAX_CONTEXT_TOTAL_BYTES,
  isSupportedContextFile,
} from "../src/attachments";
import { parseContextFile } from "./document-parser";
import {
  closeRemoteConnection,
  initializeRemoteControl,
  remoteCommandResult,
  remoteLogin,
  remoteLogout,
  remoteRegister,
  remoteState,
  remoteShouldKeepRunning,
  setRemoteDeviceName,
  syncRemoteTaskEvent,
  syncRemoteTasks,
  uploadProviderVault,
  setRemoteEnabled,
} from "./remote-control";
import {
  isLegacyDevelopmentShortcut,
  windowsAppUserModelId,
} from "./windows-app-id";

const controllers = new Map<string, AbortController>();
// Turn raw upstream/proxy error codes into a readable message for the user.
// The original text still reaches the logs; only the surfaced message changes.
function friendlyModelError(raw: string): string {
  const text = raw.trim();
  const classification = classifyRuntimeError(text);
  if (/意外中断|未收到完整响应|工具调用参数不完整/i.test(text))
    return "模型响应流意外中断（上游可能断流），请重试或点击继续。若频繁出现，可压缩上下文或换模型/供应商。";
  if (/stream[_ ]?read[_ ]?error|stream error/i.test(text))
    return "与模型的连接中断（上游流读取失败），已自动重试仍未成功，请重试。";
  if (
    /ERR_INCOMPLETE_CHUNKED_ENCODING|ERR_CONTENT_LENGTH_MISMATCH|ERR_CONNECTION_(CLOSED|RESET|ABORTED|FAILED)|ERR_HTTP2_PROTOCOL_ERROR|ERR_QUIC_PROTOCOL_ERROR|ERR_EMPTY_RESPONSE|ERR_RESPONSE_HEADERS_TRUNCATED/i.test(
      text,
    )
  )
    return "上游中转在响应传输途中断开了连接（常见于不稳定的第三方中转），已自动重试仍未成功。可点击继续，或压缩上下文后重试；若频繁出现建议更换更稳定的供应商。";
  if (/overload|too many requests|429|rate.?limit/i.test(text))
    return "模型服务当前繁忙或达到频率限制，请稍后重试。";
  if (
    /upstream( request)? (failed|error)|upstream failed|proxy error/i.test(text)
  )
    return "上游模型网关请求失败，已自动重试仍未成功。可压缩上下文后重试，或换模型/供应商。";
  if (/50[0-9]|bad gateway|service unavailable|gateway time/i.test(text))
    return "模型服务暂时不可用（上游网关错误），请稍后重试。";
  if (
    /ECONNRESET|ECONNREFUSED|ETIMEDOUT|socket hang up|fetch failed|network|连接/i.test(
      text,
    )
  )
    return "网络连接异常，请检查网络后重试。";
  if (/等待响应超时|长时间没有新数据|超时/i.test(text)) return text;
  if (classification.kind === "authentication")
    return "模型供应商认证失败，请检查 API Key 或切换供应商。";
  if (classification.kind === "invalid_request")
    return "上游拒绝了请求参数，请检查模型能力、图片附件和消息格式。";
  return text;
}
installProcessLogging();
const appUserModelId = windowsAppUserModelId(app.isPackaged);
app.setName("KCode");
if (process.platform === "win32") app.setAppUserModelId(appUserModelId);
let mainWindow: BrowserWindow | undefined;
let tray: Tray | undefined;
let skillStore: ReturnType<typeof createSkillStore> | undefined;
let unreadTasks = 0;
let quitting = false;
let rendererReady = false;
const pendingRemoteCommands: Parameters<
  NonNullable<Parameters<typeof initializeRemoteControl>[0]>["onCommand"]
>[0][] = [];
const svgImage = (svg: string) =>
  nativeImage.createFromDataURL(
    `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`,
  );
const iconFileName = "80f2649b913c028210842f9ffd752179.png";
const iconPath = () =>
  [
    path.join(process.resourcesPath, iconFileName),
    path.join(app.getAppPath(), iconFileName),
    path.resolve(__dirname, "../../", iconFileName),
  ].find(existsSync);
const windowIcon = () => appIcon(256);
function configureWindowsTaskbar(win: BrowserWindow, icon = windowIcon()) {
  if (process.platform !== "win32") return;
  if (!icon.isEmpty()) win.setIcon(icon);
  // The current taskbar icon comes from the native image above. The ICO is
  // only needed by the installer and should not overwrite a valid window icon
  // through the relaunch metadata.
  win.setAppDetails({ appId: appUserModelId });
}
async function removeLegacyDevelopmentShortcut() {
  if (process.platform !== "win32" || !app.isPackaged) return;
  const shortcutPath = path.join(
    app.getPath("appData"),
    "Microsoft",
    "Windows",
    "Start Menu",
    "Programs",
    "Electron.lnk",
  );
  if (!existsSync(shortcutPath)) return;
  try {
    const shortcut = shell.readShortcutLink(shortcutPath);
    if (!isLegacyDevelopmentShortcut(shortcut)) return;
    await rm(shortcutPath, { force: true });
    writeLog("info", "windows.legacy-shortcut.removed", { shortcutPath });
  } catch (error) {
    writeLog("warn", "windows.legacy-shortcut.remove-failed", error);
  }
}
async function repairWindowsShortcuts() {
  if (process.platform !== "win32" || !app.isPackaged) return;
  const icon = path.join(process.resourcesPath, "icon.ico");
  if (!existsSync(icon)) return;
  const shortcutPaths = [
    path.join(
      app.getPath("appData"),
      "Microsoft",
      "Windows",
      "Start Menu",
      "Programs",
      "KCode.lnk",
    ),
    path.join(app.getPath("desktop"), "KCode.lnk"),
  ];
  await Promise.all(
    shortcutPaths.map(async (shortcutPath) => {
      if (!existsSync(shortcutPath)) return;
      try {
        const shortcut = shell.readShortcutLink(shortcutPath);
        if (
          !shortcut.target ||
          path.resolve(shortcut.target).toLowerCase() !==
            path.resolve(process.execPath).toLowerCase()
        )
          return;
        const updated = shell.writeShortcutLink(shortcutPath, "update", {
          target: shortcut.target,
          icon,
          iconIndex: 0,
          appUserModelId,
        });
        if (updated)
          writeLog("info", "windows.shortcut.icon-repaired", {
            shortcutPath,
          });
      } catch (error) {
        writeLog("warn", "windows.shortcut.icon-repair-failed", {
          shortcutPath,
          error,
        });
      }
    }),
  );
}
const appIcon = (size = 32) => {
  const file = iconPath();
  const image = file
    ? nativeImage.createFromPath(file)
    : nativeImage.createEmpty();
  if (image.isEmpty())
    return svgImage(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}"><rect width="${size}" height="${size}" rx="6" fill="#242b26"/><text x="50%" y="68%" text-anchor="middle" font-family="Segoe UI,Arial" font-size="${Math.round(size * 0.5)}" font-weight="700" fill="white">K</text></svg>`,
    );
  const source = image.getSize();
  const cropSize = Math.round(Math.min(source.width, source.height) * 0.527);
  const cropped = image.crop({
    x: Math.round(source.width * 0.238),
    y: Math.round(source.height * 0.17),
    width: cropSize,
    height: cropSize,
  });
  return cropped.resize({ width: size, height: size, quality: "best" });
};
const badgeIcon = (count: number) =>
  svgImage(
    `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><circle cx="8" cy="8" r="7" fill="#c9362b" stroke="white" stroke-width="2"/><text x="8" y="11" text-anchor="middle" font-family="Segoe UI,Arial" font-size="8" font-weight="700" fill="white">${count > 9 ? "9+" : count}</text></svg>`,
  );
function updateUnread(count: number) {
  unreadTasks = Math.max(0, count);
  tray?.setImage(appIcon(32));
  tray?.setToolTip(
    unreadTasks ? `KCode · ${unreadTasks} 个任务已完成` : "KCode",
  );
  mainWindow?.setOverlayIcon(
    unreadTasks ? badgeIcon(unreadTasks) : null,
    unreadTasks ? `${unreadTasks} 个任务已完成` : "",
  );
}
function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) mainWindow = createWindow();
  mainWindow.show();
  mainWindow.restore();
  mainWindow.focus();
  updateUnread(0);
}
function publicSkill(skill: ListedSkill) {
  return {
    id: skill.id,
    name: skill.name,
    description: skill.description ?? "此 Skill 暂无说明。",
    version: skill.version ?? "0.0.0",
    author: skill.author ?? "Community",
    license: skill.license,
    repository: skill.repository,
    categories: skill.categories,
    verified: skill.verified,
    hasScripts: skill.hasScripts,
    source: skill.bundled
      ? ("bundled" as const)
      : skill.installed
        ? ("user" as const)
        : ("registry" as const),
    installed: skill.installed,
    enabled: skill.enabled,
  };
}
async function listPublicSkills(refresh = false) {
  if (!skillStore) throw new Error("Skill 商店尚未初始化");
  if (refresh) skillStore.refresh();
  return (await skillStore.list(refresh)).map(publicSkill);
}
function notifyTask(result: "done" | "error", message?: string) {
  if (mainWindow?.isFocused() && !mainWindow.isMinimized()) return;
  updateUnread(unreadTasks + 1);
  if (Notification.isSupported()) {
    const notification = new Notification({
      title: result === "done" ? "KCode 任务已完成" : "KCode 任务执行失败",
      body:
        result === "done"
          ? "模型已经完成任务，点击查看结果。"
          : message || "任务执行失败，点击查看详情。",
      icon: appIcon(),
      silent: false,
    });
    notification.on("click", showMainWindow);
    notification.show();
  }
}
function notifyBrowserVerification(details: {
  sessionId: string;
  message: string;
}) {
  updateUnread(unreadTasks + 1);
  if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isFocused())
    mainWindow.flashFrame(true);
  if (!Notification.isSupported()) return;
  const notification = new Notification({
    title: "KCode 等待网页验证",
    body: `${details.message}。完成后任务会自动继续。`,
    icon: appIcon(),
    silent: false,
  });
  notification.on("click", () => {
    showMainWindow();
    activateBrowserSession(details.sessionId);
  });
  notification.show();
}
// Reject any id that could escape the checkpoints dir. Legit ids are
// randomUUID() or request ids ([A-Za-z0-9_-]); path separators / dots are not.
const checkpointPath = (id: string) => {
  if (!/^[A-Za-z0-9_-]+$/.test(id))
    throw new Error(`Invalid checkpoint id: ${id}`);
  return path.join(app.getPath("userData"), "checkpoints", `${id}.json`);
};
async function writeCheckpoint(id: string, value: unknown) {
  await mkdir(path.dirname(checkpointPath(id)), { recursive: true });
  await writeFile(checkpointPath(id), JSON.stringify(value), "utf8");
}

function compactCheckpointEvent(item: AgentEvent) {
  if (item.type !== "activity") return item;
  return {
    ...item,
    activity: {
      ...item.activity,
      output: item.activity.output?.slice(-12_000),
      diff: item.activity.diff?.slice(-12_000),
    },
  };
}
async function removeCheckpoint(id: string) {
  let target: string;
  try {
    target = checkpointPath(id);
  } catch {
    return; // invalid id → no such checkpoint, nothing to remove
  }
  await rm(target, { force: true });
}
async function listCheckpoints() {
  try {
    const dir = path.dirname(checkpointPath("x"));
    return await Promise.all(
      (await readdir(dir))
        .filter((name) => name.endsWith(".json"))
        .map(async (name) =>
          JSON.parse(await readFile(path.join(dir, name), "utf8")),
        ),
    );
  } catch {
    return [];
  }
}
function createWindow() {
  rendererReady = false;
  const icon = windowIcon();
  const win = new BrowserWindow({
    width: 1420,
    height: 900,
    minWidth: 960,
    minHeight: 640,
    frame: false,
    autoHideMenuBar: true,
    backgroundColor: "#f6f7f9",
    icon,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  configureWindowsTaskbar(win, icon);
  win.once("ready-to-show", () => configureWindowsTaskbar(win, icon));
  mainWindow = win;
  win.on("close", (event) => {
    if (!quitting && remoteShouldKeepRunning()) {
      event.preventDefault();
      win.hide();
    }
  });
  setBrowserHost(win, {
    onState: (state) => {
      if (!win.isDestroyed()) win.webContents.send("browser:state", state);
    },
    onUserClose: (requestId) => {
      controllers.get(requestId)?.abort();
    },
    onVerificationRequired: notifyBrowserVerification,
  });
  win.on("focus", () => updateUnread(0));
  win.on("closed", () => {
    if (mainWindow === win) mainWindow = undefined;
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event, url) => {
    if (url !== win.webContents.getURL()) event.preventDefault();
  });
  win.webContents.on("render-process-gone", (_event, details) =>
    writeLog("error", "renderer.gone", details),
  );
  win.webContents.on(
    "did-fail-load",
    (_event, errorCode, errorDescription, validatedURL) =>
      writeLog("error", "renderer.load.failed", {
        errorCode,
        errorDescription,
        validatedURL,
      }),
  );
  win.webContents.on("unresponsive", () =>
    writeLog("warn", "renderer.unresponsive", {
      url: win.webContents.getURL(),
    }),
  );
  if (process.env.VITE_DEV_SERVER_URL)
    win.loadURL(process.env.VITE_DEV_SERVER_URL);
  else if (!app.isPackaged) win.loadURL("http://127.0.0.1:5173");
  else win.loadFile(path.join(__dirname, "../../dist/index.html"));
  return win;
}

app.whenReady().then(async () => {
  approvalCache.load();
  configureMcpServers(loadState("mcpServers") ?? []);
  const interruptedRuns = interruptStaleRuntimeEvents();
  if (interruptedRuns)
    writeLog("warn", "runtime.stale-runs-interrupted", {
      count: interruptedRuns,
    });
  const recoveredProcesses = await initializeManagedProcessRegistry(
    app.getPath("userData"),
  );
  startManagedProcessSupervisor();
  if (recoveredProcesses)
    writeLog("warn", "process.recovered", { count: recoveredProcesses });
  await removeLegacyDevelopmentShortcut();
  await repairWindowsShortcuts();
  const bundledSkillsRoot = app.isPackaged
    ? path.join(process.resourcesPath, "skills")
    : path.join(app.getAppPath(), "skills");
  const userSkillsRoot = path.join(app.getPath("userData"), "skills");
  const skillStateFile = path.join(
    app.getPath("userData"),
    "skill-store-state.json",
  );
  skillStore = createSkillStore({
    bundledSkillsRoot,
    bundledRegistryPath: path.join(bundledSkillsRoot, "registry.json"),
    userSkillsRoot,
    stateFile: skillStateFile,
    fetchImpl: networkFetch,
  });
  configureAgentSkills({ userSkillsRoot, stateFile: skillStateFile });
  if (process.platform === "darwin") app.dock?.setIcon(appIcon(256));
  void rm(path.join(app.getPath("userData"), "ssh-known-hosts.json"), {
    force: true,
  });
  void rm(path.join(app.getPath("userData"), "credentials.json"), {
    force: true,
  });
  void recoverBrowserRecordingDrafts().catch((error) =>
    writeLog("error", "recording.recovery.failed", error),
  );
  initializeAppUpdater(() => {
    for (const controller of controllers.values()) controller.abort();
    closeStateDatabase();
  });
  tray = new Tray(appIcon(32));
  tray.setToolTip("KCode");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "打开 KCode", click: showMainWindow },
      { type: "separator" },
      { label: "退出", click: () => app.quit() },
    ]),
  );
  tray.on("click", showMainWindow);
  ipcMain.handle("remote:state", () => remoteState());
  ipcMain.handle("remote:register", (_e, username: string, password: string) =>
    remoteRegister(username, password),
  );
  ipcMain.handle("remote:login", (_e, username: string, password: string) =>
    remoteLogin(username, password),
  );
  ipcMain.handle("remote:logout", () => remoteLogout());
  ipcMain.handle("remote:set-enabled", (_e, enabled: boolean) =>
    setRemoteEnabled(Boolean(enabled)),
  );
  ipcMain.handle("remote:set-device-name", (_e, name: string) =>
    setRemoteDeviceName(name),
  );
  ipcMain.handle("remote:sync-tasks", (_e, tasks: RemoteTaskSnapshot[]) =>
    syncRemoteTasks(tasks),
  );
  ipcMain.handle("remote:sync-task-event", (_e, event) =>
    syncRemoteTaskEvent(event),
  );
  ipcMain.handle(
    "remote:command-result",
    (_e, id: string, ok: boolean, error?: string) =>
      remoteCommandResult(id, Boolean(ok), error),
  );
  ipcMain.handle("remote:ready", (event) => {
    rendererReady = true;
    const target = BrowserWindow.fromWebContents(event.sender);
    for (const command of pendingRemoteCommands.splice(0))
      target?.webContents.send("remote:command", command);
  });
  ipcMain.handle("providers:list", listProviders);
  ipcMain.handle("state:load", (_e, key: string) =>
    loadState(stateKeySchema.parse(key)),
  );
  ipcMain.handle("state:save", (_e, key: string, value: unknown) =>
    saveState(stateKeySchema.parse(key), value),
  );
  ipcMain.handle("state:stats", () => stateStorageStats());
  ipcMain.handle("state:compact", () => compactStateDatabase());
  ipcMain.handle("state:task-headers", () => listTaskHeaders());
  ipcMain.handle("state:load-task", (_e, id: string) =>
    loadTask(idSchema.parse(id)),
  );
  ipcMain.handle("state:load-task-window", (_e, id: string) =>
    loadTaskWindow(idSchema.parse(id)),
  );
  ipcMain.handle(
    "state:task-message-page",
    (_e, id: string, options: unknown) =>
      loadTaskMessagePage(
        idSchema.parse(id),
        taskItemPageOptionsSchema.parse(options ?? {}),
      ),
  );
  ipcMain.handle(
    "state:task-activity-page",
    (_e, id: string, options: unknown) =>
      loadTaskActivityPage(
        idSchema.parse(id),
        taskItemPageOptionsSchema.parse(options ?? {}),
      ),
  );
  ipcMain.handle(
    "state:runtime-events",
    (_e, id: string, options: unknown) =>
      loadRuntimeEvents(
        idSchema.parse(id),
        runtimeEventPageOptionsSchema.parse(options ?? {}),
      ),
  );
  ipcMain.handle("state:runtime-statuses", () => loadRuntimeTaskStatuses());
  ipcMain.handle(
    "state:task-activities-for-requests",
    (_e, id: string, requestIds: unknown) =>
      loadTaskActivitiesForRequests(
        idSchema.parse(id),
        taskRequestIdsSchema.parse(requestIds),
      ),
  );
  ipcMain.handle("state:load-activity-payload", (_e, activityId: string) =>
    loadActivityPayload(idSchema.parse(activityId)),
  );
  ipcMain.handle(
    "state:save-task",
    (_e, id: string, value: unknown, options: unknown) =>
      saveTask(
        idSchema.parse(id),
        value,
        saveTaskOptionsSchema.parse(options ?? {}),
      ),
  );
  ipcMain.handle("state:save-task-order", (_e, ids: string[]) =>
    saveTaskOrder(ids.map((id) => idSchema.parse(id))),
  );
  ipcMain.handle("state:delete-task", (_e, id: string) =>
    deleteTask(idSchema.parse(id)),
  );
  ipcMain.on("log:renderer-error", (_e, detail) =>
    writeLog("error", "renderer.error", detail),
  );
  ipcMain.handle("log:reveal", () => shell.openPath(logsDirectory()));
  ipcMain.handle("shell:open-external", (_e, url: string) => {
    const target = urlSchema.parse(url);
    if (!/^https?:\/\//i.test(target))
      throw new Error("只能打开 http/https 链接");
    return shell.openExternal(target);
  });
  ipcMain.handle(
    "shell:reveal-path",
    async (_e, rawPath: string, rawWorkspacePath: string) => {
      const target = resolveRevealPath(
        localPathSchema.parse(rawPath),
        workspacePathSchema.parse(rawWorkspacePath),
      );
      const info = await stat(target).catch(() => undefined);
      if (!info) throw new Error("文件或文件夹不存在");
      if (info.isFile()) {
        shell.showItemInFolder(target);
        return { path: target, kind: "file" as const };
      }
      if (info.isDirectory()) {
        const error = await shell.openPath(target);
        if (error) throw new Error(error);
        return { path: target, kind: "directory" as const };
      }
      throw new Error("目标不是普通文件或文件夹");
    },
  );
  ipcMain.handle("window:minimize", (event) =>
    BrowserWindow.fromWebContents(event.sender)?.minimize(),
  );
  ipcMain.handle("window:toggle-maximize", (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return false;
    win.isMaximized() ? win.unmaximize() : win.maximize();
    return win.isMaximized();
  });
  ipcMain.handle("window:close", (event) =>
    BrowserWindow.fromWebContents(event.sender)?.close(),
  );
  ipcMain.handle(
    "providers:save",
    async (_e, provider: ProviderConfig, key?: string) => {
      const result = await saveProvider(provider, key);
      void uploadProviderVault().catch((error) =>
        writeLog("warn", "remote.provider-sync.failed", error),
      );
      return result;
    },
  );
  ipcMain.handle(
    "chat:undo",
    (_e, workspacePath: string, activityId: string, force?: boolean) =>
      undoActivity(workspacePath, activityId, Boolean(force)),
  );
  ipcMain.handle("providers:remove", async (_e, id: string) => {
    const result = await removeProvider(id);
    void uploadProviderVault().catch((error) =>
      writeLog("warn", "remote.provider-sync.failed", error),
    );
    return result;
  });
  ipcMain.handle("providers:discover", (_e, id: string) => discoverModels(id));
  ipcMain.handle("providers:probe", (_e, id: string) => probeProvider(id));
  ipcMain.handle("skills:list", (_e, refresh?: boolean) =>
    listPublicSkills(Boolean(refresh)),
  );
  ipcMain.handle("skills:install", async (_e, id: string) => {
    if (!skillStore) throw new Error("Skill 商店尚未初始化");
    await skillStore.install(id);
    clearAgentSkillCache();
    return listPublicSkills();
  });
  ipcMain.handle("skills:import-local", async (event) => {
    if (!skillStore) throw new Error("Skill 商店尚未初始化");
    const owner = BrowserWindow.fromWebContents(event.sender) ?? mainWindow;
    const result = owner
      ? await dialog.showOpenDialog(owner, {
          title: "选择包含 SKILL.md 的 Skill 目录",
          properties: ["openDirectory"],
        })
      : await dialog.showOpenDialog({
          title: "选择包含 SKILL.md 的 Skill 目录",
          properties: ["openDirectory"],
        });
    if (result.canceled || !result.filePaths[0]) return listPublicSkills();
    await skillStore.importDirectory(result.filePaths[0]);
    clearAgentSkillCache();
    return listPublicSkills();
  });
  ipcMain.handle("skills:reveal-folder", async () => {
    if (!skillStore) throw new Error("Skill 商店尚未初始化");
    await mkdir(userSkillsRoot, { recursive: true });
    const error = await shell.openPath(userSkillsRoot);
    if (error) throw new Error(error);
  });
  ipcMain.handle("skills:uninstall", async (_e, id: string) => {
    if (!skillStore) throw new Error("Skill 商店尚未初始化");
    await skillStore.uninstall(id);
    clearAgentSkillCache();
    return listPublicSkills();
  });
  ipcMain.handle(
    "skills:set-enabled",
    async (_e, id: string, enabled: boolean) => {
      if (!skillStore) throw new Error("Skill 商店尚未初始化");
      enabled ? await skillStore.enable(id) : await skillStore.disable(id);
      clearAgentSkillCache();
      return listPublicSkills();
    },
  );
  ipcMain.handle("mcp:list", () => listMcpServerConfigs());
  ipcMain.handle("mcp:save", async (_e, server: unknown) => {
    const next = saveMcpServerConfig(server as any);
    await saveState("mcpServers", next);
    return next;
  });
  ipcMain.handle("mcp:remove", async (_e, id: string) => {
    const next = removeMcpServerConfig(idSchema.parse(id));
    await saveState("mcpServers", next);
    return next;
  });
  ipcMain.handle("mcp:test", (_e, id: string) =>
    testMcpServer(idSchema.parse(id)),
  );
  ipcMain.handle("mcp:tools", (_e, id: string) =>
    listMcpTools(idSchema.parse(id)),
  );
  ipcMain.handle("runtime:processes", () => managedProcessSnapshot());
  ipcMain.handle("runtime:statuses", (_e, rawTaskId?: unknown) =>
    agentRuntimeService.list(
      rawTaskId === undefined ? undefined : idSchema.parse(rawTaskId),
    ),
  );
  ipcMain.handle("runtime:stop-process", async (_e, id: string) => {
    await stopBackgroundProcessById(idSchema.parse(id));
    return managedProcessSnapshot();
  });
  ipcMain.handle("runtime:stop-all", async () => {
    await cleanupAllBackgroundProcesses();
    return managedProcessSnapshot();
  });
  ipcMain.handle("browser:activate", (_e, sessionId?: string) =>
    activateBrowserSession(optionalIdSchema.parse(sessionId)),
  );
  ipcMain.handle("browser:close", (_e, sessionId?: string) =>
    closeBrowserPanel(optionalIdSchema.parse(sessionId), true),
  );
  ipcMain.handle("browser:hide", (_e, sessionId?: string) =>
    hideBrowserPanel(optionalIdSchema.parse(sessionId)),
  );
  ipcMain.handle(
    "browser:navigate",
    (_e, sessionId: string | undefined, url: string) =>
      navigateBrowser(optionalIdSchema.parse(sessionId), urlSchema.parse(url)),
  );
  ipcMain.handle("browser:back", (_e, sessionId?: string) =>
    backBrowser(optionalIdSchema.parse(sessionId)),
  );
  ipcMain.handle("browser:forward", (_e, sessionId?: string) =>
    forwardBrowser(optionalIdSchema.parse(sessionId)),
  );
  ipcMain.handle("browser:reload", (_e, sessionId?: string) =>
    reloadBrowser(optionalIdSchema.parse(sessionId)),
  );
  ipcMain.handle("browser:set-width", (_e, width: number) =>
    setBrowserWidth(browserWidthSchema.parse(width)),
  );
  ipcMain.handle("browser:recordings", () => listBrowserRecordings());
  ipcMain.handle("browser:remove-recording", (_e, id: string) =>
    removeBrowserRecording(idSchema.parse(id)),
  );
  ipcMain.handle("browser:reveal-recording", async (_e, id: string) => {
    const item = (await listBrowserRecordings()).find(
      (recording) => recording.id === id,
    );
    if (!item) throw new Error("录制记录不存在");
    shell.showItemInFolder(item.jsonPath);
  });
  ipcMain.handle("chat:summarize", (_e, request: ContextSummaryRequest) =>
    summarizeContext(request),
  );
  ipcMain.handle("ssh-remote:profiles", () => listSshRemoteProfiles());
  ipcMain.handle("ssh-remote:connect", (_e, input: unknown) =>
    connectSshRemote(sshRemoteConnectSchema.parse(input)),
  );
  ipcMain.handle("ssh-remote:adopt", (_e, taskId: string, rootPath: string) =>
    adoptActiveSshRemote(
      idSchema.parse(taskId),
      sshRemotePathSchema.parse(rootPath),
    ),
  );
  ipcMain.handle(
    "ssh-remote:connect-saved",
    (_e, taskId: string, profileId: string) =>
      connectSavedSshRemote(idSchema.parse(taskId), idSchema.parse(profileId)),
  );
  ipcMain.handle("ssh-remote:state", (_e, taskId: string, profileId?: string) =>
    sshRemoteState(
      idSchema.parse(taskId),
      profileId ? idSchema.parse(profileId) : undefined,
    ),
  );
  ipcMain.handle("ssh-remote:disconnect", (_e, taskId: string) =>
    disconnectSshRemote(idSchema.parse(taskId)),
  );
  ipcMain.handle("ssh-remote:forget", (_e, profileId: string) =>
    forgetSshRemoteProfile(idSchema.parse(profileId)),
  );
  ipcMain.handle(
    "ssh-remote:list",
    (_e, taskId: string, profileId: string, remotePath?: string) =>
      listSshRemoteDirectory(
        idSchema.parse(taskId),
        idSchema.parse(profileId),
        remotePath ? sshRemotePathSchema.parse(remotePath) : undefined,
      ),
  );
  ipcMain.handle(
    "ssh-remote:read",
    (_e, taskId: string, profileId: string, remotePath: string) =>
      readSshRemoteFile(
        idSchema.parse(taskId),
        idSchema.parse(profileId),
        sshRemotePathSchema.parse(remotePath),
      ),
  );
  ipcMain.handle(
    "ssh-remote:write",
    (
      _e,
      taskId: string,
      profileId: string,
      remotePath: string,
      content: string,
      expectedContent?: string | null,
    ) =>
      writeSshRemoteFile(
        idSchema.parse(taskId),
        idSchema.parse(profileId),
        sshRemotePathSchema.parse(remotePath),
        sshRemoteContentSchema.parse(content),
        sshRemoteExpectedContentSchema.parse(expectedContent),
      ),
  );
  ipcMain.handle("ssh-remote:pick-private-key", async (event) => {
    const owner = BrowserWindow.fromWebContents(event.sender);
    if (!owner || owner.isDestroyed())
      throw new Error("无法确认 SSH 私钥选择窗口");
    const result = await dialog.showOpenDialog(owner, {
      title: "选择 SSH 私钥",
      properties: ["openFile"],
      filters: [
        { name: "SSH 私钥", extensions: ["pem", "key", "ppk"] },
        { name: "所有文件", extensions: ["*"] },
      ],
    });
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });
  ipcMain.handle("chat:cancel-summary", (_e, taskId: string) =>
    cancelContextSummary(taskId),
  );
  ipcMain.handle("chat:checkpoints", () => listCheckpoints());
  ipcMain.handle("chat:remove-checkpoint", (_e, id: string) =>
    removeCheckpoint(id),
  );
  ipcMain.handle("workspace:pick-folder", async (event) => {
    const owner = BrowserWindow.fromWebContents(event.sender);
    if (!owner || owner.isDestroyed())
      throw new Error("无法确认文件夹选择窗口");
    const result = await dialog.showOpenDialog(owner, {
      title: "选择任务文件夹",
      properties: ["openDirectory", "createDirectory"],
    });
    if (result.canceled || !result.filePaths[0]) return null;
    const folderPath = path.resolve(result.filePaths[0]);
    return { name: path.basename(folderPath), path: folderPath };
  });
  ipcMain.handle(
    "workspace:show-folder-menu",
    async (event, workspacePath: string) => {
      const owner = BrowserWindow.fromWebContents(event.sender);
      if (!owner || owner.isDestroyed()) throw new Error("无法确认工作区窗口");
      const root = path.resolve(workspacePathSchema.parse(workspacePath));
      const info = await stat(root);
      if (!info.isDirectory()) throw new Error("工作区不是有效目录");
      Menu.buildFromTemplate([
        {
          label: "在文件资源管理器中打开",
          click: () => {
            void shell.openPath(root).then((error) => {
              if (error)
                void dialog.showMessageBox(owner, {
                  type: "error",
                  title: "无法打开文件夹",
                  message: "无法在文件资源管理器中打开工作区",
                  detail: error,
                });
            });
          },
        },
      ]).popup({ window: owner });
    },
  );
  const runGit = (root: string, args: string[]) =>
    new Promise<{ code: number; output: string }>((resolve) => {
      const child = spawn(resolveGitExecutable(), args, {
        cwd: root,
        windowsHide: true,
        shell: false,
      });
      let output = "";
      child.stdout.on("data", (chunk) => {
        output = (output + chunk.toString("utf8")).slice(-200_000);
      });
      child.stderr.on("data", (chunk) => {
        output = (output + chunk.toString("utf8")).slice(-200_000);
      });
      child.on("error", (error) =>
        resolve({ code: -1, output: error.message }),
      );
      child.on("close", (code) => resolve({ code: code ?? -1, output }));
    });
  const resolveWorkspaceFile = (root: string, rawPath: string) => {
    const value = workspacePathSchema.parse(rawPath);
    const target = path.resolve(
      path.isAbsolute(value) ? value : path.join(root, value),
    );
    const relative = path.relative(root, target);
    if (
      !relative ||
      relative === ".." ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)
    )
      throw new Error("文件路径必须位于当前工作区内");
    return { target, relative: relative.replaceAll("\\", "/") };
  };
  const resolveWorkspaceTarget = (
    rawRoot: string,
    rawPath?: string,
    allowRoot = false,
  ) => {
    const root = path.resolve(workspacePathSchema.parse(rawRoot));
    const target = rawPath
      ? path.resolve(
          path.isAbsolute(rawPath) ? rawPath : path.join(root, rawPath),
        )
      : root;
    const relative = path.relative(root, target);
    if (
      (!allowRoot && !relative) ||
      relative === ".." ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)
    )
      throw new Error("文件路径必须位于当前工作区内");
    return { root, target, relative: relative.replaceAll("\\", "/") };
  };
  ipcMain.handle(
    "workspace:list",
    async (_event, rawRoot: string, rawDirectory?: string) => {
      const { target } = resolveWorkspaceTarget(rawRoot, rawDirectory, true);
      const info = await stat(target);
      if (!info.isDirectory()) throw new Error("目标不是文件夹");
      const hidden = new Set([
        ".git",
        "node_modules",
        "dist",
        "dist-electron",
        "release",
        ".next",
        ".cache",
      ]);
      const entries = (await readdir(target, { withFileTypes: true }))
        .filter((entry) => !hidden.has(entry.name))
        .slice(0, 2_000);
      return Promise.all(
        entries.map(async (entry) => {
          const fullPath = path.join(target, entry.name);
          const item = await stat(fullPath);
          return {
            name: entry.name,
            path: fullPath,
            type: entry.isDirectory()
              ? ("directory" as const)
              : ("file" as const),
            size: item.size,
            modifiedAt: item.mtimeMs,
          };
        }),
      ).then((items) =>
        items.sort((left, right) =>
          left.type === right.type
            ? left.name.localeCompare(right.name)
            : left.type === "directory"
              ? -1
              : 1,
        ),
      );
    },
  );
  ipcMain.handle(
    "workspace:read",
    async (_event, rawRoot: string, rawPath: string) => {
      const { target } = resolveWorkspaceTarget(rawRoot, rawPath);
      const info = await stat(target);
      if (!info.isFile()) throw new Error("目标不是普通文件");
      if (info.size > 5 * 1024 * 1024)
        throw new Error("文件超过 5 MB，暂不在编辑器中打开");
      const buffer = await readFile(target);
      if (buffer.includes(0))
        throw new Error("二进制文件不能在文本编辑器中打开");
      return {
        path: target,
        content: buffer.toString("utf8"),
        size: info.size,
        modifiedAt: info.mtimeMs,
      };
    },
  );
  ipcMain.handle(
    "workspace:write",
    async (
      _event,
      rawRoot: string,
      rawPath: string,
      content: string,
      expectedContent?: string | null,
    ) => {
      const { target } = resolveWorkspaceTarget(rawRoot, rawPath);
      if (typeof content !== "string" || content.length > 5 * 1024 * 1024)
        throw new Error("编辑内容超过 5 MB");
      let existing: string | undefined;
      try {
        existing = await readFile(target, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (expectedContent === null && existing !== undefined)
        throw new Error("文件已经存在");
      if (typeof expectedContent === "string" && existing !== expectedContent)
        throw new Error("文件已被其他程序修改，请重新打开后再保存");
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, content, "utf8");
      const info = await stat(target);
      return {
        path: target,
        content,
        size: info.size,
        modifiedAt: info.mtimeMs,
      };
    },
  );
  const untrackedDiff = (relative: string, text: string) => {
    const lines = text.replace(/\r\n?/g, "\n").split("\n");
    if (lines.at(-1) === "") lines.pop();
    const body = lines.map((line) => `+${line}`).join("\n");
    return [
      `diff --git a/${relative} b/${relative}`,
      "new file mode 100644",
      "--- /dev/null",
      `+++ b/${relative}`,
      `@@ -0,0 +1,${lines.length} @@`,
      body,
    ]
      .filter(Boolean)
      .join("\n")
      .slice(0, 200_000);
  };
  ipcMain.handle(
    "workspace:git-state",
    async (_event, workspacePath: string, includeDiff = false) => {
      const root = path.resolve(workspacePathSchema.parse(workspacePath));
      const info = await stat(root);
      if (!info.isDirectory()) throw new Error("工作区不是有效目录");
      const git = (args: string[]) => runGit(root, args);
      const branch = await git(["branch", "--show-current"]);
      if (branch.code !== 0)
        return {
          available: false,
          files: 0,
          additions: 0,
          deletions: 0,
          summary: "",
          diff: "",
          error: "当前工作区未初始化 Git",
        };
      const status = await git(["status", "--short", "--untracked-files=all"]);
      const tracked = await git(["diff", "--numstat", "-z", "HEAD"]);
      const untracked = status.output
        .split(/\r?\n/)
        .filter((line) => line.startsWith("?? "));
      const trackedChanges = parseGitNumstat(tracked.output);
      const fileChanges = new Map(
        trackedChanges.map((change) => [change.path, change]),
      );
      let additions = trackedChanges.reduce(
        (total, change) => total + change.additions,
        0,
      );
      let deletions = trackedChanges.reduce(
        (total, change) => total + change.deletions,
        0,
      );
      const untrackedFiles = await git([
        "ls-files",
        "--others",
        "--exclude-standard",
        "-z",
      ]);
      for (const rawPath of untrackedFiles.output.split("\0")) {
        if (!rawPath) continue;
        const file = resolveWorkspaceFile(root, rawPath);
        let fileAdditions = 0;
        try {
          const info = await stat(file.target);
          if (info.isFile() && info.size <= 2_000_000)
            fileAdditions = countTextLines(await readFile(file.target)) ?? 0;
        } catch {
          // The file may have changed between Git status and this read.
        }
        const change = {
          path: file.relative,
          additions: fileAdditions,
          deletions: 0,
        };
        fileChanges.set(change.path, change);
        additions += fileAdditions;
      }
      for (const line of status.output.split(/\r?\n/)) {
        if (!line.trim()) continue;
        const value = line.slice(3).trim();
        const renamed = value.lastIndexOf(" -> ");
        const filePath = (renamed >= 0 ? value.slice(renamed + 4) : value)
          .replace(/^['"]|['"]$/g, "")
          .replaceAll("\\", "/");
        if (filePath && !fileChanges.has(filePath))
          fileChanges.set(filePath, {
            path: filePath,
            additions: 0,
            deletions: 0,
          });
      }
      const diff = includeDiff
        ? await git(["diff", "--no-ext-diff", "HEAD"])
        : { code: 0, output: "" };
      return {
        available: true,
        branch: branch.output.trim() || "HEAD",
        files: status.output.split(/\r?\n/).filter(Boolean).length,
        additions,
        deletions,
        fileChanges: [...fileChanges.values()],
        summary: status.output.trim(),
        diff: `${diff.output}${untracked.length ? `\n\n未跟踪文件：\n${untracked.join("\n")}` : ""}`.slice(
          0,
          200_000,
        ),
      };
    },
  );
  ipcMain.handle(
    "workspace:git-file-diff",
    async (_event, workspacePath: string, filePath: string) => {
      const root = path.resolve(workspacePathSchema.parse(workspacePath));
      const rootInfo = await stat(root);
      if (!rootInfo.isDirectory()) throw new Error("工作区不是有效目录");
      const file = resolveWorkspaceFile(root, filePath);
      const git = (args: string[]) => runGit(root, args);
      const result = await git([
        "diff",
        "--no-ext-diff",
        "--no-color",
        "HEAD",
        "--",
        file.relative,
      ]);
      if (result.code === 0 && result.output.trim())
        return { path: file.relative, diff: result.output };

      const status = await git([
        "status",
        "--short",
        "--untracked-files=all",
        "--",
        file.relative,
      ]);
      if (!status.output.split(/\r?\n/).some((line) => line.startsWith("?? ")))
        return {
          path: file.relative,
          diff: "",
          error: result.code !== 0 ? result.output.trim() : undefined,
        };

      const info = await stat(file.target);
      if (info.size > 2_000_000)
        return {
          path: file.relative,
          diff: "",
          error: "文件超过 2 MB，暂不在弹窗中展开。",
        };
      const content = await readFile(file.target);
      if (content.includes(0))
        return {
          path: file.relative,
          diff: "",
          error: "这是二进制文件，没有可读的文本差异。",
        };
      return {
        path: file.relative,
        diff: untrackedDiff(file.relative, content.toString("utf8")),
      };
    },
  );
  ipcMain.handle(
    "context:pick-files",
    async (event, rawDefaultDirectory?: string): Promise<ContextFile[]> => {
      const defaultPath = await existingDirectory(rawDefaultDirectory);
      const options = {
        title: "添加上下文文件",
        ...(defaultPath ? { defaultPath } : {}),
        properties: ["openFile", "multiSelections"] as (
          "openFile" | "multiSelections"
        )[],
        filters: [
          {
            name: "文本和代码",
            extensions: CONTEXT_FILE_DIALOG_EXTENSIONS,
          },
          { name: "所有文件", extensions: ["*"] },
        ],
      };
      const owner = BrowserWindow.fromWebContents(event.sender);
      if (!owner || owner.isDestroyed())
        throw new Error("无法确认文件选择窗口");
      const result = await dialog.showOpenDialog(owner, options);
      if (result.canceled) return [];
      if (result.filePaths.length > MAX_CONTEXT_FILES)
        throw new Error(`一次最多添加 ${MAX_CONTEXT_FILES} 个上下文文件`);
      const selectedPaths = result.filePaths;
      const fileStats = await Promise.all(
        selectedPaths.map((filePath) => stat(filePath)),
      );
      const sourceBytes = fileStats.reduce(
        (total, info) => total + info.size,
        0,
      );
      if (sourceBytes > MAX_CONTEXT_TOTAL_SOURCE_BYTES)
        throw new Error(
          `所选文件原始大小不能超过 ${Math.round(MAX_CONTEXT_TOTAL_SOURCE_BYTES / 1024 / 1024)} MB`,
        );
      const files = await Promise.all(selectedPaths.map(parseContextFile));
      const extractedBytes = files.reduce(
        (total, file) => total + file.size,
        0,
      );
      if (extractedBytes > MAX_CONTEXT_TOTAL_BYTES)
        throw new Error("解析后的上下文总大小不能超过 2 MB");
      return files;
    },
  );
  ipcMain.handle("context:parse-file", (_event, rawPath: string) =>
    parseContextFile(localPathSchema.parse(rawPath)),
  );
  ipcMain.handle(
    "files:save-text",
    async (
      event,
      suggestedName: string,
      content: string,
      format: "md" | "json",
    ) => {
      const owner = BrowserWindow.fromWebContents(event.sender);
      if (!owner || owner.isDestroyed()) throw new Error("无法确认保存窗口");
      if (typeof content !== "string" || content.length > 20 * 1024 * 1024)
        throw new Error("导出内容超过 20 MB");
      const safeName =
        String(suggestedName || "kcode-export")
          .replace(/[<>:\"/\\|?*\x00-\x1F]/g, "-")
          .replace(/\.+$/g, "") || "kcode-export";
      const extension = format === "json" ? ".json" : ".md";
      const result = await dialog.showSaveDialog(owner, {
        title: "导出会话",
        defaultPath: safeName.endsWith(extension)
          ? safeName
          : `${safeName}${extension}`,
        filters: [
          format === "json"
            ? { name: "JSON", extensions: ["json"] }
            : { name: "Markdown", extensions: ["md"] },
        ],
      });
      if (result.canceled || !result.filePath) return null;
      await writeFile(result.filePath, content, "utf8");
      return result.filePath;
    },
  );
  ipcMain.handle(
    "context:pick-directory",
    async (event, rawDefaultDirectory?: string) => {
      const owner = BrowserWindow.fromWebContents(event.sender);
      if (!owner || owner.isDestroyed())
        throw new Error("无法确认文件夹选择窗口");
      const defaultPath = await existingDirectory(rawDefaultDirectory);
      const result = await dialog.showOpenDialog(owner, {
        title: "设置上下文文件目录",
        ...(defaultPath ? { defaultPath } : {}),
        properties: ["openDirectory", "createDirectory"],
      });
      if (result.canceled || !result.filePaths[0]) return null;
      return path.resolve(result.filePaths[0]);
    },
  );
  ipcMain.handle("chat:start", (_event, rawRequest: ModelRequest) => {
    const request = modelRequestSchema.parse(rawRequest) as ModelRequest;
    const id = request.requestId ?? randomUUID();
    const controller = new AbortController();
    const startedAt = Date.now();
    controllers.set(id, controller);
    const runtimeTaskId = request.taskId ?? id;
    agentRuntimeService.start(runtimeTaskId, id, startedAt);
    const runtimeJournal = new RuntimeEventJournal(
      runtimeTaskId,
      id,
      (events) => {
        for (const event of events)
          agentRuntimeService.apply(event.taskId, event.requestId, event);
        appendRuntimeEvents(events);
      },
      100,
      (error) =>
        writeLog("error", "runtime.journal.write-failed", {
          id,
          taskId: runtimeTaskId,
          error: error instanceof Error ? error.message : String(error),
        }),
    );
    // Persist the turn before provider setup so a crash during startup does
    // not leave the task with no recoverable runtime status.
    runtimeJournal.append(
      { type: "progress", message: "任务已进入运行队列" },
      startedAt,
    );
    const rendererEvents = new RendererEventBatcher((item: AgentEvent) => {
      const journaled = runtimeJournal.append(item);
      for (const window of BrowserWindow.getAllWindows())
        if (!window.isDestroyed() && !window.webContents.isDestroyed())
          window.webContents.send("chat:event", id, { ...journaled });
    });
    const removeSubagentEventSink = setSubagentEventSink(id, (item) =>
      rendererEvents.push(item),
    );
    const checkpointReady = writeCheckpoint(id, {
      id,
      request,
      startedAt,
      status: "running",
      events: [],
      subagents: [],
    });
    void (async () => {
      const events: unknown[] = [];
      let checkpointStatus: "running" | "paused" | "done" = "running";
      const checkpointWriter = new LatestWriteQueue((snapshot: unknown) =>
        writeCheckpoint(id, snapshot),
      );
      let lastCheckpointAt = 0;
      let terminalEventSent = false;
      const queueCheckpoint = (force = false) => {
        const now = Date.now();
        if (!force && now - lastCheckpointAt < 5_000) return;
        lastCheckpointAt = now;
        const snapshot = {
          id,
          request,
          startedAt,
          status: checkpointStatus,
          events: [...events],
          subagents: subagentCheckpoints(id),
        };
        checkpointWriter.enqueue(snapshot);
      };
      try {
        await checkpointReady;
        for await (const item of runAgent(id, request, controller.signal)) {
          if (item.type === "done" || item.type === "error")
            terminalEventSent = true;
          if (item.type !== "activity_output") {
            events.push(compactCheckpointEvent(item));
            if (events.length > 100) events.shift();
          }
          checkpointStatus =
            item.type === "done"
              ? "done"
              : item.type === "error"
                ? "paused"
                : "running";
          queueCheckpoint(
            item.type === "done" ||
              item.type === "error" ||
              (item.type === "activity" && item.activity.status !== "running"),
          );
          rendererEvents.push(item);
          if (item.type === "done") {
            await checkpointWriter.waitForIdle();
            await removeCheckpoint(id);
            notifyTask("done");
          }
          if (item.type === "error") notifyTask("error", item.message);
        }
        if (!controller.signal.aborted && !terminalEventSent) {
          const message =
            "Agent 运行已意外结束，但没有返回完成或错误状态。任务已安全暂停，请重试。";
          const item = { type: "error" as const, message };
          events.push(compactCheckpointEvent(item));
          if (events.length > 100) events.shift();
          checkpointStatus = "paused";
          terminalEventSent = true;
          queueCheckpoint(true);
          rendererEvents.push(item);
          notifyTask("error", message);
          writeLog("error", "agent.missingTerminalEvent", {
            id,
            taskId: request.taskId,
          });
        }
      } catch (error) {
        writeLog("error", "agent.request", {
          id,
          taskId: request.taskId,
          error:
            error instanceof Error
              ? { message: error.message, stack: error.stack }
              : String(error),
        });
        if (!controller.signal.aborted && !terminalEventSent) {
          const friendly = friendlyModelError(
            error instanceof Error ? error.message : String(error),
          );
          const item = {
            type: "error",
            message: friendly,
          } as const;
          terminalEventSent = true;
          checkpointStatus = "paused";
          events.push(compactCheckpointEvent(item));
          if (events.length > 100) events.shift();
          queueCheckpoint(true);
          rendererEvents.push(item);
          notifyTask("error", friendly);
        }
      } finally {
        if (controller.signal.aborted && !terminalEventSent) {
          const item = {
            type: "error",
            message: "任务已停止",
            code: "cancelled",
            retryable: false,
            userAction: "none",
          } as const;
          terminalEventSent = true;
          checkpointStatus = "paused";
          events.push(compactCheckpointEvent(item));
          if (events.length > 100) events.shift();
          queueCheckpoint(true);
          rendererEvents.push(item);
        }
        await stopSubagentsForParent(id, false);
        try {
          rendererEvents.close();
        } catch (error) {
          writeLog("error", "renderer.events.close-failed", {
            id,
            error: error instanceof Error ? error.message : String(error),
          });
        }
        runtimeJournal.close();
        if (checkpointStatus !== "done") {
          checkpointStatus = "paused";
          queueCheckpoint(true);
          try {
            await checkpointWriter.waitForIdle();
          } catch (error) {
            writeLog("error", "checkpoint.final-write-failed", {
              id,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
        releaseSubagentRecords(id);
        agentRuntimeService.markInactive(id);
        clearAgentSteering(id);
        clearAgentToolTraces(id);
        removeSubagentEventSink();
        controllers.delete(id);
      }
    })();
    return id;
  });
  ipcMain.handle("chat:cancel", (_e, id: string) =>
    controllers.get(id)?.abort(),
  );
  ipcMain.handle(
    "chat:steer",
    (_e, rawRequestId: string, rawContent: string) => {
      const requestId = idSchema.parse(rawRequestId);
      if (!controllers.has(requestId))
        throw new Error("当前轮次已经结束，无法追加指令");
      steerAgent(requestId, steerContentSchema.parse(rawContent));
    },
  );
  ipcMain.handle(
    "chat:cleanup",
    async (_e, requestIds: string[], activityIds: string[]) => {
      for (const requestId of requestIds) {
        controllers.get(requestId)?.abort();
      }
      await cleanupAgentRecords(requestIds, activityIds);
      await Promise.all(requestIds.map(removeCheckpoint));
      for (const requestId of requestIds) controllers.delete(requestId);
    },
  );
  ipcMain.handle(
    "chat:approve",
    (_e, requestId: string, activityId: string, allowed: boolean) =>
      resolveApproval(requestId, activityId, allowed),
  );
  ipcMain.handle(
    "chat:approveWithScope",
    (
      _e,
      requestId: string,
      activityId: string,
      allowed: boolean,
      scope: "once" | "session" | "permanent",
      command?: string,
      category?: string,
      workspace?: string,
    ) =>
      resolveApprovalWithScope(
        requestId,
        activityId,
        allowed,
        scope,
        command,
        category,
        workspace,
      ),
  );
  createWindow();
  await initializeRemoteControl({
    onState: (state) => {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      mainWindow.webContents.send("remote:state", state);
    },
    onCommand: (command) => {
      if (rendererReady && mainWindow && !mainWindow.isDestroyed())
        mainWindow.webContents.send("remote:command", command);
      else pendingRemoteCommands.push(command);
    },
  });
  scheduleUpdateChecks();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});
app.on("before-quit", () => {
  quitting = true;
  closeMcpServers();
  for (const controller of controllers.values()) controller.abort();
  stopManagedProcessSupervisor();
  void cleanupAllBackgroundProcesses().catch((error) =>
    writeLog("error", "process.cleanup.failed", error),
  );
  closeRemoteConnection();
});
app.on("window-all-closed", () => {
  void closeAllSubagents();
  closeAllMysqlSessions();
  closeAllSqlServerSessions();
  closeAllMongoSessions();
  closeAllSshSessions();
  closeStateDatabase();
  if (process.platform !== "darwin") app.quit();
});

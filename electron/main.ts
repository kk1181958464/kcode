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
  ContextFile,
  ContextSummaryRequest,
  ModelRequest,
  ProviderConfig,
} from "../src/types";
import {
  cancelContextSummary,
  discoverModels,
  summarizeContext,
} from "./gateway";
import {
  cleanupAgentRecords,
  resolveApproval,
  runAgent,
  undoActivity,
} from "./agent";
import { closeAllSshSessions, configureSshKnownHosts } from "./ssh";
import { closeAllMysqlSessions } from "./mysql";
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
  loadState,
  saveState,
  stateStorageStats,
} from "./state-db";
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
  modelRequestSchema,
  optionalIdSchema,
  stateKeySchema,
  urlSchema,
  workspacePathSchema,
} from "./ipc-validation";
import { initializeAppUpdater, scheduleUpdateChecks } from "./app-updater";

const controllers = new Map<string, AbortController>();
installProcessLogging();
const appUserModelId = "com.kcode.desktop";
app.setName("KCode");
if (process.platform === "win32") app.setAppUserModelId(appUserModelId);
let mainWindow: BrowserWindow | undefined;
let tray: Tray | undefined;
let unreadTasks = 0;
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
const icoPath = () =>
  [
    path.join(process.resourcesPath, "icon.ico"),
    path.resolve(__dirname, "../../build/icon.ico"),
  ].find(existsSync);
const windowIcon = () =>
  process.platform === "win32" ? icoPath() || iconPath() : iconPath();
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
const checkpointPath = (id: string) =>
  path.join(app.getPath("userData"), "checkpoints", `${id}.json`);
async function writeCheckpoint(id: string, value: unknown) {
  await mkdir(path.dirname(checkpointPath(id)), { recursive: true });
  await writeFile(checkpointPath(id), JSON.stringify(value), "utf8");
}
async function removeCheckpoint(id: string) {
  await rm(checkpointPath(id), { force: true });
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
const contextExtensions = new Set([
  ".txt",
  ".md",
  ".json",
  ".js",
  ".jsx",
  ".ts",
  ".tsx",
  ".css",
  ".html",
  ".py",
  ".java",
  ".go",
  ".rs",
  ".c",
  ".cpp",
  ".h",
  ".hpp",
  ".yml",
  ".yaml",
  ".toml",
  ".xml",
  ".sql",
  ".sh",
  ".ps1",
]);

function createWindow() {
  const win = new BrowserWindow({
    width: 1420,
    height: 900,
    minWidth: 960,
    minHeight: 640,
    frame: false,
    autoHideMenuBar: true,
    backgroundColor: "#f5f5f3",
    icon: windowIcon(),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow = win;
  setBrowserHost(win, {
    onState: (state) => {
      if (!win.isDestroyed()) win.webContents.send("browser:state", state);
    },
    onUserClose: (requestId) => {
      controllers.get(requestId)?.abort();
      if (!win.isDestroyed())
        win.webContents.send("chat:event", requestId, {
          type: "error",
          message: "网页已关闭，浏览器任务已停止",
        });
    },
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

app.whenReady().then(() => {
  configureSshKnownHosts(
    path.join(app.getPath("userData"), "ssh-known-hosts.json"),
  );
  if (process.platform === "darwin") app.dock?.setIcon(appIcon(256));
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
  ipcMain.handle("providers:list", listProviders);
  ipcMain.handle("state:load", (_e, key: string) =>
    loadState(stateKeySchema.parse(key)),
  );
  ipcMain.handle("state:save", (_e, key: string, value: unknown) =>
    saveState(stateKeySchema.parse(key), value),
  );
  ipcMain.handle("state:stats", () => stateStorageStats());
  ipcMain.handle("state:compact", () => compactStateDatabase());
  ipcMain.on("log:renderer-error", (_e, detail) =>
    writeLog("error", "renderer.error", detail),
  );
  ipcMain.handle("log:reveal", () => shell.openPath(logsDirectory()));
  ipcMain.handle("shell:open-external", (_e, url: string) => {
    const target = urlSchema.parse(url);
    if (!/^https?:\/\//i.test(target)) throw new Error("只能打开 http/https 链接");
    return shell.openExternal(target);
  });
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
    (_e, provider: ProviderConfig, key?: string) => saveProvider(provider, key),
  );
  ipcMain.handle(
    "chat:undo",
    (_e, workspacePath: string, activityId: string, force?: boolean) =>
      undoActivity(workspacePath, activityId, Boolean(force)),
  );
  ipcMain.handle("providers:remove", (_e, id: string) => removeProvider(id));
  ipcMain.handle("providers:discover", (_e, id: string) => discoverModels(id));
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
    "workspace:git-state",
    async (_event, workspacePath: string) => {
      const root = path.resolve(workspacePathSchema.parse(workspacePath));
      const info = await stat(root);
      if (!info.isDirectory()) throw new Error("工作区不是有效目录");
      const git = (args: string[]) =>
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
      const status = await git(["status", "--short"]);
      const tracked = await git(["diff", "--numstat", "HEAD"]);
      const untracked = status.output
        .split(/\r?\n/)
        .filter((line) => line.startsWith("?? "));
      let additions = 0,
        deletions = 0;
      for (const line of tracked.output.split(/\r?\n/)) {
        const [add, del] = line.split("\t");
        additions += Number(add) || 0;
        deletions += Number(del) || 0;
      }
      const diff = await git(["diff", "--no-ext-diff", "HEAD"]);
      return {
        available: true,
        branch: branch.output.trim() || "HEAD",
        files: status.output.split(/\r?\n/).filter(Boolean).length,
        additions,
        deletions,
        summary: status.output.trim(),
        diff: `${diff.output}${untracked.length ? `\n\n未跟踪文件：\n${untracked.join("\n")}` : ""}`.slice(
          0,
          200_000,
        ),
      };
    },
  );
  ipcMain.handle(
    "context:pick-files",
    async (event): Promise<ContextFile[]> => {
      const options = {
        title: "添加上下文文件",
        properties: ["openFile", "multiSelections"] as (
          "openFile" | "multiSelections"
        )[],
        filters: [
          {
            name: "文本和代码",
            extensions: [
              "txt",
              "md",
              "json",
              "js",
              "jsx",
              "ts",
              "tsx",
              "css",
              "html",
              "py",
              "java",
              "go",
              "rs",
              "c",
              "cpp",
              "h",
              "hpp",
              "yml",
              "yaml",
              "toml",
              "xml",
              "sql",
              "sh",
              "ps1",
            ],
          },
        ],
      };
      const owner = BrowserWindow.fromWebContents(event.sender);
      if (!owner || owner.isDestroyed())
        throw new Error("无法确认文件选择窗口");
      const result = await dialog.showOpenDialog(owner, options);
      if (result.canceled) return [];
      if (result.filePaths.length > 8)
        throw new Error("一次最多添加 8 个上下文文件");
      const selectedPaths = result.filePaths;
      const fileStats = await Promise.all(
        selectedPaths.map((filePath) => stat(filePath)),
      );
      if (
        fileStats.reduce((total, info) => total + info.size, 0) >
        2 * 1024 * 1024
      )
        throw new Error("上下文文件总大小不能超过 2 MB");
      const files = await Promise.all(
        selectedPaths.map(async (filePath, index) => {
          if (!contextExtensions.has(path.extname(filePath).toLowerCase()))
            throw new Error(
              `${path.basename(filePath)} 不是支持的文本或代码文件`,
            );
          const info = fileStats[index];
          if (!info.isFile())
            throw new Error(`${path.basename(filePath)} 不是普通文件`);
          if (info.size > 512 * 1024)
            throw new Error(
              `${path.basename(filePath)} 超过 512 KB，无法作为上下文添加`,
            );
          const content = await readFile(filePath, "utf8");
          if (content.includes("\0"))
            throw new Error(`${path.basename(filePath)} 不是有效的文本文件`);
          return {
            id: randomUUID(),
            name: path.basename(filePath),
            path: filePath,
            content,
            size: info.size,
          };
        }),
      );
      return files;
    },
  );
  ipcMain.handle("chat:start", (event, rawRequest: ModelRequest) => {
    const request = modelRequestSchema.parse(rawRequest) as ModelRequest;
    const id = randomUUID();
    const controller = new AbortController();
    const startedAt = Date.now();
    controllers.set(id, controller);
    const removeSubagentEventSink = setSubagentEventSink(id, (item) =>
      event.sender.send("chat:event", id, item),
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
      await checkpointReady;
      const events: unknown[] = [];
      let checkpointStatus: "running" | "paused" | "done" = "running";
      let checkpointWrite = Promise.resolve();
      let lastCheckpointAt = 0;
      const queueCheckpoint = (force = false) => {
        const now = Date.now();
        if (!force && now - lastCheckpointAt < 250) return;
        lastCheckpointAt = now;
        const snapshot = {
          id,
          request,
          startedAt,
          status: checkpointStatus,
          events: [...events],
          subagents: subagentCheckpoints(id),
        };
        checkpointWrite = checkpointWrite.then(() =>
          writeCheckpoint(id, snapshot),
        );
      };
      try {
        for await (const item of runAgent(id, request, controller.signal)) {
          events.push(item);
          if (events.length > 100) events.shift();
          checkpointStatus =
            item.type === "done"
              ? "done"
              : item.type === "error"
                ? "paused"
                : "running";
          queueCheckpoint(
            item.type === "done" ||
              item.type === "error" ||
              item.type === "activity",
          );
          event.sender.send("chat:event", id, item);
          if (item.type === "done") {
            await checkpointWrite;
            await removeCheckpoint(id);
            notifyTask("done");
          }
          if (item.type === "error") notifyTask("error", item.message);
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
        if (!controller.signal.aborted) {
          event.sender.send("chat:event", id, {
            type: "error",
            message: error instanceof Error ? error.message : String(error),
          });
          notifyTask(
            "error",
            error instanceof Error ? error.message : String(error),
          );
        }
      } finally {
        await stopSubagentsForParent(id, false);
        if (checkpointStatus !== "done") {
          checkpointStatus = "paused";
          queueCheckpoint(true);
          await checkpointWrite;
        }
        releaseSubagentRecords(id);
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
  createWindow();
  scheduleUpdateChecks();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});
app.on("window-all-closed", () => {
  void closeAllSubagents();
  closeAllMysqlSessions();
  closeAllSshSessions();
  closeStateDatabase();
  if (process.platform !== "darwin") app.quit();
});

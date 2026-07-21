import { app, BrowserWindow, ipcMain, shell } from "electron";
import { autoUpdater, type ProgressInfo } from "electron-updater";
import type { AppUpdateState } from "../src/types";
import { writeLog } from "./logger";
import { releaseNotesText } from "./release-notes";
import { networkFetch } from "./network";
import { resolveLatestUpdateSource } from "./update-source";

const RELEASES_URL = "https://github.com/kk1181958464/kcode/releases/latest";
const STARTUP_DELAY_MS = 5_000;
const PERIODIC_CHECK_MS = 6 * 60 * 60 * 1_000;
let state = initialState();
let initialized = false;
let checkPromise: Promise<AppUpdateState> | undefined;
let downloadPromise: Promise<AppUpdateState> | undefined;

function initialState(): AppUpdateState {
  const portable = Boolean(process.env.PORTABLE_EXECUTABLE_FILE);
  return {
    status: !app.isPackaged || portable ? "unsupported" : "idle",
    currentVersion: app.getVersion(),
    portable,
  };
}

function setState(next: Partial<AppUpdateState>) {
  state = { ...state, ...next };
  for (const window of BrowserWindow.getAllWindows())
    if (!window.isDestroyed()) window.webContents.send("update:state", state);
  return state;
}

const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : String(error || "更新失败");

function check() {
  if (!app.isPackaged || state.portable)
    return Promise.resolve(setState({ status: "unsupported" }));
  if (checkPromise) return checkPromise;
  checkPromise = (async () => {
    setState({ status: "checking", error: undefined, progress: undefined });
    try {
      try {
        const source = await resolveLatestUpdateSource(networkFetch);
        autoUpdater.setFeedURL({
          provider: "generic",
          url: source.feedUrl,
          channel: "latest",
          requestHeaders: {
            "Cache-Control": "no-cache, no-store, max-age=0",
            Pragma: "no-cache",
          },
        });
        setState({ version: source.version });
        writeLog("info", "updater.source.resolved", source);
      } catch (error) {
        autoUpdater.setFeedURL({
          provider: "github",
          owner: "kk1181958464",
          repo: "kcode",
          releaseType: "release",
        });
        writeLog("warn", "updater.source.resolve.failed", error);
      }
      autoUpdater.requestHeaders = {
        "Cache-Control": "no-cache, no-store, max-age=0",
        Pragma: "no-cache",
      };
      await autoUpdater.checkForUpdates();
    } catch (error) {
      writeLog("error", "updater.check.failed", error);
      setState({ status: "error", error: errorMessage(error) });
    }
    return state;
  })().finally(() => {
    checkPromise = undefined;
  });
  return checkPromise;
}

function download() {
  if (downloadPromise) return downloadPromise;
  if (state.status !== "available") return Promise.resolve(state);
  downloadPromise = (async () => {
    setState({ status: "downloading", error: undefined });
    try {
      await autoUpdater.downloadUpdate();
    } catch (error) {
      writeLog("error", "updater.download.failed", error);
      setState({ status: "error", error: errorMessage(error) });
    }
    return state;
  })().finally(() => {
    downloadPromise = undefined;
  });
  return downloadPromise;
}

export function initializeAppUpdater(beforeInstall: () => void) {
  if (initialized) return;
  initialized = true;
  state = initialState();
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.allowPrerelease = false;
  autoUpdater.fullChangelog = true;
  autoUpdater.requestHeaders = {
    "Cache-Control": "no-cache, no-store, max-age=0",
    Pragma: "no-cache",
  };
  autoUpdater.logger = {
    info: (...args) => writeLog("info", "updater", args),
    warn: (...args) => writeLog("warn", "updater", args),
    error: (...args) => writeLog("error", "updater", args),
    debug: (...args) => writeLog("info", "updater.debug", args),
  };
  autoUpdater.on("checking-for-update", () =>
    setState({ status: "checking", error: undefined }),
  );
  autoUpdater.on("update-available", (info) =>
    setState({
      status: "available",
      version: info.version,
      releaseName: info.releaseName || undefined,
      releaseNotes: releaseNotesText(info.releaseNotes),
      progress: undefined,
      error: undefined,
    }),
  );
  autoUpdater.on("update-not-available", (info) =>
    setState({
      status: "not-available",
      version: info.version,
      releaseNotes: undefined,
      progress: undefined,
      error: undefined,
    }),
  );
  autoUpdater.on("download-progress", (progress: ProgressInfo) =>
    setState({
      status: "downloading",
      progress: {
        percent: progress.percent,
        transferred: progress.transferred,
        total: progress.total,
        bytesPerSecond: progress.bytesPerSecond,
      },
      error: undefined,
    }),
  );
  autoUpdater.on("update-downloaded", (info) =>
    setState({
      status: "downloaded",
      version: info.version,
      releaseName: info.releaseName || undefined,
      releaseNotes: releaseNotesText(info.releaseNotes),
      progress: state.progress
        ? { ...state.progress, percent: 100 }
        : undefined,
      error: undefined,
    }),
  );
  autoUpdater.on("error", (error) => {
    writeLog("error", "updater.error", error);
    setState({ status: "error", error: errorMessage(error) });
  });

  ipcMain.handle("update:state", () => state);
  ipcMain.handle("update:check", () => check());
  ipcMain.handle("update:download", () => download());
  ipcMain.handle("update:install", () => {
    if (state.status !== "downloaded") return;
    beforeInstall();
    autoUpdater.quitAndInstall(false, true);
  });
  ipcMain.handle("update:open-release", () => shell.openExternal(RELEASES_URL));
}

export function scheduleUpdateChecks() {
  if (!app.isPackaged || state.portable) return;
  const startup = setTimeout(() => void check(), STARTUP_DELAY_MS);
  startup.unref();
  const periodic = setInterval(() => {
    if (!["available", "downloading", "downloaded"].includes(state.status))
      void check();
  }, PERIODIC_CHECK_MS);
  periodic.unref();
}

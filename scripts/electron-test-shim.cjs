/**
 * Plain-CJS `electron` stand-in for `node --test`. tsx transpiles the backend
 * TypeScript to CommonJS, so `import { app } from "electron"` becomes a
 * `require("electron")` — which bypasses ESM resolve hooks. The preload patches
 * Module._load to return this object for the bare `electron` specifier, letting
 * backend modules load without an Electron host. Mirrors the surface the tests
 * exercise; state goes under a temp dir so tests never touch a real ~/.kcode.
 */
const os = require("node:os");
const path = require("node:path");

const APP_DIR =
  process.env.KCODE_HOME || path.join(os.tmpdir(), "kcode-test-home");

const app = {
  getPath(name) {
    if (name === "temp") return os.tmpdir();
    if (name === "home") return os.homedir();
    return APP_DIR;
  },
  getAppPath() {
    return process.cwd();
  },
  getName() {
    return "kcode";
  },
  getVersion() {
    return "0.0.0-test";
  },
  isPackaged: false,
  whenReady() {
    return Promise.resolve();
  },
  on() {
    return app;
  },
  quit() {},
  requestSingleInstanceLock() {
    return true;
  },
  setAppUserModelId() {},
};

const safeStorage = {
  isEncryptionAvailable() {
    return true;
  },
  encryptString(plain) {
    return Buffer.from(plain, "utf8");
  },
  decryptString(encrypted) {
    return Buffer.from(encrypted).toString("utf8");
  },
};

const net = { fetch: (input, init) => fetch(input, init) };

class BrowserWindow {
  static getAllWindows() {
    return [];
  }
}
class WebContentsView {}
const ipcMain = { handle() {}, on() {}, removeHandler() {} };
const shell = {
  openExternal() {
    return Promise.resolve();
  },
  showItemInFolder() {},
};
const dialog = {
  showOpenDialog() {
    return Promise.resolve({ canceled: true, filePaths: [] });
  },
};
const Menu = {
  buildFromTemplate() {
    return { popup() {} };
  },
  setApplicationMenu() {},
};
const Tray = class {};
const nativeImage = { createFromPath: () => ({}) };

module.exports = {
  app,
  safeStorage,
  net,
  BrowserWindow,
  WebContentsView,
  ipcMain,
  shell,
  dialog,
  Menu,
  Tray,
  nativeImage,
};

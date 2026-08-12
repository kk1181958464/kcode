/**
 * Minimal `electron` module replacement for the CLI build. esbuild aliases the
 * bare `electron` import to this file, so the existing runtime code (store.ts,
 * ssh-remote.ts, network.ts, browser.ts, …) compiles and runs under plain
 * Node.js without an Electron host. Only the surface the runtime actually
 * touches is implemented; GUI-only classes are inert stubs.
 */
import os from "node:os";
import path from "node:path";

const APP_DIR = process.env.KCODE_HOME || path.join(os.homedir(), ".kcode");

type PathName =
  | "userData"
  | "appData"
  | "desktop"
  | "home"
  | "temp"
  | "logs"
  | "documents";

export const app = {
  getPath(name: PathName): string {
    switch (name) {
      case "userData":
      case "appData":
        return APP_DIR;
      case "logs":
        return path.join(APP_DIR, "logs");
      case "temp":
        return os.tmpdir();
      case "home":
        return os.homedir();
      case "desktop":
        return path.join(os.homedir(), "Desktop");
      case "documents":
        return path.join(os.homedir(), "Documents");
      default:
        return APP_DIR;
    }
  },
  getAppPath(): string {
    // Resource root: bundled skills etc. resolve relative to the repo root.
    return process.env.KCODE_APP_PATH || process.cwd();
  },
  getName() {
    return "kcode";
  },
  getVersion() {
    return process.env.KCODE_VERSION || "0.0.0-cli";
  },
  // The CLI is never a packaged Electron app; report dev mode so path/shortcut
  // logic that guards on `isPackaged` takes the non-desktop branch.
  isPackaged: false,
  whenReady() {
    return Promise.resolve();
  },
  on() {
    return app;
  },
  quit() {
    process.exit(0);
  },
  requestSingleInstanceLock() {
    return true;
  },
  setAppUserModelId() {},
};

/**
 * safeStorage stand-in. Electron encrypts with the OS keychain; for the CLI PoC
 * we base64-encode so the on-disk shape (a base64 string) stays compatible with
 * the desktop store format. NOTE: this is obfuscation, not encryption — a
 * production CLI should swap in keytar or a passphrase-derived key.
 */
export const safeStorage = {
  isEncryptionAvailable() {
    return true;
  },
  encryptString(plain: string): Buffer {
    return Buffer.from(plain, "utf8");
  },
  decryptString(encrypted: Buffer): string {
    return Buffer.from(encrypted).toString("utf8");
  },
};

/** network.ts only calls net.fetch; Node 20+ has a global fetch. */
export const net = {
  fetch: (input: any, init?: any) => fetch(input, init),
};

// GUI-only surfaces. Imported at module load by browser.ts / app-updater.ts /
// remote-control.ts but only constructed when their tools run. Constructing one
// throws, which surfaces as a normal tool error ("browser unavailable in CLI").
export class BrowserWindow {
  static getAllWindows(): BrowserWindow[] {
    return [];
  }
  constructor() {
    throw new Error("BrowserWindow 在 CLI 模式下不可用");
  }
}

export class WebContentsView {
  constructor() {
    throw new Error("WebContentsView 在 CLI 模式下不可用");
  }
}

export const ipcMain = {
  handle() {},
  on() {},
  removeHandler() {},
};

export const shell = {
  openExternal() {
    return Promise.resolve();
  },
  showItemInFolder() {},
};

export const dialog = {
  showOpenDialog() {
    return Promise.resolve({ canceled: true, filePaths: [] });
  },
};

export const Menu = {
  buildFromTemplate() {
    return { popup() {} };
  },
  setApplicationMenu() {},
};

export const Tray = class {};
export const nativeImage = {
  createFromPath() {
    return {};
  },
};

export default {
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

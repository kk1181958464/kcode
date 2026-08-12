import { createRequire } from "node:module";
import path from "node:path";

/**
 * Test-only preload for the runAgent suite. tsx transpiles the backend
 * TypeScript to CommonJS, so `import { app } from "electron"` becomes
 * `require("electron")` — which bypasses ESM resolve hooks. We patch
 * Module._load to return a Node-only electron shim for the bare `electron`
 * specifier, so backend modules load under the test runner without an
 * Electron host. Production builds never load this file.
 */
const require = createRequire(import.meta.url);
const Module = require("node:module");
const shim = require(path.resolve(import.meta.dirname, "electron-test-shim.cjs"));

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "electron") return shim;
  return originalLoad.call(this, request, parent, isMain);
};

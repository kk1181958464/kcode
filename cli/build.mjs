import { build } from "esbuild";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// The CLI has its own npm version line, independent of the desktop app's
// release version in the root package.json.
const cliPkg = JSON.parse(
  readFileSync(path.join(root, "cli", "package.json"), "utf8"),
);

/**
 * Bundle the CLI entry with esbuild. The key move is aliasing the bare
 * `electron` import to our shim so every runtime file that does
 * `import { app } from "electron"` resolves to a Node-only implementation.
 * Bundling to a single file also sidesteps the ESM/CJS interop friction of
 * running the raw TypeScript sources under different module systems.
 *
 * Output lands next to cli/package.json so `npm publish` runs from cli/.
 */
await build({
  entryPoints: [path.join(root, "cli", "index.ts")],
  bundle: true,
  platform: "node",
  target: "node20",
  format: "cjs",
  outfile: path.join(root, "cli", "kcode-cli.cjs"),
  // Shebang makes the artifact directly runnable as the package's `bin`.
  banner: { js: "#!/usr/bin/env node" },
  alias: {
    electron: path.join(root, "cli", "electron-shim.ts"),
  },
  // Only these are actually `require`d by the bundle at runtime (verified by
  // scanning the output). They ship as the CLI package's own dependencies, so
  // npm installs them (and, for ripgrep, the right per-platform binary).
  external: ["ssh2", "mysql2", "mongodb", "mssql", "@vscode/ripgrep"],
  // Surface the published version to app.getVersion() via the shim.
  define: {
    "process.env.KCODE_VERSION": JSON.stringify(cliPkg.version),
  },
  logLevel: "info",
  // No sourcemap in the published artifact (the map is ~20MB).
  sourcemap: false,
  minify: false,
});

console.log(`CLI bundled → cli/kcode-cli.cjs (v${cliPkg.version})`);

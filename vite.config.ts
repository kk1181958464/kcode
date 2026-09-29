import path from "node:path";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

// Swap the full highlight.js grammar set pulled in by @git-diff-view for a
// curated subset. Scoped to that importer so nothing else is affected.
function lowlightSubset(): Plugin {
  const subset = path.resolve(__dirname, "src/lib/lowlight-subset.ts");
  return {
    name: "kcode:lowlight-subset",
    enforce: "pre",
    resolveId(source, importer) {
      if (
        source === "lowlight" &&
        importer?.split(path.sep).join("/").includes("/@git-diff-view/")
      )
        return subset;
      return null;
    },
  };
}

export default defineConfig({
  base: "./",
  plugins: [lowlightSubset(), react()],
  server: { port: 5173, strictPort: true },
  // Preserve dynamic import boundaries with automatic chunking. Manual vendor
  // groups pulled shared dependencies into the editor/Mermaid chunks, making
  // the entry eagerly import those otherwise lazy features.
});

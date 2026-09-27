import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  base: "./",
  plugins: [react()],
  server: { port: 5173, strictPort: true },
  // Preserve dynamic import boundaries with automatic chunking. Manual vendor
  // groups pulled shared dependencies into the editor/Mermaid chunks, making
  // the entry eagerly import those otherwise lazy features.
});

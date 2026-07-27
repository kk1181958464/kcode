import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  base: "./",
  plugins: [react()],
  server: { port: 5173, strictPort: true },
  build: {
    rollupOptions: {
      output: {
        // Split heavy vendor libs into their own chunks so they cache
        // independently and don't bloat the app's critical-path bundle.
        manualChunks(id) {
          if (!id.includes("node_modules")) return;
          if (id.includes("react-markdown") || id.includes("remark"))
            return "markdown";
          if (id.includes("lucide-react")) return "icons";
          if (
            /node_modules[/\\](react|react-dom|scheduler)[/\\]/.test(id)
          )
            return "react";
        },
      },
    },
  },
});

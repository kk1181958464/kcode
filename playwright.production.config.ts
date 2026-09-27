import { defineConfig } from "@playwright/test";
import baseConfig from "./playwright.config";

const baseURL = "http://127.0.0.1:4173";

export default defineConfig({
  ...baseConfig,
  outputDir: "./artifacts/e2e-production",
  use: { ...baseConfig.use, baseURL },
  webServer: {
    command:
      "node node_modules/vite/bin/vite.js preview --host 127.0.0.1 --port 4173 --strictPort",
    url: baseURL,
    reuseExistingServer: false,
    timeout: 30_000,
  },
});

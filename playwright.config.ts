import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 60_000,
  fullyParallel: false,
  use: {
    baseURL: "http://127.0.0.1:5173",
    headless: true,
    launchOptions: {
      executablePath: "/usr/bin/google-chrome",
      args: ["--no-sandbox", "--disable-dev-shm-usage"]
    }
  },
  webServer: [
    {
      command: "MATCH_DURATION_MS=12000 PATCH_INTERVAL_MS=3000 npm run dev:server",
      url: "http://127.0.0.1:3001/health",
      reuseExistingServer: false,
      timeout: 30_000
    },
    {
      command: "npm run dev:client -- --host 127.0.0.1",
      url: "http://127.0.0.1:5173",
      reuseExistingServer: false,
      timeout: 30_000
    }
  ]
});

import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/soak",
  timeout: 11 * 60 * 1_000,
  preserveOutput: "always",
  fullyParallel: false,
  workers: 1,
  use: {
    baseURL: "http://127.0.0.1:5175",
    headless: true,
    launchOptions: {
      executablePath: "/usr/bin/google-chrome",
      args: ["--no-sandbox", "--disable-dev-shm-usage", "--enable-precise-memory-info"],
    },
  },
  webServer: [
    {
      command: "PORT=3102 MATCH_DURATION_MS=600000 PATCH_INTERVAL_MS=20000 HUMAN_SPEED_MULTIPLIER=10 npm run dev:server",
      url: "http://127.0.0.1:3102/health",
      reuseExistingServer: false,
      timeout: 30_000,
    },
    {
      command: "VITE_MATCH_WS_URL=ws://127.0.0.1:3102/ws npm run dev:client -- --host 127.0.0.1 --port 5175",
      url: "http://127.0.0.1:5175",
      reuseExistingServer: false,
      timeout: 30_000,
    },
  ],
});

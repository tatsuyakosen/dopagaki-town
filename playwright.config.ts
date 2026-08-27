import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 60_000,
  fullyParallel: false,
  use: {
    baseURL: "http://127.0.0.1:5174",
    headless: true,
    launchOptions: {
      executablePath: "/usr/bin/google-chrome",
      args: ["--no-sandbox", "--disable-dev-shm-usage"]
    }
  },
  webServer: [
    {
      command: "PORT=3101 MATCH_DURATION_MS=20000 PATCH_INTERVAL_MS=15000 HUMAN_SPEED_MULTIPLIER=100 npm run dev:server",
      url: "http://127.0.0.1:3101/health",
      reuseExistingServer: false,
      timeout: 30_000
    },
    {
      command: "VITE_MATCH_WS_URL=ws://127.0.0.1:3101/ws npm run dev:client -- --host 127.0.0.1 --port 5174",
      url: "http://127.0.0.1:5174",
      reuseExistingServer: false,
      timeout: 30_000
    }
  ]
});

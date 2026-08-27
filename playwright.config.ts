import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 60_000,
  fullyParallel: false,
  use: {
    baseURL: "http://127.0.0.1:5177",
    headless: true,
    launchOptions: {
      executablePath: "/usr/bin/google-chrome",
      args: ["--no-sandbox", "--disable-dev-shm-usage"]
    }
  },
  webServer: [
    {
      command: "PORT=3104 MATCH_DURATION_MS=40000 PATCH_INTERVAL_MS=15000 HUMAN_SPEED_MULTIPLIER=100 npm run dev:server",
      url: "http://127.0.0.1:3104/health",
      reuseExistingServer: false,
      timeout: 30_000
    },
    {
      command: "VITE_MATCH_PORT=3104 npm run dev:client -- --host 127.0.0.1 --port 5177",
      url: "http://127.0.0.1:5177",
      reuseExistingServer: false,
      timeout: 30_000
    }
  ]
});

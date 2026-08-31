import { defineConfig } from "@playwright/test";

const matches = positiveInteger(process.env.SOAK_MATCHES, 20);
const matchDurationMs = positiveInteger(process.env.SOAK_MATCH_DURATION_MS, 600_000);
const timeoutMs = matches * (matchDurationMs + 60_000) + 120_000;

export default defineConfig({
  testDir: "./tests/soak",
  testMatch: "m7-continuous.spec.ts",
  timeout: timeoutMs,
  preserveOutput: "always",
  reporter: [
    ["line"],
    ["json", { outputFile: "test-results/m7-soak-playwright.json" }],
  ],
  fullyParallel: false,
  workers: 1,
  use: {
    baseURL: "http://127.0.0.1:5179",
    headless: true,
    launchOptions: {
      executablePath: "/usr/bin/google-chrome",
      args: ["--no-sandbox", "--disable-dev-shm-usage", "--enable-precise-memory-info"],
    },
  },
  webServer: [
    {
      command: `PORT=3106 STANDARD_MATCH_DURATION_MS=${matchDurationMs} PATCH_INTERVAL_MS=20000 HUMAN_SPEED_MULTIPLIER=10 npm run dev:server`,
      url: "http://127.0.0.1:3106/health",
      reuseExistingServer: false,
      timeout: 30_000,
    },
    {
      command: "VITE_MATCH_WS_URL=ws://127.0.0.1:3106/ws npm run dev:client -- --host 127.0.0.1 --port 5179",
      url: "http://127.0.0.1:5179",
      reuseExistingServer: false,
      timeout: 30_000,
    },
  ],
});

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? String(fallback), 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

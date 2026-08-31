import { expect, test, type Locator, type Page, type TestInfo } from "@playwright/test";
import {
  classifyM7SoakGate,
  isM7PerformanceGate,
  m7SoakPerformanceViolations,
} from "../../scripts/m7-soak-policy.js";

interface BrowserPerformance extends Performance {
  memory?: { usedJSHeapSize: number };
}

interface Sample {
  fps: number;
  heapBytes: number;
  loadedChunks: number;
  activeChunks: number;
  reconciliationError: number;
}

interface MatchReport {
  match: number;
  seed: number;
  elapsedWallMs: number;
  averageFps: number;
  tenthPercentileFps: number;
  minimumFps: number;
  endingHeapBytes: number;
  maximumLoadedChunks: number;
  maximumActiveChunks: number;
  maximumReconciliationError: number;
  finalMapVersion: number;
  rollbackCount: number;
  checksumMatches: boolean;
  minimumBalanceYen: number;
}

const MATCHES = positiveInteger(process.env.SOAK_MATCHES, 20);
const MATCH_DURATION_MS = positiveInteger(process.env.SOAK_MATCH_DURATION_MS, 600_000);
const SAMPLE_MS = positiveInteger(process.env.SOAK_SAMPLE_MS, 10_000);
const PRESET = process.env.SOAK_PRESET ?? "LOW";
const RUN = { matches: MATCHES, matchDurationMs: MATCH_DURATION_MS, preset: PRESET };
const GATE = classifyM7SoakGate(RUN);

test(`${MATCHES} consecutive LOW matches remain stable`, async ({ page }, testInfo) => {
  const pageErrors: string[] = [];
  const reports: MatchReport[] = [];
  const allSamples: Sample[] = [];
  const body = page.locator("body");
  const resultPanel = page.locator("#result-panel");
  const seedLabel = page.locator("#seed-label");
  page.on("pageerror", (error) => pageErrors.push(error.message));

  await page.goto("/");
  await page.getByRole("radio", { name: /10分通常/ }).check();
  await page.getByLabel("CALL SIGN").fill("M7 Continuous Soak");
  await page.getByRole("button", { name: /入城する/ }).click();
  await expect(body).toHaveAttribute("data-match-mode", "STANDARD");
  await expect(body).toHaveAttribute("data-match-duration-ms", String(MATCH_DURATION_MS));
  await expect(body).toHaveAttribute("data-match-status", "RUNNING");
  const playerId = await body.getAttribute("data-player-id");
  expect(playerId).not.toBeNull();

  for (let matchIndex = 0; matchIndex < MATCHES; matchIndex += 1) {
    const startedAt = Date.now();
    const seed = Number(await seedLabel.textContent());
    const samples: Sample[] = [];
    const sampleCount = Math.ceil(MATCH_DURATION_MS / SAMPLE_MS);

    for (let sampleIndex = 0; sampleIndex < sampleCount; sampleIndex += 1) {
      if (await body.getAttribute("data-match-status") === "FINISHED") break;
      const key = ["w", "d", "s", "a"][(matchIndex + sampleIndex) % 4] ?? "w";
      const movementMs = Math.min(8_000, Math.max(100, Math.floor(SAMPLE_MS * 0.7)));
      await page.keyboard.down(key);
      try {
        await page.waitForTimeout(movementMs);
      } finally {
        await page.keyboard.up(key);
      }
      await page.waitForTimeout(Math.max(0, SAMPLE_MS - movementMs));
      const sample = await readSample(page);
      samples.push(sample);
      allSamples.push(sample);

      const reconnectMatch = Math.floor(MATCHES / 2);
      const reconnectSample = Math.floor(sampleCount / 2);
      if (matchIndex === reconnectMatch && sampleIndex === reconnectSample) {
        await page.evaluate(() => window.dispatchEvent(new Event("dopagaki:test-disconnect")));
        await expect(body).toHaveAttribute("data-connection-state", "OFFLINE", { timeout: 5_000 });
        await expect(body).toHaveAttribute("data-connection-state", "ONLINE", { timeout: 10_000 });
        await expect(body).toHaveAttribute("data-player-id", playerId ?? "");
      }
    }

    const finished = await resultPanel.isVisible().catch(() => false) || await resultPanel
      .waitFor({ state: "visible", timeout: Math.max(30_000, SAMPLE_MS * 2) })
      .then(() => true)
      .catch(() => false);
    if (!finished) {
      await attachReport(testInfo, "m7-continuous-soak-partial", { reports, pageErrors, deadlockedMatch: matchIndex + 1 });
      throw new Error(`Match ${matchIndex + 1} did not finish within its deadlock allowance`);
    }
    await expect(body).toHaveAttribute("data-match-status", "FINISHED");
    await expect.poll(async () => checksumMatches(body), { timeout: 5_000 }).toBe(true);

    const stableFps = finite(samples.map((sample) => sample.fps)).slice(3).sort((left, right) => left - right);
    const endingHeapBytes = average(finite(samples.slice(-3).map((sample) => sample.heapBytes)));
    const report: MatchReport = {
      match: matchIndex + 1,
      seed,
      elapsedWallMs: Date.now() - startedAt,
      averageFps: average(stableFps),
      tenthPercentileFps: percentile(stableFps, 0.1),
      minimumFps: Math.min(...stableFps),
      endingHeapBytes,
      maximumLoadedChunks: maximum(samples.map((sample) => sample.loadedChunks)),
      maximumActiveChunks: maximum(samples.map((sample) => sample.activeChunks)),
      maximumReconciliationError: maximum(samples.map((sample) => sample.reconciliationError)),
      finalMapVersion: Number((await page.locator("#map-version").textContent())?.replace("v", "")),
      rollbackCount: await numericAttribute(body, "data-rollback-count"),
      checksumMatches: await checksumMatches(body),
      minimumBalanceYen: await numericAttribute(body, "data-minimum-balance-yen"),
    };
    reports.push(report);
    await attachReport(testInfo, `match-${String(matchIndex + 1).padStart(2, "0")}`, report);

    if (matchIndex < MATCHES - 1) {
      const previousSeed = String(seed);
      await page.getByRole("button", { name: /もう一度プレイ/ }).click();
      await expect(resultPanel).toBeHidden({ timeout: 10_000 });
      await expect(body).toHaveAttribute("data-match-status", "RUNNING");
      await expect(seedLabel).not.toHaveText(previousSeed);
      await expect(body).toHaveAttribute("data-player-id", playerId ?? "");
    }
  }

  const stableAllFps = finite(allSamples.map((sample) => sample.fps)).slice(3);
  const endingHeaps = finite(reports.map((report) => report.endingHeapBytes));
  const firstHeapAverage = average(endingHeaps.slice(0, 3));
  const lastHeapAverage = average(endingHeaps.slice(-3));
  const summary = {
    gate: GATE,
    preset: PRESET,
    matchesRequested: MATCHES,
    matchesCompleted: reports.length,
    deadlockCount: 0,
    matchDurationMs: MATCH_DURATION_MS,
    averageFps: average(stableAllFps),
    tenthPercentileFps: percentile(stableAllFps, 0.1),
    minimumFps: Math.min(...stableAllFps),
    firstHeapAverage,
    lastHeapAverage,
    heapGrowth: lastHeapAverage - firstHeapAverage,
    maximumLoadedChunks: maximum(reports.map((report) => report.maximumLoadedChunks)),
    maximumActiveChunks: maximum(reports.map((report) => report.maximumActiveChunks)),
    maximumReconciliationError: maximum(reports.map((report) => report.maximumReconciliationError)),
    checksumFailures: reports.filter((report) => !report.checksumMatches).map((report) => report.match),
    rollbackMatches: reports.filter((report) => report.rollbackCount !== 0).map((report) => report.match),
    finalMapVersions: reports.map((report) => report.finalMapVersion),
    seeds: reports.map((report) => report.seed),
    reconnectCount: await numericAttribute(body, "data-reconnect-count"),
    pageErrors,
  };
  await attachReport(testInfo, "m7-continuous-soak-summary", summary);
  process.stdout.write(`M7_CONTINUOUS_SOAK_REPORT ${JSON.stringify(summary)}\n`);

  expect(reports).toHaveLength(MATCHES);
  expect(new Set(summary.seeds).size).toBe(MATCHES);
  expect(summary.maximumLoadedChunks).toBeLessThanOrEqual(25);
  expect(summary.maximumActiveChunks).toBeLessThanOrEqual(9);
  expect(summary.maximumReconciliationError).toBeLessThan(25);
  expect(summary.checksumFailures).toEqual([]);
  expect(summary.rollbackMatches).toEqual([]);
  expect(summary.finalMapVersions.every((version) => version > 1)).toBe(true);
  expect(reports.every((report) => report.minimumBalanceYen >= 0)).toBe(true);
  expect(summary.reconnectCount).toBe(1);
  expect(pageErrors).toEqual([]);
  if (isM7PerformanceGate(RUN)) {
    const violations = m7SoakPerformanceViolations(summary);
    expect(violations, violations.join("\n")).toEqual([]);
  } else {
    expect(summary.averageFps).toBeGreaterThan(0);
    expect(firstHeapAverage).toBeGreaterThan(0);
  }
});

async function readSample(page: Page): Promise<Sample> {
  const body = page.locator("body");
  return {
    fps: await numericAttribute(page.locator("#performance-label"), "data-fps"),
    heapBytes: await page.evaluate(() => (performance as BrowserPerformance).memory?.usedJSHeapSize ?? 0),
    loadedChunks: await numericAttribute(body, "data-loaded-chunks"),
    activeChunks: await numericAttribute(body, "data-active-chunks"),
    reconciliationError: await numericAttribute(body, "data-reconciliation-error"),
  };
}

async function checksumMatches(body: Locator): Promise<boolean> {
  const server = await body.getAttribute("data-map-checksum");
  const client = await body.getAttribute("data-client-map-checksum");
  return server !== null && client !== null && server.length > 0 && server === client;
}

async function numericAttribute(locator: Locator, name: string): Promise<number> {
  return Number(await locator.getAttribute(name) ?? Number.NaN);
}

async function attachReport(testInfo: TestInfo, name: string, report: unknown): Promise<void> {
  await testInfo.attach(name, {
    body: JSON.stringify(report, null, 2),
    contentType: "application/json",
  });
}

function finite(values: number[]): number[] {
  return values.filter((value) => Number.isFinite(value));
}

function average(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
}

function percentile(values: number[], ratio: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * ratio))] ?? 0;
}

function maximum(values: number[]): number {
  return Math.max(...finite(values));
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? String(fallback), 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

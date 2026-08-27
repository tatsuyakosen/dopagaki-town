import { expect, test } from "@playwright/test";

interface BrowserPerformance extends Performance {
  memory?: {
    usedJSHeapSize: number;
  };
}

test("5km streaming completes a real ten-minute match without resource growth", async ({ page }, testInfo) => {
  const pageErrors: string[] = [];
  const fpsSamples: number[] = [];
  const heapSamples: number[] = [];
  const loadedChunkSamples: number[] = [];
  const activeChunkSamples: number[] = [];
  const reconciliationSamples: number[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  await page.goto("/");
  await page.getByLabel("CALL SIGN").fill("M5 Soak Runner");
  await page.getByRole("button", { name: /入城する/ }).click();
  await expect(page.locator("body")).toHaveAttribute("data-world-size", "5000");
  await expect(page.locator("body")).toHaveAttribute("data-world-chunks", "400");
  await expect(page.locator("body")).toHaveAttribute("data-match-status", "RUNNING");
  const originalPlayerId = await page.locator("body").getAttribute("data-player-id");

  const movement = ["w", "d", "s", "a"];
  for (let sample = 0; sample < 60; sample += 1) {
    const key = movement[sample % movement.length] ?? "w";
    await page.keyboard.down(key);
    await page.waitForTimeout(8_000);
    await page.keyboard.up(key);
    await page.waitForTimeout(2_000);

    fpsSamples.push(Number(await page.locator("#performance-label").getAttribute("data-fps")));
    heapSamples.push(
      await page.evaluate(() => (performance as BrowserPerformance).memory?.usedJSHeapSize ?? 0),
    );
    loadedChunkSamples.push(Number(await page.locator("body").getAttribute("data-loaded-chunks")));
    activeChunkSamples.push(Number(await page.locator("body").getAttribute("data-active-chunks")));
    reconciliationSamples.push(Number(await page.locator("body").getAttribute("data-reconciliation-error")));
    if (sample === 29) {
      await page.evaluate(() => window.dispatchEvent(new Event("dopagaki:test-disconnect")));
      await expect(page.locator("body")).toHaveAttribute("data-connection-state", "OFFLINE");
      await expect(page.locator("body")).toHaveAttribute("data-connection-state", "ONLINE", { timeout: 10_000 });
      await expect(page.locator("body")).toHaveAttribute("data-player-id", originalPlayerId ?? "");
    }
  }

  await expect(page.locator("#result-panel")).toBeVisible({ timeout: 15_000 });
  await expect(page.locator("body")).toHaveAttribute("data-match-status", "FINISHED");
  const stableFps = fpsSamples.slice(3).sort((a, b) => a - b);
  const tenthPercentile = stableFps[Math.floor(stableFps.length * 0.1)] ?? 0;
  const averageFps = stableFps.reduce((sum, value) => sum + value, 0) / Math.max(1, stableFps.length);
  const firstHeapAverage = average(heapSamples.slice(0, 10));
  const lastHeapAverage = average(heapSamples.slice(-10));
  const heapGrowth = lastHeapAverage - firstHeapAverage;
  const report = {
    averageFps,
    tenthPercentileFps: tenthPercentile,
    minimumFps: Math.min(...stableFps),
    firstHeapAverage,
    lastHeapAverage,
    heapGrowth,
    maximumLoadedChunks: Math.max(...loadedChunkSamples),
    maximumActiveChunks: Math.max(...activeChunkSamples),
    finalMapVersion: await page.locator("#map-version").textContent(),
    rollbackCount: Number(await page.locator("body").getAttribute("data-rollback-count")),
    checksumMatches:
      (await page.locator("body").getAttribute("data-client-map-checksum")) ===
      (await page.locator("body").getAttribute("data-map-checksum")),
    reconnectCount: Number(await page.locator("body").getAttribute("data-reconnect-count")),
    latencyP95Ms: Number(await page.locator("body").getAttribute("data-latency-p95")),
    maximumReconciliationError: Math.max(...reconciliationSamples),
  };
  await testInfo.attach("m5-soak-report", {
    body: JSON.stringify(report, null, 2),
    contentType: "application/json",
  });
  process.stdout.write(`M5_SOAK_REPORT ${JSON.stringify(report)}\n`);

  expect(pageErrors).toEqual([]);
  expect(averageFps).toBeGreaterThanOrEqual(20);
  expect(tenthPercentile).toBeGreaterThanOrEqual(18);
  expect(heapGrowth).toBeLessThan(64 * 1024 * 1024);
  expect(report.maximumLoadedChunks).toBeLessThanOrEqual(25);
  expect(report.maximumActiveChunks).toBeLessThanOrEqual(9);
  expect(report.finalMapVersion).not.toBe("v1");
  expect(report.rollbackCount).toBe(0);
  expect(report.checksumMatches).toBe(true);
  expect(report.reconnectCount).toBe(1);
  expect(report.latencyP95Ms).toBeLessThanOrEqual(150);
  expect(report.maximumReconciliationError).toBeLessThan(25);
});

function average(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
}

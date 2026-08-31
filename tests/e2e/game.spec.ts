import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

async function moveIntoNearestStation(page: Page): Promise<void> {
  const body = page.locator("body");
  const position = page.locator("#player-position");
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const distance = Number(await body.getAttribute("data-nearest-station-distance"));
    if (distance <= 80) break;
    const x = Number(await position.getAttribute("data-x"));
    const z = Number(await position.getAttribute("data-z"));
    const targetX = Number(await body.getAttribute("data-nearest-station-x"));
    const targetZ = Number(await body.getAttribute("data-nearest-station-z"));
    const dx = targetX - x;
    const dz = targetZ - z;
    const key = Math.abs(dx) >= Math.abs(dz)
      ? dx >= 0 ? "d" : "a"
      : dz >= 0 ? "s" : "w";
    await page.keyboard.down(key);
    await page.waitForTimeout(120);
    await page.keyboard.up(key);
    await page.waitForTimeout(120);
  }
  await expect(body).not.toHaveAttribute("data-current-station-id", "", { timeout: 3_000 });
}

test("players can reserve rail, reconnect, arrive, move, verify CITY CORE, and finish", async ({ page, browser }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  await page.goto("/");
  await expect(page.getByRole("heading", { name: /街が/ })).toBeVisible();
  await page.screenshot({ path: "test-results/guest-entry.png", fullPage: true });
  await page.getByRole("radio", { name: /3分デモ/ }).check();
  await expect(page.getByLabel("CALL SIGN")).toHaveValue("");
  await page.getByRole("button", { name: /入城する/ }).click();

  await expect(page.locator("#hud")).toBeVisible();
  await expect(page.locator("#score-list li")).toHaveCount(4);
  await expect(page.locator("#score-list")).toContainText("Guest");
  await expect(page.locator("body")).toHaveAttribute("data-match-status", "RUNNING");
  await expect(page.locator("body")).toHaveAttribute("data-match-mode", "DEMO");
  await expect(page.locator("body")).toHaveAttribute("data-match-duration-ms", "75000");
  await expect(page.locator("#seed-label")).toHaveText("20260827");
  await expect(page.locator("body")).toHaveAttribute("data-world-size", "5000");
  await expect(page.locator("body")).toHaveAttribute("data-world-chunks", "400");
  await expect(page.locator("body")).toHaveAttribute("data-active-chunks", "9");
  await expect(page.locator("body")).toHaveAttribute("data-preloaded-chunks", "25");
  await expect(page.locator("body")).toHaveAttribute("data-loaded-chunks", "25");
  await expect(page.locator("body")).toHaveAttribute("data-navigation-mode", "GRAPH_COLLIDER");
  await expect(page.locator("body")).toHaveAttribute("data-human-players", "1");
  const originalPlayerId = await page.locator("body").getAttribute("data-player-id");
  expect(originalPlayerId).not.toBeNull();

  await moveIntoNearestStation(page);
  const originStationId = await page.locator("body").getAttribute("data-current-station-id");
  await expect(page.locator("#transit-action")).toBeEnabled();
  await page.locator("#transit-action").click();
  await expect(page.locator("body")).toHaveAttribute("data-transit-phase", "WAITING");
  const reservationId = await page.locator("body").getAttribute("data-reservation-id");
  expect(reservationId).not.toBe("");
  expect(Number(await page.locator("body").getAttribute("data-reserved-fare-yen"))).toBeGreaterThan(0);

  const secondContext = await browser.newContext({ baseURL: new URL(page.url()).origin });
  const secondPage = await secondContext.newPage();
  secondPage.on("pageerror", (error) => pageErrors.push(error.message));
  await secondPage.goto("/");
  await secondPage.getByRole("radio", { name: /10分通常/ }).check();
  await secondPage.getByLabel("CALL SIGN").fill("Second Runner");
  await secondPage.getByRole("button", { name: /入城する/ }).click();
  await expect(secondPage.locator("#hud")).toBeVisible();
  await expect(secondPage.locator("body")).toHaveAttribute("data-match-mode", "DEMO");
  await expect(page.locator("#score-list")).toContainText("Second Runner");
  await expect(page.locator("body")).toHaveAttribute("data-human-players", "2");
  await expect(secondPage.locator("#score-list")).toContainText("Guest");
  await secondContext.close();

  await page.evaluate(() => window.dispatchEvent(new Event("dopagaki:test-disconnect")));
  await expect(page.locator("body")).toHaveAttribute("data-connection-state", "OFFLINE", { timeout: 5_000 });
  await page.waitForTimeout(500);
  await expect(page.locator("body")).toHaveAttribute("data-connection-state", "ONLINE", { timeout: 10_000 });
  await expect(page.locator("body")).toHaveAttribute("data-player-id", originalPlayerId ?? "");
  await expect(page.locator("body")).toHaveAttribute("data-reservation-id", reservationId ?? "");

  await page.reload();
  await expect(page.locator("#hud")).toBeVisible({ timeout: 10_000 });
  await expect(page.locator("body")).toHaveAttribute("data-connection-state", "ONLINE");
  await expect(page.locator("body")).toHaveAttribute("data-player-id", originalPlayerId ?? "");
  await expect(page.locator("body")).toHaveAttribute("data-reconnect-count", "1");
  await expect(page.locator("body")).toHaveAttribute("data-reservation-id", reservationId ?? "");
  await expect(page.locator("#score-list li")).toHaveCount(4);
  await expect(page.locator("#score-list")).toContainText("Second Runner [RECONNECTING]");

  await expect
    .poll(async () => Number(await page.locator("body").getAttribute("data-balance-yen")), { timeout: 20_000 })
    .toBeLessThan(1_000);
  await expect(page.locator("body")).toHaveAttribute("data-transit-phase", "IN_TRANSIT");
  await expect(page.locator("body")).toHaveAttribute("data-reservation-id", "", { timeout: 25_000 });
  await expect(page.locator("body")).not.toHaveAttribute("data-current-station-id", originStationId ?? "");

  const warning = page.locator("#patch-warning");
  await expect(warning).toBeVisible({ timeout: 12_000 });
  await expect(page.locator("#patch-operation")).not.toHaveText("");
  await expect(page.locator("#patch-reason")).not.toHaveText("");
  await expect(page.locator("#patch-effect")).toContainText("encounter");
  let warningSeconds = Number.parseFloat((await page.locator("#patch-countdown").textContent()) ?? "0");
  if (warningSeconds < 5) {
    await expect(warning).toBeHidden({ timeout: 8_000 });
    await expect(warning).toBeVisible({ timeout: 12_000 });
    warningSeconds = Number.parseFloat((await page.locator("#patch-countdown").textContent()) ?? "0");
  }
  expect(warningSeconds).toBeGreaterThanOrEqual(5);
  await page.screenshot({ path: "test-results/city-core-warning.png", fullPage: true });
  await expect(page.locator("#map-version")).not.toHaveText("v1", { timeout: 8_000 });
  await expect
    .poll(
      async () => {
        const body = page.locator("body");
        return (await body.getAttribute("data-client-map-checksum")) ===
          (await body.getAttribute("data-map-checksum"));
      },
      { timeout: 5_000 },
    )
    .toBe(true);
  await expect(page.locator("body")).toHaveAttribute("data-rollback-count", "0");
  await expect
    .poll(async () => Number(await page.locator("body").getAttribute("data-ai-replay-rejections")), { timeout: 5_000 })
    .toBeGreaterThan(0);
  await page.locator("#ai-replay-toggle").click();
  await expect(page.locator("#ai-replay-panel")).toBeVisible();
  await expect(page.locator("#ai-replay-list .replay-entry")).not.toHaveCount(0);
  await expect(page.locator("#ai-replay-list")).toContainText("拒否 F-06");
  await expect(page.locator("#ai-replay-list")).toContainText("採用");
  await expect(page.locator("#ai-replay-list")).toContainText("乗車確定");
  await expect(page.locator("#ai-replay-cost")).toContainText("¥");
  await page.screenshot({ path: "test-results/ai-replay.png", fullPage: true });
  await page.locator("#ai-replay-close").click();
  await expect(page.locator("#ai-replay-panel")).toBeHidden();
  await expect
    .poll(async () => Number(await page.locator("body").getAttribute("data-latency-p95")), { timeout: 8_000 })
    .toBeLessThanOrEqual(150);

  const position = page.locator("#player-position");
  const before = Number(await position.getAttribute("data-z"));
  await page.keyboard.down("s");
  await expect.poll(async () => Number(await position.getAttribute("data-z")), { timeout: 5_000 }).toBeGreaterThan(before + 50);
  await page.keyboard.up("s");
  const outbound = Number(await position.getAttribute("data-z"));
  expect(Number(await page.locator("body").getAttribute("data-loaded-chunks"))).toBeLessThanOrEqual(25);
  expect(Number(await page.locator("body").getAttribute("data-active-chunks"))).toBeLessThanOrEqual(9);

  await page.keyboard.down("w");
  await expect.poll(async () => Number(await position.getAttribute("data-z")), { timeout: 5_000 }).toBeLessThan(outbound - 50);
  await page.keyboard.up("w");
  expect(Number(await page.locator("body").getAttribute("data-loaded-chunks"))).toBeLessThanOrEqual(25);
  expect(Number(await page.locator("body").getAttribute("data-active-chunks"))).toBeLessThanOrEqual(9);

  await expect
    .poll(async () => Number(await page.locator("#performance-label").getAttribute("data-fps")), { timeout: 10_000 })
    .toBeGreaterThan(20);
  await page.screenshot({ path: "test-results/gameplay.png", fullPage: true });
  await expect(page.locator("#result-panel")).toBeVisible({ timeout: 50_000 });
  await expect(page.locator("body")).toHaveAttribute("data-match-status", "FINISHED");
  await expect(page.getByRole("button", { name: /もう一度プレイ/ })).toBeVisible();
  expect(pageErrors).toEqual([]);
});

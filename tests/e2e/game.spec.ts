import { expect, test } from "@playwright/test";

test("players can enter, move, verify a CITY CORE patch, and finish a match", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  await page.goto("/");
  await expect(page.getByRole("heading", { name: /街が/ })).toBeVisible();
  await page.getByLabel("CALL SIGN").fill("E2E Runner");
  await page.getByRole("button", { name: /入城する/ }).click();

  await expect(page.locator("#hud")).toBeVisible();
  await expect(page.locator("#score-list li")).toHaveCount(4);
  await expect(page.locator("body")).toHaveAttribute("data-match-status", "RUNNING");
  await expect(page.locator("body")).toHaveAttribute("data-world-size", "5000");
  await expect(page.locator("body")).toHaveAttribute("data-world-chunks", "400");
  await expect(page.locator("body")).toHaveAttribute("data-active-chunks", "9");
  await expect(page.locator("body")).toHaveAttribute("data-preloaded-chunks", "25");
  await expect(page.locator("body")).toHaveAttribute("data-loaded-chunks", "25");
  await expect(page.locator("body")).toHaveAttribute("data-navigation-mode", "GRAPH_COLLIDER");

  const secondPage = await page.context().newPage();
  secondPage.on("pageerror", (error) => pageErrors.push(error.message));
  await secondPage.goto("/");
  await secondPage.getByLabel("CALL SIGN").fill("Second Runner");
  await secondPage.getByRole("button", { name: /入城する/ }).click();
  await expect(secondPage.locator("#hud")).toBeVisible();
  await expect(page.locator("#score-list")).toContainText("Second Runner");
  await expect(secondPage.locator("#score-list")).toContainText("E2E Runner");
  await secondPage.close();

  const warning = page.locator("#patch-warning");
  await expect(warning).toBeVisible({ timeout: 12_000 });
  await expect(page.locator("#patch-operation")).not.toHaveText("");
  await expect(page.locator("#patch-reason")).not.toHaveText("");
  await expect(page.locator("#patch-effect")).toContainText("encounter");
  const warningSeconds = Number.parseFloat((await page.locator("#patch-countdown").textContent()) ?? "0");
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

  const position = page.locator("#player-position");
  const before = Number(await position.getAttribute("data-z"));
  await page.keyboard.down("w");
  await expect.poll(async () => Number(await position.getAttribute("data-z")), { timeout: 7_000 }).toBeLessThan(-2_400);
  await page.keyboard.up("w");
  expect(Number(await position.getAttribute("data-z"))).not.toBe(before);
  expect(Number(await page.locator("body").getAttribute("data-loaded-chunks"))).toBeLessThanOrEqual(25);
  expect(Number(await page.locator("body").getAttribute("data-active-chunks"))).toBeLessThanOrEqual(9);

  await page.keyboard.down("s");
  await expect.poll(async () => Number(await position.getAttribute("data-z")), { timeout: 7_000 }).toBeGreaterThan(2_400);
  await page.keyboard.up("s");
  expect(Number(await page.locator("body").getAttribute("data-loaded-chunks"))).toBeLessThanOrEqual(25);
  expect(Number(await page.locator("body").getAttribute("data-active-chunks"))).toBeLessThanOrEqual(9);

  await expect
    .poll(async () => Number(await page.locator("#performance-label").getAttribute("data-fps")), { timeout: 10_000 })
    .toBeGreaterThan(20);
  await page.screenshot({ path: "test-results/gameplay.png", fullPage: true });
  await expect(page.locator("#result-panel")).toBeVisible({ timeout: 30_000 });
  await expect(page.locator("body")).toHaveAttribute("data-match-status", "FINISHED");
  await expect(page.getByRole("button", { name: /もう一度プレイ/ })).toBeVisible();
  expect(pageErrors).toEqual([]);
});

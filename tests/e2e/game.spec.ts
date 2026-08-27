import { expect, test } from "@playwright/test";

test("players can enter, move, observe CITY CORE, and finish a match", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  await page.goto("/");
  await expect(page.getByRole("heading", { name: /街が/ })).toBeVisible();
  await page.getByLabel("CALL SIGN").fill("E2E Runner");
  await page.getByRole("button", { name: /入城する/ }).click();

  await expect(page.locator("#hud")).toBeVisible();
  await expect(page.locator("#score-list li")).toHaveCount(4);
  await expect(page.locator("body")).toHaveAttribute("data-match-status", "RUNNING");

  const secondPage = await page.context().newPage();
  secondPage.on("pageerror", (error) => pageErrors.push(error.message));
  await secondPage.goto("/");
  await secondPage.getByLabel("CALL SIGN").fill("Second Runner");
  await secondPage.getByRole("button", { name: /入城する/ }).click();
  await expect(secondPage.locator("#hud")).toBeVisible();
  await expect(page.locator("#score-list")).toContainText("Second Runner");
  await expect(secondPage.locator("#score-list")).toContainText("E2E Runner");

  const position = page.locator("#player-position");
  const before = Number(await position.getAttribute("data-z"));
  await page.keyboard.down("w");
  await page.waitForTimeout(900);
  await page.keyboard.up("w");
  await expect.poll(async () => Number(await position.getAttribute("data-z"))).not.toBe(before);

  await expect(page.locator("#map-version")).not.toHaveText("v1", { timeout: 6_000 });
  await page.screenshot({ path: "test-results/gameplay.png", fullPage: true });
  await expect(page.locator("#result-panel")).toBeVisible({ timeout: 20_000 });
  await expect(secondPage.locator("#result-panel")).toBeVisible({ timeout: 20_000 });
  await expect(page.locator("body")).toHaveAttribute("data-match-status", "FINISHED");
  await expect(page.getByRole("button", { name: /もう一度プレイ/ })).toBeVisible();
  expect(pageErrors).toEqual([]);
});

import { expect, test } from "@playwright/test";

// e2e fixture: one KINDRED prediction (lens Seneca) whose check-in date passed yesterday (seed-fixture-corpus.ts).
test("a past-due prediction shows as check-in due on home → rate it → the track record updates", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("checkin-due")).toContainText("1 check-in due");
  await page.getByRole("link", { name: /Rate how the Hive's predictions turned out/ }).click();
  await expect(page).toHaveURL(/\/predictions$/);
  await expect(page.getByTestId("track-voice")).toContainText("No checked-in outcomes yet.");

  const form = page.getByTestId("checkin");
  await expect(form).toContainText("The operator will follow up within a day.");
  await form.getByLabel("4").check();
  await form.getByLabel(/Note/).fill("they did");
  await form.getByRole("button", { name: "Save check-in" }).click();

  await expect(page.getByTestId("due")).toContainText("Nothing is due.");
  await expect(page.getByTestId("track-voice")).toContainText("KINDRED: 1 time: 1 held, 0 did not.");
  await expect(page.getByTestId("track-mentor")).toContainText("Seneca: 1 time: 1 held, 0 did not.");
  await expect(page.getByTestId("track-record")).toContainText("Small numbers, many other factors. A hint, not a verdict.");

  await page.goto("/");
  await expect(page.getByTestId("checkin-due")).toHaveCount(0);
});

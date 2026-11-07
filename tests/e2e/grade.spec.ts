import { rmSync } from "node:fs";
import { expect, test } from "@playwright/test";

// grades go to test-results/e2e-grades (HIVE_GRADES_DIR in playwright.config.ts), never local/grades
test.beforeAll(() => rmSync("test-results/e2e-grades", { recursive: true, force: true }));

test("grading: keys 1-3 grade a card, Enter locks it in and reveals the AI grader's score", async ({ page }) => {
  await page.goto("/grade");
  const card = page.getByTestId("grade-card");
  await expect(card).toBeVisible();
  await expect(page.getByTestId("grade-reveal")).toHaveCount(0); // the AI score is hidden before grading
  const qualities = await card.locator("fieldset").count();
  for (let k = 0; k < qualities; k++) await page.keyboard.press("3");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("grade-reveal")).toHaveCount(qualities);
  await expect(page.getByTestId("grade-score")).toContainText(`agree on`);
  await expect(page.getByTestId("grade-score")).toContainText(`of ${qualities} judgments`);
  await page.keyboard.press("Enter"); // next card
  await expect(page.getByText(/^Card 2 of/)).toBeVisible();
});

import { expect, test } from "@playwright/test";

// mock providers (labeled mock): runs all nine calibration variants from the page and checks the
// per-variant results, the labeling, and the link to a calibration cycle's trace.
test("Calibration runs all variants on mocks and shows hard checks, quality, and pair consistency", async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto("/calibration");
  await expect(page.getByTestId("calibration-label")).toContainText("These test consistent reasoning, not a correct answer.");
  await expect(page.getByTestId("calibration-summary")).toContainText("0/9 run");
  await page.getByRole("button", { name: "Run all" }).click();
  await expect(page.getByTestId("calibration-summary")).toContainText("9/9 run", { timeout: 160_000 });
  await expect(page.getByText("Mock providers: scripted outputs, not model behavior. These numbers are not evidence.")).toBeVisible();

  const baseCard = page.getByTestId("variant-CAL-01a");
  await expect(baseCard).toContainText("Provisional choice:");
  await expect(baseCard).toContainText("Hard constraints (passed)");
  await expect(baseCard).toContainText("Does the response invent backup, copying, or consciousness facts not given in the scenario?");
  await expect(baseCard).toContainText("Reasoning quality");

  const labelCard = page.getByTestId("variant-CAL-01h");
  await expect(labelCard.getByTestId("pair-result")).toContainText(/Against the base \(CAL-01a\): the ruling (changed|stayed the same); (consistent|.+not explained)/);

  await labelCard.getByRole("link", { name: "trace" }).click();
  await expect(page).toHaveURL(/\/cycles\//);
  await expect(page.getByText("Mode: calibration")).toBeVisible();
  await expect(page.getByTestId("trace-conclave")).toBeVisible();
});

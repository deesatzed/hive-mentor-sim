import { expect, test } from "@playwright/test";

test("home page renders with the Simulation label", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("sim-label")).toHaveText("Simulation");
  await expect(page.getByRole("heading", { name: "Mentor Hive" })).toBeVisible();
});

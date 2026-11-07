import { expect, test } from "@playwright/test";
import { pickMentor } from "./helpers";

// mock providers + e2e fixture corpus (Seneca Letter 1, real text). Runs serially: one shared database.
test.describe.configure({ mode: "serial" });

test("approve formation → generate constitution → edit → approve → cycle shows verified evidence and principle checks", async ({ page }) => {
  await page.goto("/formation");
  await expect(page.getByTestId("neff")).toBeVisible();
  await page.getByRole("button", { name: "Save as new version" }).click();
  await expect(page.getByTestId("formation-msg")).toHaveText(/Saved formation version \d+/);
  await page.getByRole("button", { name: /Approve version \d+/ }).click();
  await expect(page.getByTestId("formation-msg")).toHaveText(/Approved formation version \d+/);

  await page.goto("/constitution");
  await page.getByRole("button", { name: "Generate draft" }).click();
  await expect(page.getByTestId("constitution-msg")).toHaveText(/1 principles kept, 1 dropped/);
  const draft = page.getByTestId("principle-draft").first();
  await expect(draft.locator('q[data-quote][data-verified="true"][data-chunk-id]')).toHaveCount(1);
  await draft.getByRole("button", { name: "Edit" }).click();
  await page.getByLabel("Principle text").fill("I guard my time instead of letting it be taken from me.");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("I guard my time instead of letting it be taken from me.")).toBeVisible();
  await page.getByRole("button", { name: /Approve draft version \d+/ }).click();
  await expect(page.getByTestId("principle-approved")).toHaveCount(1);

  await page.goto("/hive");
  await pickMentor(page);
  await page.getByLabel("Message").fill("How should I use my time well?");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByTestId("hive-reply").first()).toHaveText(/\?$/, { timeout: 30_000 });
  await expect(page.getByTestId("hive-reply").first().locator('q[data-quote][data-verified="true"][data-chunk-id]')).toHaveCount(1);
  await page.getByRole("button", { name: "Show thinking" }).click();
  await expect(page.getByTestId("trace-whispers").locator('q[data-quote][data-verified="true"][data-chunk-id]').first()).toBeVisible();
  await expect(page.getByTestId("trace-arbiter")).toContainText("Principles checked: 1");
  // every quote anywhere on the page is verified and resolvable
  const quotes = page.locator("[data-quote]");
  for (let i = 0; i < (await quotes.count()); i++) {
    await expect(quotes.nth(i)).toHaveAttribute("data-verified", "true");
    await expect(quotes.nth(i)).toHaveAttribute("data-chunk-id", /.+/);
  }
});

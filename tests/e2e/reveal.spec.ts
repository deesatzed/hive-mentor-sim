import { expect, test } from "@playwright/test";

// mock providers + e2e fixture corpus and fixture mentor answers. Runs after constitution.spec (approved
// formation and constitution exist), so all three comparisons have data.
test("Reveal runs all dilemmas on mocks and renders the three comparisons with links to traces", async ({ page }) => {
  test.setTimeout(240_000);
  await page.goto("/reveal");
  await expect(page.getByTestId("reveal-progress")).toHaveText("0/40");
  await page.getByRole("button", { name: "Run Reveal" }).click();
  await expect(page.getByTestId("reveal-progress")).toHaveText("40/40", { timeout: 220_000 });

  await expect(page.getByText("Mock providers: scripted outputs, not model behavior. These numbers are not evidence.")).toBeVisible();
  await expect(page.getByTestId("reveal-headline")).toContainText("The Hive was built mostly from Seneca");
  // Hive vs. mentors: Seneca has fixture evidence on all 40 dilemmas → a k/40 rate and κ
  const mentors = page.getByTestId("reveal-mentors");
  await expect(mentors.getByRole("row", { name: /Seneca.*\d+\/40/ })).toBeVisible();
  // Each Voice vs. its own mentors
  await expect(page.getByTestId("reveal-voices")).toContainText(/was given Seneca; its ballots matched their evidenced choices on \d+\/\d+\./);
  await expect(page.getByTestId("voice-neff")).toHaveText(/^\d+\.\d$/);
  // Constitution mirror (constitution approved by constitution.spec)
  await expect(page.getByTestId("reveal-mirror")).toContainText(/Your Hive's constitution would have chosen differently on \d+ of 40\./);

  // every quote on the page is a verified mentor evidence quote
  await mentors.locator("details").first().locator("summary").click();
  const quotes = page.locator("[data-quote]");
  expect(await quotes.count()).toBeGreaterThan(0);
  for (const q of await quotes.all()) {
    await expect(q).toHaveAttribute("data-verified", "true");
    await expect(q).toHaveAttribute("data-chunk-id", /\S+/);
  }

  // a ruling links to its full cycle trace
  await page.getByRole("link", { name: "trace" }).first().click();
  await expect(page).toHaveURL(/\/cycles\//);
  await expect(page.getByText("Mode: ruling")).toBeVisible();
  await expect(page.getByTestId("trace-conclave")).toBeVisible();
});

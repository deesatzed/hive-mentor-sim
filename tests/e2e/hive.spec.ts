import { expect, test } from "@playwright/test";

test("a chat turn returns a listening-first reply with an expandable trace (mock providers)", async ({ page }) => {
  await page.goto("/hive");
  await page.getByLabel("Message").fill("I'm thinking of quitting my job.");
  await page.getByRole("button", { name: "Send" }).click();
  const reply = page.getByTestId("hive-reply").first();
  await expect(reply).toHaveText(/\?$/, { timeout: 30_000 });
  await page.getByRole("button", { name: "Show thinking" }).click();
  for (const s of ["perceive", "whispers", "attention", "awareness", "conclave", "witness", "arbiter", "compose", "reflect"]) {
    await expect(page.getByTestId(`trace-${s}`)).toBeVisible();
  }
  await expect(page.getByText("Mock providers: scripted outputs, not model behavior.")).toBeVisible();
  // every quote rendered anywhere must be verified and carry a chunk id (none expected before the corpus exists)
  const quotes = page.locator("[data-quote]");
  const n = await quotes.count();
  for (let i = 0; i < n; i++) {
    await expect(quotes.nth(i)).toHaveAttribute("data-verified", "true");
    await expect(quotes.nth(i)).toHaveAttribute("data-chunk-id", /.+/);
  }
});

test("the Conclave table appears for a conflicting question", async ({ page }) => {
  await page.goto("/hive");
  await page.getByLabel("Message").fill("Should I forgive my brother who betrayed me?");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByTestId("hive-reply").first()).toHaveText(/\?$/, { timeout: 30_000 });
  await page.getByRole("button", { name: "Show thinking" }).click();
  await expect(page.getByTestId("trace-conclave").getByText("Decision PASS")).toBeVisible();
});

test("interoception shows the register and the Commitment Ledger after a commitment is made", async ({ page }) => {
  await page.goto("/hive");
  await page.getByLabel("Message").fill("I prefer concise answers, please.");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByTestId("hive-reply").first()).toHaveText(/concise/, { timeout: 30_000 });
  await page.goto("/interoception");
  await expect(page.getByTestId("intero-samples").locator("tbody tr").first()).toBeVisible();
  await expect(page.getByTestId("intero-commitments")).toContainText("Keep answers concise for this operator.");
});

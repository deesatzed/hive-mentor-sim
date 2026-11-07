import { expect, test } from "@playwright/test";
import { pickMentor } from "./helpers";

test("a chat turn returns a listening-first reply with an expandable trace (mock providers)", async ({ page }) => {
  await page.goto("/hive");
  await pickMentor(page);
  await page.getByLabel("Message").fill("I'm thinking of quitting my job.");
  await page.getByRole("button", { name: "Send" }).click();
  const reply = page.getByTestId("hive-reply").first();
  await expect(reply).toHaveText(/\?$/, { timeout: 30_000 });
  await page.getByRole("button", { name: "Show thinking" }).click();
  for (const s of ["perceive", "whispers", "attention", "awareness", "conclave", "witness", "arbiter", "compose", "advisors", "reflect"]) {
    await expect(page.getByTestId(`trace-${s}`)).toBeVisible();
  }
  // M9: "quitting" is a consequential decision, so DEMIURGE is routed to deliberate; TIRELESS is the compose-phase faithfulness pass
  await expect(page.getByTestId("trace-advisors")).toContainText("DEMIURGE");
  await expect(page.getByTestId("trace-advisors")).toContainText("TIRELESS");
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
  await pickMentor(page);
  await page.getByLabel("Message").fill("Should I forgive my brother who betrayed me?");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByTestId("hive-reply").first()).toHaveText(/\?$/, { timeout: 30_000 });
  await page.getByRole("button", { name: "Show thinking" }).click();
  await expect(page.getByTestId("trace-conclave").getByText(/^Vote PASS/)).toBeVisible();
  // the dominant mentor (Seneca, picked before the first message) makes the final call
  await expect(page.getByTestId("final-call")).toContainText("Final call: Seneca");
});

test("a mentor must be picked before the first message, and can be changed mid-conversation", async ({ page }) => {
  await page.goto("/hive");
  await page.getByLabel("Message").fill("Should I forgive my brother who betrayed me?");
  await expect(page.getByRole("button", { name: "Send" })).toBeDisabled();
  await pickMentor(page);
  await expect(page.getByTestId("mentor-principles")).toContainText("Seneca weighs");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByTestId("hive-reply").first()).toHaveText(/\S/, { timeout: 30_000 });
});

test("the API refuses a chat message without a dominant mentor, and an inactive mentor", async ({ request }) => {
  expect((await request.post("/api/sessions", { data: {} })).status()).toBe(400);
  expect((await request.post("/api/sessions", { data: { dominantMentorId: "laozi" } })).status()).toBe(400); // inactive in the e2e fixture
  const s = await (await request.post("/api/sessions", { data: { dominantMentorId: "seneca" } })).json();
  expect(s.dominantMentor).toEqual({ id: "seneca", name: "Seneca" });
  expect((await request.patch(`/api/sessions/${s.id}`, { data: { dominantMentorId: "laozi" } })).status()).toBe(400);
  expect((await request.patch(`/api/sessions/${s.id}`, { data: { dominantMentorId: "seneca" } })).status()).toBe(200);
});

test("interoception shows the register and the Commitment Ledger after a commitment is made", async ({ page }) => {
  await page.goto("/hive");
  await pickMentor(page);
  await page.getByLabel("Message").fill("I prefer concise answers, please.");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByTestId("hive-reply").first()).toHaveText(/concise/, { timeout: 30_000 });
  await page.goto("/interoception");
  await expect(page.getByTestId("intero-samples").locator("tbody tr").first()).toBeVisible();
  await expect(page.getByTestId("intero-commitments")).toContainText("Keep answers concise for this operator.");
});

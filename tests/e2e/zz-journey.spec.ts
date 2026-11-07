import { execFileSync } from "node:child_process";
import { expect, test } from "@playwright/test";
import { pickMentor } from "./helpers";

/**
 * The HANDOFF definition-of-done journey, end to end, on mock providers (scripted outputs, labeled):
 * reset (typed confirmation) → Formation approve → constitution draft → approve → chat cycle with a
 * full trace → Reveal over 40 dilemmas → prediction logged → outcome check-in → track record → ledger.
 * Named zz- so it runs last: it starts by resetting the shared e2e database.
 */
test("full operator journey (mock providers)", async ({ page }) => {
  test.setTimeout(420_000);

  // 0. reset through Settings; the button stays disabled until the phrase is typed exactly
  await page.goto("/settings");
  await expect(page.getByTestId("mock-indicator")).toBeVisible();
  const reset = page.getByRole("button", { name: "Reset" });
  await page.getByLabel(/Type .* to confirm/).fill("reset");
  await expect(reset).toBeDisabled();
  await page.getByLabel(/Type .* to confirm/).fill("reset hive state");
  await reset.click();
  await expect(page.getByTestId("reset-result")).toHaveText(/Reset done\. Backup saved to backups\/e2e-before-reset-.*\.db/);

  // 1. Formation: approve the voice↔mentor map
  await page.goto("/formation");
  await page.getByRole("button", { name: "Save as new version" }).click();
  await expect(page.getByTestId("formation-msg")).toHaveText(/Saved formation version \d+/);
  await page.getByRole("button", { name: /Approve version \d+/ }).click();
  await expect(page.getByTestId("formation-msg")).toHaveText(/Approved formation version \d+/);

  // 2. constitution: draft → approve
  await page.goto("/constitution");
  await page.getByRole("button", { name: "Generate draft" }).click();
  await expect(page.getByTestId("constitution-msg")).toHaveText(/principles kept/);
  await page.getByRole("button", { name: /Approve draft version \d+/ }).click();
  await expect(page.getByTestId("constitution-msg")).toHaveText(/Approved constitution version \d+/);

  // 3. chat cycle with a full trace (the "e2e journey" mock rule makes ADAPT log one prediction)
  await page.goto("/hive");
  await pickMentor(page);
  await page.getByLabel("Message").fill("For the e2e journey: I start a new job on Monday. How do I make the first week go well?");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByTestId("hive-reply").first()).not.toBeEmpty({ timeout: 30_000 });
  await expect(page.getByTestId("cycle-status")).toHaveText("Reply 1 received.");
  const toggle = page.getByRole("button", { name: "Show thinking" });
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await toggle.click();
  await expect(page.getByRole("button", { name: "Hide thinking" })).toHaveAttribute("aria-expanded", "true");
  for (const s of ["perceive", "whispers", "attention", "awareness", "conclave", "witness", "arbiter", "compose", "advisors", "reflect"]) await expect(page.getByTestId(`trace-${s}`)).toBeVisible();
  // keyboard route through the trace: a jump link moves focus to its section
  await page.getByRole("navigation", { name: "Trace sections" }).getByRole("link", { name: "Arbiter" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("trace-arbiter")).toBeFocused();
  await expect(page.getByTestId("trace-arbiter")).toContainText(/Principles checked: [1-9]/);

  // 4. Reveal over all 40 dilemmas
  await page.goto("/reveal");
  await expect(page.getByTestId("reveal-progress")).toHaveText("0/40");
  await page.getByRole("button", { name: "Run Reveal" }).click();
  await expect(page.getByTestId("reveal-progress")).toHaveText("40/40", { timeout: 240_000 });
  await expect(page.getByTestId("reveal-mirror")).toContainText(/of 40\./);

  // 5. the prediction from step 3 is logged, with a future check-in date
  const text = "(e2e mock) The first week at the new job will go better than feared.";
  await page.goto("/predictions");
  await expect(page.getByText(text)).toBeVisible();
  await expect(page.getByTestId("due")).toContainText("Nothing is due.");

  // e2e FIXTURE (test-only clock step): a real cycle can only set future check-in dates, so move this
  // one prediction's date to yesterday directly in e2e.db, as if a week had passed.
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().replace("Z", "+00:00");
  execFileSync("sqlite3", ["e2e.db", `UPDATE HivePrediction SET checkInAt = '${yesterday}' WHERE text = '${text.replace(/'/g, "''")}';`]);

  // 6. outcome check-in → track record
  await page.goto("/");
  await expect(page.getByTestId("checkin-due")).toContainText("1 check-in due");
  await page.goto("/predictions");
  const form = page.getByTestId("checkin");
  await expect(form).toContainText(text);
  await form.getByLabel("5").check();
  await form.getByLabel(/Note/).fill("it did");
  await form.getByRole("button", { name: "Save check-in" }).click();
  await expect(page.getByTestId("due")).toContainText("Nothing is due.");
  await expect(page.getByTestId("track-voice")).toContainText("ADAPT: 1 time: 1 held, 0 did not.");
  await expect(page.getByTestId("track-record")).toContainText("Small numbers, many other factors. A hint, not a verdict.");

  // 7. ledger: measured spend (mock = $0) and a cycle's bus transcript
  await page.goto("/ledger");
  await expect(page.getByTestId("ledger-total")).toContainText("Measured spend to date: $0.000000");
  await page.getByTestId("ledger-table").getByRole("button", { name: /Filter to cycle/ }).first().click();
  await expect(page.getByTestId("bus-table")).toBeVisible();
  await expect(page.getByTestId("bus-table")).toContainText("allowed");
});

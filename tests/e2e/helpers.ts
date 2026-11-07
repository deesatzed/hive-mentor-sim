import type { Page } from "@playwright/test";

/** Picks the dominant mentor before the first chat message (owner decision 2026-11-06). Seneca is the e2e fixture's only active mentor. */
export async function pickMentor(page: Page, mentorId = "seneca") {
  const select = page.getByLabel(/Who makes the final call/);
  await select.locator(`option[value="${mentorId}"]`).waitFor({ state: "attached" });
  await select.selectOption(mentorId);
}

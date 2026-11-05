// Accepts every pending LinkedIn invitation on the invitation manager page.
import { existsSync } from "node:fs";
import type { Page } from "playwright";
import { config } from "../shared/config.js";
import { acceptConfig } from "./config.js";
import { recordAccepted } from "./db.js";
import { assertUsable, log, randomInt, sleep } from "../shared/runtime.js";

// LinkedIn labels the button "Accept Jane Doe’s invitation".
const ACCEPT_BUTTON = /^Accept\b/i;
const NAME_FROM_LABEL = /^Accept (.+?)['’]s invitation/i;
const LOAD_MORE_BUTTON = /^(show|load|see) more/i;

async function nextAcceptButton(page: Page) {
  const button = page.getByRole("button", { name: ACCEPT_BUTTON }).first();
  if (await button.isVisible().catch(() => false)) return button;

  // The list is paginated; try to reveal more invitations.
  await page.mouse.wheel(0, 4_000);
  const loadMore = page.getByRole("button", { name: LOAD_MORE_BUTTON }).first();
  if (await loadMore.isVisible().catch(() => false)) {
    await loadMore.click();
    await sleep(randomInt(1_500, 3_000));
  }
  return (await button.isVisible().catch(() => false)) ? button : null;
}

// Loads the invitations page and accepts what is there. Returns the number accepted.
export async function acceptPending(page: Page, runId: number): Promise<number> {
  await page.goto(acceptConfig.invitationsUrl, { waitUntil: "domcontentloaded" });
  await assertUsable(page);
  // The list renders after the page shell; give it a moment before deciding it is empty.
  await page
    .getByRole("button", { name: ACCEPT_BUTTON })
    .first()
    .waitFor({ state: "visible", timeout: 4_000 })
    .catch(() => {});

  let accepted = 0;
  while (accepted < acceptConfig.maxPerRun) {
    if (existsSync(config.stopFile)) break;

    const button = await nextAcceptButton(page);
    if (!button) break;

    const label = (await button.getAttribute("aria-label")) ?? (await button.innerText());
    const name = label.match(NAME_FROM_LABEL)?.[1] ?? null;

    await button.hover();
    await sleep(randomInt(300, 1_000));
    await button.click();
    // The button leaves the page once LinkedIn confirms the accept. If it stays, stop
    // instead of clicking the same invitation again.
    const confirmed = await page
      .getByRole("button", { name: label, exact: true })
      .waitFor({ state: "detached", timeout: 10_000 })
      .then(() => true)
      .catch(() => false);
    await assertUsable(page);
    if (!confirmed) throw new Error(`Accept was not confirmed for "${label}".`);

    accepted++;
    recordAccepted(runId, name, label);
    log(`Accepted: ${name ?? label}`);
    await sleep(randomInt(1_000, 3_000));
  }
  return accepted;
}

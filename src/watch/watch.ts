// The bot: asks for your profile, then keeps one Chrome window open and, until stopped,
// accepts new invitations (every 30-60 s) and answers messages (every 10-20 s).
// Usage: npm start    (Ctrl+C to stop)
import { existsSync } from "node:fs";
import type { Page } from "playwright";
import { acceptPending } from "../accept/accept.js";
import { acceptConfig } from "../accept/config.js";
import { askProfile } from "../profile/profile.js";
import { replyConfig } from "../reply/config.js";
import { answerMessages, watchInbox } from "../reply/reply.js";
import { firstPage, openBrowser } from "../shared/browser.js";
import { config } from "../shared/config.js";
import { finishRun, startRun } from "../shared/db.js";
import { acquireLock, HaltError, log, randomInt, releaseLock, screenshot, sleep } from "../shared/runtime.js";

// Give up after this many failed checks in a row; single failures (a slow page) are retried.
const MAX_CONSECUTIVE_ERRORS = 5;

const secondsBetween = (min: number, max: number) => randomInt(min * 1_000, max * 1_000);

if (!process.env.ANTHROPIC_API_KEY) {
  console.error("ANTHROPIC_API_KEY is not set. Add it to .env in the repo (see README).");
  process.exit(1);
}
if (existsSync(config.stopFile)) {
  console.error(`Paused: ${config.stopFile} exists. Check LinkedIn in the bot's Chrome, then delete it to resume.`);
  process.exit(1);
}

const profile = await askProfile();

if (!acquireLock()) {
  console.error("Another bot process is already using the Chrome profile.");
  process.exit(1);
}

const runId = startRun("watch");
const context = await openBrowser();
const messagesPage = await firstPage(context);
const invitesPage = await context.newPage();
const inbox = watchInbox(messagesPage);

let accepted = 0;
let replied = 0;
let stopping = false;

async function shutdown(status: string, error?: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  finishRun(runId, accepted + replied, status, error);
  await context.close().catch(() => {});
  releaseLock();
  log(`Stopped (${status}). Accepted ${accepted}, replied ${replied}.`);
}

process.on("SIGINT", () => void shutdown("ok").then(() => process.exit(0)));
process.on("SIGTERM", () => void shutdown("ok").then(() => process.exit(0)));

// Runs one check; returns false when the bot must stop.
let consecutiveErrors = 0;
async function check(page: Page, name: string, work: () => Promise<number>): Promise<boolean> {
  try {
    await page.bringToFront();
    const count = await work();
    if (name === "accept") accepted += count;
    else replied += count;
    consecutiveErrors = 0;
    return true;
  } catch (error) {
    if (stopping) return false;
    const message = error instanceof Error ? error.message : String(error);
    await screenshot(page, `${name}-error`);
    if (error instanceof HaltError) {
      log(`Stopping: ${message}`);
      await shutdown(error.status, message);
      process.exitCode = 1;
      return false;
    }
    consecutiveErrors++;
    log(`${name} check failed (${consecutiveErrors}/${MAX_CONSECUTIVE_ERRORS}): ${message}`);
    if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
      await shutdown("error", message);
      process.exitCode = 1;
      return false;
    }
    await sleep(5_000);
    return true;
  }
}

log(`Running as ${profile.name}. Watching invitations and messages; press Ctrl+C to stop.`);

let nextAcceptAt = 0;
while (!stopping) {
  if (existsSync(config.stopFile)) {
    log(`${config.stopFile} appeared.`);
    await shutdown("stopped");
    break;
  }
  if (Date.now() >= nextAcceptAt) {
    if (!(await check(invitesPage, "accept", () => acceptPending(invitesPage, runId)))) break;
    nextAcceptAt = Date.now() + secondsBetween(acceptConfig.checkEveryMinSec, acceptConfig.checkEveryMaxSec);
  }
  if (!(await check(messagesPage, "reply", () => answerMessages(messagesPage, inbox, runId, profile)))) break;
  await sleep(secondsBetween(replyConfig.checkEveryMinSec, replyConfig.checkEveryMaxSec));
}

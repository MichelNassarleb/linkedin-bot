// The bot: keeps one Chrome window open and, until stopped,
// accepts new invitations and answers new messages. LinkedIn's realtime channel tells it
// when something arrives, so it acts within seconds; slower timed checks catch anything missed.
// Usage: npm start    (Ctrl+C to stop)
import { existsSync } from "node:fs";
import type { Page } from "playwright";
import { acceptPending } from "../accept/accept.js";
import { acceptConfig } from "../accept/config.js";
import { replyConfig } from "../reply/config.js";
import { answerMessages, watchInbox } from "../reply/reply.js";
import { firstPage, openBrowser } from "../shared/browser.js";
import { config } from "../shared/config.js";
import { finishRun, startRun } from "../shared/db.js";
import { acquireLock, HaltError, log, randomInt, releaseLock, screenshot, sleep } from "../shared/runtime.js";
import { onRealtimeEvent, type RealtimeKind } from "./realtime.js";

// Give up after this many failed checks in a row; single failures (a slow page) are retried.
const MAX_CONSECUTIVE_ERRORS = 5;
// Bursts of realtime events (including ones caused by the bot's own replies) start at most
// one inbox check per this many milliseconds.
const MIN_REPLY_CHECK_GAP_MS = 4_000;

const secondsBetween = (min: number, max: number) => randomInt(min * 1_000, max * 1_000);

if (!process.env.ANTHROPIC_API_KEY) {
  console.error("ANTHROPIC_API_KEY is not set. Add it to .env in the repo (see README).");
  process.exit(1);
}
if (existsSync(config.stopFile)) {
  console.error(`Paused: ${config.stopFile} exists. Check LinkedIn in the bot's Chrome, then delete it to resume.`);
  process.exit(1);
}

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

// Set by realtime events; a check runs as soon as the loop is free.
const due = { accept: true, reply: true };
let wakeUp: (() => void) | null = null;

function waitUntil(time: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, Math.max(0, time - Date.now()));
    wakeUp = () => {
      clearTimeout(timer);
      resolve();
    };
  });
}

function onEvent(kind: RealtimeKind): void {
  const key = kind === "message" ? "reply" : "accept";
  if (!due[key]) log(kind === "message" ? "Message activity; checking the inbox." : "Network activity; checking invitations.");
  due[key] = true;
  wakeUp?.();
}
await onRealtimeEvent(messagesPage, onEvent);
await onRealtimeEvent(invitesPage, onEvent);

log("Running. Waiting for invitations and messages; press Ctrl+C to stop.");

let nextAcceptAt = 0;
let nextReplyAt = 0;
let lastReplyCheckAt = 0;
while (!stopping) {
  if (existsSync(config.stopFile)) {
    log(`${config.stopFile} appeared.`);
    await shutdown("stopped");
    break;
  }

  // Messages first: a reply is the more time-sensitive of the two.
  if ((due.reply && Date.now() - lastReplyCheckAt >= MIN_REPLY_CHECK_GAP_MS) || Date.now() >= nextReplyAt) {
    due.reply = false;
    lastReplyCheckAt = Date.now();
    let recheckAt: number | null = null;
    const ok = await check(messagesPage, "reply", async () => {
      const result = await answerMessages(messagesPage, inbox, runId);
      recheckAt = result.recheckAt;
      return result.replied;
    });
    if (!ok) break;
    const fallback = Date.now() + secondsBetween(replyConfig.checkEveryMinSec, replyConfig.checkEveryMaxSec);
    nextReplyAt = Math.min(fallback, recheckAt ?? Infinity);
  }

  if (due.accept || Date.now() >= nextAcceptAt) {
    due.accept = false;
    if (!(await check(invitesPage, "accept", () => acceptPending(invitesPage, runId)))) break;
    nextAcceptAt = Date.now() + secondsBetween(acceptConfig.checkEveryMinSec, acceptConfig.checkEveryMaxSec);
  }

  let next = Math.min(nextAcceptAt, nextReplyAt);
  if (due.accept) next = Date.now();
  if (due.reply) next = Math.min(next, lastReplyCheckAt + MIN_REPLY_CHECK_GAP_MS);
  await waitUntil(next);
}

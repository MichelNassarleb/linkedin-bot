// Shared helpers: logging, pacing, the profile lock, security-check handling and failure screenshots.
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "playwright";
import { detectState } from "./browser.js";
import { config } from "./config.js";

export const log = (message: string) => console.log(`[${new Date().toISOString()}] ${message}`);
export const randomInt = (min: number, max: number) => Math.floor(min + Math.random() * (max - min + 1));
export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Stops the bot: the session is gone or LinkedIn wants a human to prove themselves.
export class HaltError extends Error {
  constructor(
    message: string,
    readonly status: "logged-out" | "challenge",
  ) {
    super(message);
  }
}

export async function assertUsable(page: Page): Promise<void> {
  const state = await detectState(page);
  if (state === "logged-out") throw new HaltError("Not logged in. Run `npm run login`.", state);
  if (state === "challenge") {
    // Block restarts until a human has looked at the account.
    writeFileSync(config.stopFile, `LinkedIn security check at ${new Date().toISOString()} (${page.url()})\n`);
    throw new HaltError(`LinkedIn showed a security check. Created ${config.stopFile}; the bot is paused.`, state);
  }
}

export async function screenshot(page: Page, tag: string): Promise<void> {
  mkdirSync(config.screenshotDir, { recursive: true });
  const path = join(config.screenshotDir, `${new Date().toISOString().replace(/[:.]/g, "-")}-${tag}.png`);
  await page.screenshot({ path, fullPage: true }).catch(() => {});
  log(`Screenshot saved: ${path}`);
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// One process at a time may use the Chrome profile. Returns false when another live
// process holds the lock; a lock left by a dead process is taken over.
export function acquireLock(): boolean {
  mkdirSync(config.dataDir, { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(config.lockFile, "wx");
      writeSync(fd, String(process.pid));
      closeSync(fd);
      return true;
    } catch {
      const owner = Number(readFileSync(config.lockFile, "utf8"));
      if (Number.isInteger(owner) && isAlive(owner)) return false;
      rmSync(config.lockFile, { force: true });
    }
  }
  return false;
}

export const releaseLock = () => rmSync(config.lockFile, { force: true });

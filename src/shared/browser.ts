import { mkdirSync } from "node:fs";
import { chromium, type BrowserContext, type Page } from "playwright";
import { config } from "./config.js";

// Uses the installed Google Chrome with a dedicated persistent profile, so the
// LinkedIn session survives between runs and the browser fingerprint is a real Chrome.
export async function openBrowser(options: { headless?: boolean } = {}): Promise<BrowserContext> {
  mkdirSync(config.profileDir, { recursive: true });
  return chromium.launchPersistentContext(config.profileDir, {
    channel: "chrome",
    headless: options.headless ?? config.headless,
    viewport: null,
    args: ["--start-maximized"],
  });
}

export async function firstPage(context: BrowserContext): Promise<Page> {
  return context.pages()[0] ?? (await context.newPage());
}

const LOGGED_OUT_PATHS = ["/login", "/uas/login", "/authwall", "/signup"];
const CHALLENGE_PATHS = ["/checkpoint", "/challenge"];

export type PageState = "ok" | "logged-out" | "challenge";

export async function detectState(page: Page): Promise<PageState> {
  const { pathname } = new URL(page.url());
  if (CHALLENGE_PATHS.some((p) => pathname.startsWith(p))) return "challenge";
  if (LOGGED_OUT_PATHS.some((p) => pathname.startsWith(p))) return "logged-out";

  // LinkedIn also loads hidden captcha frames on normal pages; only a visible one is a challenge.
  const captcha = page
    .locator('iframe[src*="captcha"], iframe[title*="captcha" i], #captcha-internal')
    .filter({ visible: true });
  if ((await captcha.count()) > 0) return "challenge";
  return "ok";
}

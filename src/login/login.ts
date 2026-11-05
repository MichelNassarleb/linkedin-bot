// One-time manual login. Opens Chrome with the bot's profile; you sign in yourself
// (including 2FA), and the session is saved for scheduled runs.
import { rmSync } from "node:fs";
import { detectState, firstPage, openBrowser } from "../shared/browser.js";
import { config } from "../shared/config.js";

const context = await openBrowser({ headless: false });
const page = await firstPage(context);

// Signed in = LinkedIn's session cookie is set and the page is not a login or security-check page.
async function isLoggedIn(): Promise<boolean> {
  const cookies = await context.cookies("https://www.linkedin.com");
  return cookies.some((c) => c.name === "li_at") && (await detectState(page)) === "ok";
}

// An expired session redirects the feed to the login page, so this also catches stale cookies.
await page.goto("https://www.linkedin.com/feed/", { waitUntil: "domcontentloaded" });
let loggedIn = await isLoggedIn();

if (loggedIn) {
  console.log("Already signed in.");
} else {
  await page.goto("https://www.linkedin.com/login");
  console.log("Sign in to LinkedIn in the Chrome window. Waiting up to 10 minutes...");

  const deadline = Date.now() + 10 * 60_000;
  try {
    while (Date.now() < deadline) {
      await page.waitForTimeout(2_000);
      if (await isLoggedIn()) {
        loggedIn = true;
        break;
      }
    }
  } catch {
    // Window closed by hand before login finished.
  }
}

await context.close().catch(() => {});

if (loggedIn) {
  // A fresh login clears any earlier security-check stop.
  rmSync(config.stopFile, { force: true });
  console.log(`Logged in. Session saved to ${config.profileDir}`);
} else {
  console.error("Login not detected. Run `npm run login` again.");
  process.exitCode = 1;
}

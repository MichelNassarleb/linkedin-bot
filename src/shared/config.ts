import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Secrets such as ANTHROPIC_API_KEY live in the repo's .env (git-ignored); launchd jobs
// do not inherit your shell's environment, so it is read here. Real env vars win.
const envFile = fileURLToPath(new URL("../../.env", import.meta.url));
if (existsSync(envFile)) process.loadEnvFile(envFile);

export const num = (name: string, fallback: number): number => {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be a non-negative number, got "${raw}"`);
  return value;
};

// Everything that holds session state or personal data lives outside the repo.
const dataDir = process.env.LINKEDIN_BOT_DIR ?? join(homedir(), ".linkedin-bot");

export const config = {
  dataDir,
  profileDir: join(dataDir, "chrome-profile"),
  dbPath: join(dataDir, "bot.db"),
  screenshotDir: join(dataDir, "screenshots"),
  // While this file exists the bot will not start. The bot creates it when LinkedIn shows a security check.
  stopFile: join(dataDir, "STOP"),
  // Held while the bot uses the Chrome profile, so two copies never run at once.
  lockFile: join(dataDir, "run.lock"),

  headless: process.env.HEADLESS === "1",
};

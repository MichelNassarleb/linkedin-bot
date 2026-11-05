// Facts about the account owner that the reply model may share: name, age and location.
// Asked on every start; the last answers are saved and offered as defaults.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { config } from "../shared/config.js";

export type Profile = { name: string; age: string; location: string };

const profileFile = join(config.dataDir, "profile.json");

function loadSaved(): Partial<Profile> {
  if (!existsSync(profileFile)) return {};
  try {
    return JSON.parse(readFileSync(profileFile, "utf8")) as Partial<Profile>;
  } catch {
    return {};
  }
}

export async function askProfile(): Promise<Profile> {
  const saved = loadSaved();
  const complete = (p: Partial<Profile>): p is Profile => !!(p.name && p.age && p.location);

  // Without a terminal (e.g. output piped to a file) nobody can answer; use the saved profile.
  if (!process.stdin.isTTY) {
    if (complete(saved)) return saved;
    throw new Error("No saved profile. Run `npm start` in a terminal once to enter your name, age and location.");
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask = async (label: string, current: string | undefined, valid: (v: string) => boolean = (v) => v !== "") => {
    for (;;) {
      const answer = (await rl.question(current ? `${label} [${current}]: ` : `${label}: `)).trim() || current || "";
      if (valid(answer)) return answer;
      console.log(`Please enter a valid ${label.toLowerCase()}.`);
    }
  };
  try {
    console.log("About you (the bot uses this to answer questions about you; press Enter to keep [saved] values).");
    const profile: Profile = {
      name: await ask("Name", saved.name),
      age: await ask("Age", saved.age, (v) => /^\d{1,3}$/.test(v)),
      location: await ask("Where you live", saved.location),
    };
    mkdirSync(config.dataDir, { recursive: true });
    writeFileSync(profileFile, `${JSON.stringify(profile, null, 2)}\n`, { mode: 0o600 });
    return profile;
  } finally {
    rl.close();
  }
}

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { config } from "./config.js";

mkdirSync(dirname(config.dbPath), { recursive: true });
export const db = new DatabaseSync(config.dbPath);

db.exec(`
  CREATE TABLE IF NOT EXISTS runs (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    started_at  TEXT NOT NULL,
    finished_at TEXT,
    accepted    INTEGER NOT NULL DEFAULT 0,
    status      TEXT NOT NULL DEFAULT 'running',
    error       TEXT
  );
`);

// Databases created before the reply job have no runs.job column.
const runColumns = db.prepare("PRAGMA table_info(runs)").all() as { name: string }[];
if (!runColumns.some((c) => c.name === "job")) {
  db.exec("ALTER TABLE runs ADD COLUMN job TEXT NOT NULL DEFAULT 'accept'");
}

export const now = () => new Date().toISOString();

export type Job = "accept" | "reply" | "watch";

export function startRun(job: Job): number {
  const result = db.prepare("INSERT INTO runs (started_at, job) VALUES (?, ?)").run(now(), job);
  return Number(result.lastInsertRowid);
}

// `count` is accepts for the accept job and replies for the reply job.
export function finishRun(runId: number, count: number, status: string, error?: string): void {
  db.prepare("UPDATE runs SET finished_at = ?, accepted = ?, status = ?, error = ? WHERE id = ?").run(
    now(),
    count,
    status,
    error ?? null,
    runId,
  );
}

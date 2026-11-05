import { db, now } from "../shared/db.js";

db.exec(`
  CREATE TABLE IF NOT EXISTS accepted_invitations (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id      INTEGER NOT NULL REFERENCES runs(id),
    name        TEXT,
    label       TEXT NOT NULL,
    accepted_at TEXT NOT NULL
  );
`);

export function recordAccepted(runId: number, name: string | null, label: string): void {
  db.prepare("INSERT INTO accepted_invitations (run_id, name, label, accepted_at) VALUES (?, ?, ?, ?)").run(
    runId,
    name,
    label,
    now(),
  );
}

import { db, now } from "../shared/db.js";

// One row per incoming message the reply job has answered or decided not to answer.
// A thread gets a new row (and possibly a new reply) each time the other person writes again.
db.exec(`
  CREATE TABLE IF NOT EXISTS handled_messages (
    message_key TEXT PRIMARY KEY,
    thread_id   TEXT NOT NULL,
    name        TEXT,
    action      TEXT NOT NULL,
    reason      TEXT,
    reply_text  TEXT,
    run_id      INTEGER NOT NULL REFERENCES runs(id),
    handled_at  TEXT NOT NULL
  );
`);

export function isMessageHandled(messageKey: string): boolean {
  return db.prepare("SELECT 1 FROM handled_messages WHERE message_key = ?").get(messageKey) !== undefined;
}

export type MessageAction = "replied" | "skipped";

export function recordMessage(
  runId: number,
  messageKey: string,
  threadId: string,
  name: string | null,
  action: MessageAction,
  reason: string,
  replyText: string | null = null,
): void {
  db.prepare(
    `INSERT OR REPLACE INTO handled_messages (message_key, thread_id, name, action, reason, reply_text, run_id, handled_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(messageKey, threadId, name, action, reason, replyText, runId, now());
}

export function repliesSince(since: Date): number {
  const row = db
    .prepare("SELECT COUNT(*) AS n FROM handled_messages WHERE action = 'replied' AND handled_at >= ?")
    .get(since.toISOString()) as { n: number };
  return row.n;
}

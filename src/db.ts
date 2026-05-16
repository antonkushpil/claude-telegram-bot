/**
 * SQLite persistence using better-sqlite3 (synchronous, fast, no callbacks).
 *
 * Stores:
 *  - The owner's Telegram chat_id (single row, learned from /start or any
 *    incoming message).
 *  - A 24h rolling log of incoming text messages, used by the MCP
 *    read_recent_messages tool.
 *
 * Path strategy: if /data is writable (Railway persistent volume), use
 * /data/bot.db. Otherwise fall back to ./bot.db (wiped on each redeploy).
 */

import Database from "better-sqlite3";
import { accessSync, constants } from "node:fs";
import { config } from "./config.js";

function pickDbPath(): string {
  if (config.dbPathOverride) return config.dbPathOverride;
  try {
    accessSync("/data", constants.W_OK);
    return "/data/bot.db";
  } catch {
    return "bot.db";
  }
}

const dbPath = pickDbPath();
console.log(`[db] using ${dbPath}`);

const db = new Database(dbPath);
db.pragma("journal_mode = WAL");
db.pragma("synchronous = NORMAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS owner (
    id          INTEGER PRIMARY KEY CHECK (id = 1),
    chat_id     INTEGER NOT NULL,
    username    TEXT,
    first_name  TEXT,
    updated_at  INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS recent_messages (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id     INTEGER NOT NULL,
    user_id     INTEGER,
    username    TEXT,
    text        TEXT NOT NULL,
    ts          INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_recent_ts ON recent_messages(ts);
`);

export const MESSAGE_TTL_SECONDS = 24 * 60 * 60;

// ---------------------------------------------------------------------------
// Owner chat_id
// ---------------------------------------------------------------------------

const upsertOwner = db.prepare(`
  INSERT INTO owner (id, chat_id, username, first_name, updated_at)
  VALUES (1, @chatId, @username, @firstName, @updatedAt)
  ON CONFLICT(id) DO UPDATE SET
    chat_id    = excluded.chat_id,
    username   = excluded.username,
    first_name = excluded.first_name,
    updated_at = excluded.updated_at
`);

const selectOwner = db.prepare(
  "SELECT chat_id FROM owner WHERE id = 1",
) as Database.Statement<[], { chat_id: number }>;

export function setOwner(args: {
  chatId: number;
  username: string | null;
  firstName: string | null;
}): void {
  upsertOwner.run({
    chatId: args.chatId,
    username: args.username,
    firstName: args.firstName,
    updatedAt: Math.floor(Date.now() / 1000),
  });
}

export function getOwnerChatId(): number | null {
  const row = selectOwner.get();
  return row ? Number(row.chat_id) : null;
}

export function getOwnerChatIdOrFallback(): number | null {
  return getOwnerChatId() ?? config.ownerChatIdFallback;
}

// ---------------------------------------------------------------------------
// Incoming message log (24h)
// ---------------------------------------------------------------------------

const insertMessage = db.prepare(`
  INSERT INTO recent_messages (chat_id, user_id, username, text, ts)
  VALUES (@chatId, @userId, @username, @text, @ts)
`);

const pruneOldMessages = db.prepare(
  "DELETE FROM recent_messages WHERE ts < ?",
);

const selectRecent = db.prepare(`
  SELECT chat_id, user_id, username, text, ts
  FROM recent_messages
  WHERE ts >= @cutoff
  ORDER BY ts DESC
  LIMIT @limit
`) as Database.Statement<
  { cutoff: number; limit: number },
  {
    chat_id: number;
    user_id: number | null;
    username: string | null;
    text: string;
    ts: number;
  }
>;

export function recordIncoming(args: {
  chatId: number;
  userId: number | null;
  username: string | null;
  text: string;
}): void {
  if (!args.text) return;
  const now = Math.floor(Date.now() / 1000);
  insertMessage.run({
    chatId: args.chatId,
    userId: args.userId,
    username: args.username,
    text: args.text,
    ts: now,
  });
  pruneOldMessages.run(now - MESSAGE_TTL_SECONDS);
}

export interface RecentMessage {
  chatId: number;
  userId: number | null;
  username: string | null;
  text: string;
  ts: number;
}

export function fetchRecent(limit = 20): RecentMessage[] {
  const clamped = Math.max(1, Math.min(limit, 200));
  const cutoff = Math.floor(Date.now() / 1000) - MESSAGE_TTL_SECONDS;
  const rows = selectRecent.all({ cutoff, limit: clamped });
  return rows
    .map((r) => ({
      chatId: r.chat_id,
      userId: r.user_id,
      username: r.username,
      text: r.text,
      ts: r.ts,
    }))
    .reverse(); // oldest first
}

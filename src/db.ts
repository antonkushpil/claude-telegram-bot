/**
 * SQLite persistence using better-sqlite3 (synchronous, fast, no callbacks).
 *
 * Tables:
 *  - owner              — single-row owner chat_id, learned from /start.
 *  - recent_messages    — 24h rolling log of incoming messages (used by MCP).
 *  - conversation_history — per-chat Claude conversation turns (persistent).
 *  - post_drafts        — per-chat photo-processing state (themes, copy, etc.).
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
    text        TEXT NOT NULL DEFAULT '',
    file_url    TEXT,
    file_type   TEXT,
    file_name   TEXT,
    ts          INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_recent_ts ON recent_messages(ts);

  CREATE TABLE IF NOT EXISTS conversation_history (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id INTEGER NOT NULL,
    role    TEXT NOT NULL,   -- 'user' | 'assistant'
    content TEXT NOT NULL,
    ts      INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_conv_chat ON conversation_history(chat_id, ts);

  CREATE TABLE IF NOT EXISTS post_drafts (
    chat_id INTEGER PRIMARY KEY,
    data    TEXT NOT NULL,   -- JSON blob
    ts      INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS users (
    chat_id              INTEGER PRIMARY KEY,
    name                 TEXT,                -- null until user provides it
    pending_action       TEXT,                -- e.g. 'awaiting_name'
    last_greeted_date    TEXT,                -- 'YYYY-MM-DD' in UTC
    auto_forward_chat_id INTEGER,             -- if set, clean photos are auto-forwarded here
    created_at           INTEGER NOT NULL
  );
`);

// Migrate existing databases that pre-date added columns.
for (const col of [
  "ALTER TABLE recent_messages ADD COLUMN file_url  TEXT",
  "ALTER TABLE recent_messages ADD COLUMN file_type TEXT",
  "ALTER TABLE recent_messages ADD COLUMN file_name TEXT",
  "ALTER TABLE users ADD COLUMN auto_forward_chat_id INTEGER",
]) {
  try { db.exec(col); } catch { /* column already exists */ }
}

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
// Incoming message log (24h) — used by MCP read_recent_messages
// ---------------------------------------------------------------------------

const insertMessage = db.prepare(`
  INSERT INTO recent_messages (chat_id, user_id, username, text, file_url, file_type, file_name, ts)
  VALUES (@chatId, @userId, @username, @text, @fileUrl, @fileType, @fileName, @ts)
`);

const pruneOldMessages = db.prepare(
  "DELETE FROM recent_messages WHERE ts < ?",
);

const selectRecent = db.prepare(`
  SELECT chat_id, user_id, username, text, file_url, file_type, file_name, ts
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
    file_url: string | null;
    file_type: string | null;
    file_name: string | null;
    ts: number;
  }
>;

export function recordIncoming(args: {
  chatId: number;
  userId: number | null;
  username: string | null;
  text: string;
  fileUrl?: string | null;
  fileType?: string | null;
  fileName?: string | null;
}): void {
  if (!args.text && !args.fileUrl) return;
  const now = Math.floor(Date.now() / 1000);
  insertMessage.run({
    chatId: args.chatId,
    userId: args.userId,
    username: args.username,
    text: args.text || "",
    fileUrl: args.fileUrl ?? null,
    fileType: args.fileType ?? null,
    fileName: args.fileName ?? null,
    ts: now,
  });
  pruneOldMessages.run(now - MESSAGE_TTL_SECONDS);
}

export interface RecentMessage {
  chatId: number;
  userId: number | null;
  username: string | null;
  text: string;
  fileUrl: string | null;
  fileType: string | null;
  fileName: string | null;
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
      fileUrl: r.file_url,
      fileType: r.file_type,
      fileName: r.file_name,
      ts: r.ts,
    }))
    .reverse(); // oldest first
}

// ---------------------------------------------------------------------------
// Conversation history (persistent, per chat)
// ---------------------------------------------------------------------------

export type ConvRole = "user" | "assistant";
export interface ConvTurn { role: ConvRole; content: string }

const CONV_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days
const MAX_CONV_TURNS = 20; // keep last 20 turns per chat

const insertTurn = db.prepare(`
  INSERT INTO conversation_history (chat_id, role, content, ts)
  VALUES (@chatId, @role, @content, @ts)
`);

const selectTurns = db.prepare(`
  SELECT role, content FROM conversation_history
  WHERE chat_id = @chatId
  ORDER BY ts DESC
  LIMIT @limit
`) as Database.Statement<{ chatId: number; limit: number }, { role: string; content: string }>;

const deleteTurns = db.prepare(
  "DELETE FROM conversation_history WHERE chat_id = ?",
);

const pruneOldTurns = db.prepare(
  "DELETE FROM conversation_history WHERE ts < ?",
);

export function appendTurn(chatId: number, role: ConvRole, content: string): void {
  const now = Math.floor(Date.now() / 1000);
  insertTurn.run({ chatId, role, content, ts: now });
  // prune globally stale turns once in a while (cheap)
  if (Math.random() < 0.05) pruneOldTurns.run(now - CONV_TTL_SECONDS);
}

export function getHistory(chatId: number): ConvTurn[] {
  const rows = selectTurns.all({ chatId, limit: MAX_CONV_TURNS });
  return rows.reverse().map((r) => ({ role: r.role as ConvRole, content: r.content }));
}

export function clearHistory(chatId: number): void {
  deleteTurns.run(chatId);
}

// ---------------------------------------------------------------------------
// Post drafts (per chat, in-memory backed by DB for crash safety)
// ---------------------------------------------------------------------------

export interface PostDraft {
  userContext: string;
  imageBase64: string;
  categories: string[];           // 10 items: 6 mandatory + 4 photo-context ones
  selectedPlatform?: string;      // 'tiktok' | 'instagram' | 'reddit'
  selectedCategory?: string;
  previousDescriptions: string[]; // shown so far — never repeat
  cleanFileId?: string;           // Telegram file_id of the stripped photo for forwarding
}

const upsertDraft = db.prepare(`
  INSERT INTO post_drafts (chat_id, data, ts)
  VALUES (@chatId, @data, @ts)
  ON CONFLICT(chat_id) DO UPDATE SET data = excluded.data, ts = excluded.ts
`);

const selectDraft = db.prepare(
  "SELECT data FROM post_drafts WHERE chat_id = ?",
) as Database.Statement<[number], { data: string }>;

const deleteDraft = db.prepare(
  "DELETE FROM post_drafts WHERE chat_id = ?",
);

export function saveDraft(chatId: number, draft: PostDraft): void {
  upsertDraft.run({
    chatId,
    data: JSON.stringify(draft),
    ts: Math.floor(Date.now() / 1000),
  });
}

export function loadDraft(chatId: number): PostDraft | null {
  const row = selectDraft.get(chatId);
  if (!row) return null;
  try { return JSON.parse(row.data) as PostDraft; } catch { return null; }
}

export function deleteDraftForChat(chatId: number): void {
  deleteDraft.run(chatId);
}

// ---------------------------------------------------------------------------
// Users (multi-user name + session tracking)
// ---------------------------------------------------------------------------

export interface UserRecord {
  chatId: number;
  name: string | null;
  pendingAction: string | null;
  lastGreetedDate: string | null;
  autoForwardChatId: number | null;
}

const upsertUser = db.prepare(`
  INSERT INTO users (chat_id, name, pending_action, last_greeted_date, auto_forward_chat_id, created_at)
  VALUES (@chatId, @name, @pendingAction, @lastGreetedDate, @autoForwardChatId, @createdAt)
  ON CONFLICT(chat_id) DO UPDATE SET
    name              = COALESCE(excluded.name, users.name),
    pending_action    = excluded.pending_action,
    last_greeted_date = excluded.last_greeted_date
`);

const selectUser = db.prepare(
  "SELECT chat_id, name, pending_action, last_greeted_date, auto_forward_chat_id FROM users WHERE chat_id = ?",
) as Database.Statement<[number], { chat_id: number; name: string | null; pending_action: string | null; last_greeted_date: string | null; auto_forward_chat_id: number | null }>;

const updateUserName = db.prepare(
  "UPDATE users SET name = @name, pending_action = NULL WHERE chat_id = @chatId",
);

const updatePendingAction = db.prepare(
  "UPDATE users SET pending_action = @pendingAction WHERE chat_id = @chatId",
);

const updateLastGreetedDate = db.prepare(
  "UPDATE users SET last_greeted_date = @date WHERE chat_id = @chatId",
);

export function getUser(chatId: number): UserRecord | null {
  const row = selectUser.get(chatId);
  if (!row) return null;
  return {
    chatId: row.chat_id,
    name: row.name,
    pendingAction: row.pending_action,
    lastGreetedDate: row.last_greeted_date,
    autoForwardChatId: row.auto_forward_chat_id ?? null,
  };
}

/**
 * Ensure user row exists. If the row is new and `telegramName` is provided,
 * it is used automatically — no need to ask. Only sets pendingAction =
 * 'awaiting_name' when there is genuinely no name available at all.
 */
export function ensureUser(chatId: number, telegramName?: string | null): UserRecord {
  const existing = getUser(chatId);
  if (existing) {
    if (!existing.name && telegramName?.trim()) {
      setUserName(chatId, telegramName.trim());
      return getUser(chatId)!;
    }
    return existing;
  }

  const name = telegramName?.trim() || null;
  upsertUser.run({
    chatId,
    name,
    pendingAction: name ? null : "awaiting_name",
    lastGreetedDate: null,
    autoForwardChatId: null,
    createdAt: Math.floor(Date.now() / 1000),
  });
  return getUser(chatId)!;
}

export function setUserName(chatId: number, name: string): void {
  updateUserName.run({ chatId, name: name.trim() });
}

export function setUserPendingAction(chatId: number, action: string | null): void {
  updatePendingAction.run({ chatId, pendingAction: action });
}

export function markGreetedToday(chatId: number): void {
  const today = new Date().toISOString().slice(0, 10); // 'YYYY-MM-DD'
  updateLastGreetedDate.run({ chatId, date: today });
}

/** Returns true if user hasn't been greeted today (UTC). */
export function shouldGreetToday(user: UserRecord): boolean {
  if (!user.name) return false;
  const today = new Date().toISOString().slice(0, 10);
  return user.lastGreetedDate !== today;
}

// ---------------------------------------------------------------------------
// Contact lookup (find another user's chat_id by name)
// ---------------------------------------------------------------------------

const selectUserByName = db.prepare(`
  SELECT chat_id, name, pending_action, last_greeted_date, auto_forward_chat_id
  FROM users
  WHERE lower(name) = lower(?)
  LIMIT 1
`) as Database.Statement<[string], { chat_id: number; name: string | null; pending_action: string | null; last_greeted_date: string | null; auto_forward_chat_id: number | null }>;

/** Find a user by their stored name (case-insensitive). Returns null if not found. */
export function getUserByName(name: string): UserRecord | null {
  const row = selectUserByName.get(name.trim());
  if (!row) return null;
  return {
    chatId: row.chat_id,
    name: row.name,
    pendingAction: row.pending_action,
    lastGreetedDate: row.last_greeted_date,
    autoForwardChatId: row.auto_forward_chat_id ?? null,
  };
}

// ---------------------------------------------------------------------------
// Auto-forward setting
// ---------------------------------------------------------------------------

const updateAutoForward = db.prepare(
  "UPDATE users SET auto_forward_chat_id = ? WHERE chat_id = ?",
);

const selectAllUsers = db.prepare(`
  SELECT chat_id, name, pending_action, last_greeted_date, auto_forward_chat_id
  FROM users
  ORDER BY name ASC
`) as Database.Statement<[], { chat_id: number; name: string | null; pending_action: string | null; last_greeted_date: string | null; auto_forward_chat_id: number | null }>;

const countAllUsers = db.prepare(
  "SELECT COUNT(*) as cnt FROM users",
) as Database.Statement<[], { cnt: number }>;

export function getAllUsers(): UserRecord[] {
  const total = countAllUsers.get()?.cnt ?? 0;
  console.log(`[db] getAllUsers: total rows in users table = ${total}`);
  return selectAllUsers.all().map((r) => ({
    chatId: r.chat_id,
    name: r.name,
    pendingAction: r.pending_action,
    lastGreetedDate: r.last_greeted_date,
    autoForwardChatId: r.auto_forward_chat_id ?? null,
  }));
}

/** Enable auto-forward for chatId → send clean photos to targetChatId after processing. */
export function setAutoForward(chatId: number, targetChatId: number | null): void {
  updateAutoForward.run(targetChatId, chatId);
}

export function getAutoForwardChatId(chatId: number): number | null {
  return getUser(chatId)?.autoForwardChatId ?? null;
}

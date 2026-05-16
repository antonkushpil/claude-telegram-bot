/**
 * MCP server (Streamable HTTP). Exposes six tools that let Claude push to —
 * and read from — the user's Telegram chat via the bot:
 *
 *   send_message, send_photo, send_audio, send_document, send_typing,
 *   read_recent_messages
 *
 * The owner chat_id is auto-resolved from the SQLite owner row (learned via
 * /start) or from the OWNER_CHAT_ID env var as fallback.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { TELEGRAM_API } from "./config.js";
import { fetchRecent, getOwnerChatIdOrFallback } from "./db.js";

export const mcpServer = new McpServer({
  name: "telegram-bot-bridge",
  version: "1.0.0",
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolveChatId(override?: number | null): number {
  if (override != null) return Number(override);
  const cid = getOwnerChatIdOrFallback();
  if (cid == null) {
    throw new Error(
      "No owner chat_id is recorded. Ask the user to send /start to the bot " +
        "in Telegram once, or set the OWNER_CHAT_ID env var.",
    );
  }
  return cid;
}

async function callTelegram(method: string, payload: Record<string, unknown>) {
  const r = await fetch(`${TELEGRAM_API}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = (await r.json()) as {
    ok: boolean;
    description?: string;
    result?: unknown;
  };
  if (!r.ok || !data.ok) {
    throw new Error(
      `Telegram ${method} failed: ${data.description ?? r.statusText}`,
    );
  }
  return data.result;
}

function ok(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

function splitForTelegram(text: string, limit = 4000): string[] {
  if (text.length <= limit) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > limit) {
    let cut = remaining.lastIndexOf("\n\n", limit);
    if (cut === -1) cut = remaining.lastIndexOf("\n", limit);
    if (cut === -1 || cut < Math.floor(limit / 2)) cut = limit;
    chunks.push(remaining.slice(0, cut).trimEnd());
    remaining = remaining.slice(cut).trimStart();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

// ---------------------------------------------------------------------------
// Tools
//
// Note on the .tool() form: we use the 3-arg `(name, schemaShape, handler)`
// signature which is stable across MCP SDK versions. Per-tool descriptions
// are surfaced to Claude via each Zod field's `.describe()` plus the tool
// name itself. Tool docstrings live in the comments above each definition
// for future maintainers.
// ---------------------------------------------------------------------------

/** Send a plain-text message to the user's Telegram chat via the bot. */
mcpServer.tool(
  "send_message",
  {
    text: z
      .string()
      .min(1)
      .describe("Message body. Long text is auto-split into 4000-char chunks."),
    chat_id: z
      .number()
      .int()
      .optional()
      .describe("Override chat_id. Defaults to the owner. Rarely needed."),
  },
  async ({ text, chat_id }) => {
    const cid = resolveChatId(chat_id);
    const chunks = splitForTelegram(text);
    for (const chunk of chunks) {
      await callTelegram("sendMessage", {
        chat_id: cid,
        text: chunk,
        disable_web_page_preview: true,
      });
    }
    return ok(`Sent ${chunks.length} message chunk(s) to chat ${cid}.`);
  },
);

/** Show a 'typing…' indicator for ~5 seconds. */
mcpServer.tool(
  "send_typing",
  {
    chat_id: z.number().int().optional(),
  },
  async ({ chat_id }) => {
    const cid = resolveChatId(chat_id);
    await callTelegram("sendChatAction", { chat_id: cid, action: "typing" });
    return ok(`Typing indicator sent to chat ${cid}.`);
  },
);

/** Send a photo (≤10 MB) by public URL. Telegram fetches it server-side. */
mcpServer.tool(
  "send_photo",
  {
    url: z
      .string()
      .url()
      .describe("Public https URL of a JPG/PNG, ≤10 MB."),
    caption: z.string().max(1024).optional(),
    chat_id: z.number().int().optional(),
  },
  async ({ url, caption, chat_id }) => {
    const cid = resolveChatId(chat_id);
    const payload: Record<string, unknown> = { chat_id: cid, photo: url };
    if (caption) payload["caption"] = caption;
    await callTelegram("sendPhoto", payload);
    return ok(`Photo sent to chat ${cid}.`);
  },
);

/** Send an MP3/M4A audio file (≤50 MB) by public URL. */
mcpServer.tool(
  "send_audio",
  {
    url: z.string().url().describe("Public https URL of an MP3/M4A, ≤50 MB."),
    caption: z.string().max(1024).optional(),
    title: z
      .string()
      .max(64)
      .optional()
      .describe("Track title shown in the audio player UI."),
    performer: z
      .string()
      .max(64)
      .optional()
      .describe("Artist name shown in the audio player UI."),
    chat_id: z.number().int().optional(),
  },
  async ({ url, caption, title, performer, chat_id }) => {
    const cid = resolveChatId(chat_id);
    const payload: Record<string, unknown> = { chat_id: cid, audio: url };
    if (caption) payload["caption"] = caption;
    if (title) payload["title"] = title;
    if (performer) payload["performer"] = performer;
    await callTelegram("sendAudio", payload);
    return ok(`Audio sent to chat ${cid}.`);
  },
);

/** Send any file (≤50 MB) as a Telegram document. */
mcpServer.tool(
  "send_document",
  {
    url: z.string().url().describe("Public https URL of any file, ≤50 MB."),
    caption: z.string().max(1024).optional(),
    filename: z
      .string()
      .max(255)
      .optional()
      .describe("Display filename. Defaults to the URL's basename."),
    chat_id: z.number().int().optional(),
  },
  async ({ url, caption, filename, chat_id }) => {
    const cid = resolveChatId(chat_id);
    const payload: Record<string, unknown> = { chat_id: cid, document: url };
    if (caption) payload["caption"] = caption;
    if (filename) payload["file_name"] = filename;
    await callTelegram("sendDocument", payload);
    return ok(`Document sent to chat ${cid}.`);
  },
);

/** Return up to `limit` recent text messages (24h), oldest first. */
mcpServer.tool(
  "read_recent_messages",
  {
    limit: z
      .number()
      .int()
      .min(1)
      .max(200)
      .optional()
      .describe("Max messages to return (default 20, hard cap 200)."),
  },
  async ({ limit }) => {
    const rows = fetchRecent(limit ?? 20);
    if (rows.length === 0) return ok("No messages in the last 24 hours.");
    const lines = rows.map((r) => {
      const when =
        new Date(r.ts * 1000).toISOString().slice(0, 16).replace("T", " ") +
        "Z";
      const who = r.username ? `@${r.username}` : `user ${r.userId ?? "?"}`;
      return `[${when}] ${who}: ${r.text}`;
    });
    return ok(lines.join("\n"));
  },
);

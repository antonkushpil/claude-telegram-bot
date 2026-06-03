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

export function createMcpServer() {
  const mcpServer = new McpServer({
    name: "telegram-bot-bridge",
    version: "1.0.0",
  });

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

  // ---------------------------------------------------------------------------
  // Local-file upload variants. Use these when the file exists on the client's
  // machine (Cowork sandbox, user's laptop, etc.) and you don't have a public
  // URL. Claude reads the file with its Read tool, base64-encodes it, and passes
  // it here; the bot decodes and uploads directly to Telegram via multipart.
  //
  // Max 20 MB per file (limit set on the bot side; larger payloads also strain
  // the MCP transport). For bigger files, host them and use the URL variants.
  // ---------------------------------------------------------------------------

  /** Send a local audio file (MP3/M4A/etc, ≤20 MB). */
  mcpServer.tool(
    "send_audio_data",
    {
      filename: z
        .string()
        .min(1)
        .max(255)
        .describe("Filename like 'song.mp3'. Used for Telegram's display + mime guess."),
      content_base64: z
        .string()
        .min(1)
        .describe("Base64-encoded raw audio bytes. Data: URLs are accepted too."),
      caption: z.string().max(1024).optional(),
      title: z.string().max(64).optional(),
      performer: z.string().max(64).optional(),
      chat_id: z.number().int().optional(),
    },
    async ({ filename, content_base64, caption, title, performer, chat_id }) => {
      const cid = resolveChatId(chat_id);
      const buf = decodeBase64(content_base64);
      const fields: Record<string, string | number> = { chat_id: cid };
      if (caption) fields["caption"] = caption;
      if (title) fields["title"] = title;
      if (performer) fields["performer"] = performer;
      await callTelegramMultipart("sendAudio", fields, {
        name: "audio",
        filename,
        mime: guessMime(filename, "audio/mpeg"),
        data: buf,
      });
      return ok(
        `Audio '${filename}' (${(buf.length / 1024).toFixed(0)} KB) sent to chat ${cid}.`,
      );
    },
  );

  /** Send a local image file (JPG/PNG/WebP, ≤20 MB). */
  mcpServer.tool(
    "send_photo_data",
    {
      filename: z.string().min(1).max(255),
      content_base64: z.string().min(1),
      caption: z.string().max(1024).optional(),
      chat_id: z.number().int().optional(),
    },
    async ({ filename, content_base64, caption, chat_id }) => {
      const cid = resolveChatId(chat_id);
      const buf = decodeBase64(content_base64);
      const fields: Record<string, string | number> = { chat_id: cid };
      if (caption) fields["caption"] = caption;
      await callTelegramMultipart("sendPhoto", fields, {
        name: "photo",
        filename,
        mime: guessMime(filename, "image/jpeg"),
        data: buf,
      });
      return ok(
        `Photo '${filename}' (${(buf.length / 1024).toFixed(0)} KB) sent to chat ${cid}.`,
      );
    },
  );

  /** Send any local file (≤20 MB) as a Telegram document. */
  mcpServer.tool(
    "send_document_data",
    {
      filename: z.string().min(1).max(255),
      content_base64: z.string().min(1),
      caption: z.string().max(1024).optional(),
      chat_id: z.number().int().optional(),
    },
    async ({ filename, content_base64, caption, chat_id }) => {
      const cid = resolveChatId(chat_id);
      const buf = decodeBase64(content_base64);
      const fields: Record<string, string | number> = { chat_id: cid };
      if (caption) fields["caption"] = caption;
      await callTelegramMultipart("sendDocument", fields, {
        name: "document",
        filename,
        mime: guessMime(filename, "application/octet-stream"),
        data: buf,
      });
      return ok(
        `Document '${filename}' (${(buf.length / 1024).toFixed(0)} KB) sent to chat ${cid}.`,
      );
    },
  );

  /**
   * Return up to `limit` recent messages (24h), oldest first.
   * Media messages include file_url, file_type, and file_name so Claude can
   * pass the URL to download_file to fetch the bytes for processing.
   */
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
        let line = `[${when}] ${who}: ${r.text || "(no caption)"}`;
        if (r.fileUrl) {
          line += `\n  → [${r.fileType ?? "file"}] file_name=${r.fileName ?? "unknown"} file_url=${r.fileUrl}`;
        }
        return line;
      });
      return ok(lines.join("\n\n"));
    },
  );

  /**
   * Download a Telegram file by URL and return its contents as base64.
   * Use after read_recent_messages returns a file_url — pass it here to get
   * the raw bytes so Claude can strip metadata and send the clean file back.
   * Max 40 MB.
   */
  mcpServer.tool(
    "download_file",
    {
      url: z
        .string()
        .url()
        .describe("The file_url from read_recent_messages."),
      filename: z
        .string()
        .min(1)
        .describe("Expected filename (e.g. photo_ABC.jpg). Used to infer file type."),
    },
    async ({ url, filename }) => {
      const MAX_BYTES = 40 * 1024 * 1024;
      const r = await fetch(url);
      if (!r.ok) {
        throw new Error(`download_file: HTTP ${r.status} ${r.statusText}`);
      }
      const contentLength = r.headers.get("content-length");
      if (contentLength && Number(contentLength) > MAX_BYTES) {
        throw new Error(
          `File is ${(Number(contentLength) / 1024 / 1024).toFixed(1)} MB — exceeds 40 MB limit.`,
        );
      }
      const buffer = await r.arrayBuffer();
      if (buffer.byteLength > MAX_BYTES) {
        throw new Error(
          `File is ${(buffer.byteLength / 1024 / 1024).toFixed(1)} MB — exceeds 40 MB limit.`,
        );
      }
      const base64 = Buffer.from(buffer).toString("base64");
      return ok(
        `filename=${filename}\nsize_kb=${(buffer.byteLength / 1024).toFixed(0)}\ncontent_base64=${base64}`,
      );
    },
  );

  return mcpServer;
}

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

// ---------------------------------------------------------------------------
// Direct file uploads — for files that exist only on the client (e.g. on the
// user's laptop, or in Cowork's sandbox). Claude reads the file, base64-
// encodes it, passes the bytes through MCP; we decode here and ship to
// Telegram as multipart/form-data. No URL, no public hosting needed.
// ---------------------------------------------------------------------------

/**
 * 40 MB cap on the *decoded* file. Base64-encoded payload is ~1.33× this
 * (~53 MB on the wire). Telegram's own bot-API limit is 50 MB; the headroom
 * keeps us under it. If MCP transport balks on big payloads, lower this.
 */
const MAX_UPLOAD_BYTES = 40 * 1024 * 1024;

function decodeBase64(content: string): Buffer {
  // Strip data: URL prefix if present (e.g. "data:audio/mpeg;base64,...")
  const cleaned = content.startsWith("data:")
    ? content.slice(content.indexOf(",") + 1)
    : content;
  const buf = Buffer.from(cleaned, "base64");
  if (buf.length === 0) {
    throw new Error("content_base64 decoded to 0 bytes — invalid base64?");
  }
  if (buf.length > MAX_UPLOAD_BYTES) {
    throw new Error(
      `File is ${(buf.length / 1024 / 1024).toFixed(1)} MB; max is ` +
      `${MAX_UPLOAD_BYTES / 1024 / 1024} MB. For larger files, host the file ` +
      `somewhere publicly reachable and use the URL-based send_audio / ` +
      `send_document tool instead.`,
    );
  }
  return buf;
}

async function callTelegramMultipart(
  method: string,
  fields: Record<string, string | number>,
  fileField: { name: string; filename: string; mime: string; data: Buffer },
) {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) {
    form.append(k, String(v));
  }
  form.append(
    fileField.name,
    new Blob([new Uint8Array(fileField.data)], { type: fileField.mime }),
    fileField.filename,
  );
  const r = await fetch(`${TELEGRAM_API}/${method}`, {
    method: "POST",
    body: form,
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

function guessMime(filename: string, fallback: string): string {
  const ext = filename.toLowerCase().split(".").pop() ?? "";
  const map: Record<string, string> = {
    mp3: "audio/mpeg",
    m4a: "audio/mp4",
    aac: "audio/aac",
    ogg: "audio/ogg",
    opus: "audio/opus",
    wav: "audio/wav",
    flac: "audio/flac",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    gif: "image/gif",
    webp: "image/webp",
    pdf: "application/pdf",
    zip: "application/zip",
    txt: "text/plain",
    json: "application/json",
    csv: "text/csv",
    mp4: "video/mp4",
    mov: "video/quicktime",
    webm: "video/webm",
  };
  return map[ext] ?? fallback;
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

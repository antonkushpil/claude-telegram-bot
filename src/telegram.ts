/**
 * Telegram bot: grammy handlers + Claude proxy.
 *
 * Commands:
 *   /start   — records the sender as the owner; prints intro.
 *   /reset   — clears conversation history and any pending draft.
 *   /model   — prints which Claude model is active.
 *   /whoami  — prints chat_id and user_id.
 *   /version — prints bot version.
 *
 * Media flow (runs entirely on Railway — no Mac needed for photos/small videos):
 *   1. User sends photo/video.
 *      • Photos & videos ≤ 1 GB: stripped on Railway with sharp/ffmpeg, clean
 *        file sent back, then 3 theme-angle buttons shown.
 *      • Videos > 1 GB: user is asked to use the Mac/Cowork flow instead.
 *   2. User taps a theme → Claude Haiku writes copy → platform buttons shown.
 *   3. User taps a platform → clean copyable text sent.
 *   All temp files are deleted from Railway immediately after upload.
 */

import Anthropic from "@anthropic-ai/sdk";
import type { Context } from "grammy";
import { Bot, InlineKeyboard } from "grammy";
import sharp from "sharp";
import { execSync } from "child_process";
import { mkdirSync, writeFileSync, readFileSync, unlinkSync, existsSync } from "fs";
import { config, TELEGRAM_API, TELEGRAM_MAX_MSG } from "./config.js";
import {
  recordIncoming,
  setOwner,
  appendTurn,
  getHistory,
  clearHistory,
  saveDraft,
  loadDraft,
  deleteDraftForChat,
  ensureUser,
  setUserName,
  markGreetedToday,
  shouldGreetToday,
  type PostDraft,
  type PlatformCopy,
} from "./db.js";

const anthropic = new Anthropic({ apiKey: config.anthropicApiKey });

// ---------------------------------------------------------------------------
// Temp directory (use Railway volume when available)
// ---------------------------------------------------------------------------

const TMP_DIR = (() => {
  try {
    const d = "/data/tmp";
    mkdirSync(d, { recursive: true });
    return d;
  } catch {
    return "/tmp";
  }
})();

function tmpPath(name: string): string {
  return `${TMP_DIR}/${name}`;
}

function safeUnlink(p: string): void {
  try { if (existsSync(p)) unlinkSync(p); } catch {}
}

// ---------------------------------------------------------------------------
// Claude helpers
// ---------------------------------------------------------------------------

const HAIKU = "claude-haiku-4-5-20251001";
const VIDEO_SIZE_LIMIT = 1024 * 1024 * 1024; // 1 GB

async function generateThemes(
  userContext: string,
  imageBase64: string,
): Promise<Array<{ label: string; angle: string }>> {
  const msg = await anthropic.messages.create({
    model: HAIKU,
    max_tokens: 512,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "image",
            source: { type: "base64", media_type: "image/jpeg", data: imageBase64 },
          },
          {
            type: "text",
            text: `Context: "${userContext}"\n\nSuggest exactly 3 short theme angles for a social media post about this photo. Each should be a distinct creative direction.\n\nRespond ONLY with valid JSON array, no markdown:\n[{"label":"emoji + 2-3 words","angle":"one sentence describing the creative focus"}]`,
          },
        ],
      },
    ],
  });

  const text = (msg.content[0] as Anthropic.TextBlock).text.trim();
  try {
    const parsed = JSON.parse(text) as Array<{ label: string; angle: string }>;
    return parsed.slice(0, 3);
  } catch {
    return [
      { label: "✨ Vibes", angle: "Focus on the mood and atmosphere" },
      { label: "📍 Place", angle: "Highlight the location and setting" },
      { label: "😊 Moment", angle: "Capture the personal connection and emotion" },
    ];
  }
}

async function generateCopy(
  userContext: string,
  angle: string,
  imageBase64: string,
): Promise<PlatformCopy> {
  const msg = await anthropic.messages.create({
    model: HAIKU,
    max_tokens: 1024,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "image",
            source: { type: "base64", media_type: "image/jpeg", data: imageBase64 },
          },
          {
            type: "text",
            text: `Context: "${userContext}"\nAngle: "${angle}"\n\nGenerate social media copy. Respond ONLY with valid JSON, no markdown:\n{\n  "tiktok": "casual Gen-Z 1-3 sentences + newline + 5-8 hashtags incl #fyp",\n  "instagram": "aspirational 2-4 sentences + CTA + newline + 10-15 hashtags",\n  "reddit": "Title: short punchy title\\nBody: authentic 1-3 sentences, no hashtags"\n}`,
          },
        ],
      },
    ],
  });

  const text = (msg.content[0] as Anthropic.TextBlock).text.trim();
  try {
    return JSON.parse(text) as PlatformCopy;
  } catch {
    return {
      tiktok: "living my best life ✨\n#fyp #viral #mood",
      instagram: "Every moment is worth capturing. 📸\n#photography #lifestyle #memories",
      reddit: "Title: Found a gem\nBody: Sometimes you just have to share the good stuff.",
    };
  }
}

// ---------------------------------------------------------------------------
// Metadata stripping
// ---------------------------------------------------------------------------

async function stripPhotoMetadata(inputPath: string, outputPath: string): Promise<void> {
  // sharp strips ALL EXIF/GPS/ICC metadata by default unless .withMetadata() is called
  // sharp strips EXIF/GPS by default — calling withMetadata() opts in, so omitting it strips all
  await sharp(inputPath).jpeg({ quality: 95 }).toFile(outputPath);
}

function stripVideoMetadata(inputPath: string, outputPath: string): void {
  execSync(
    `ffmpeg -i "${inputPath}" -map_metadata -1 -c:v copy -c:a copy "${outputPath}" -y 2>&1`,
    { stdio: "pipe" },
  );
}

// ---------------------------------------------------------------------------
// Telegram file helpers
// ---------------------------------------------------------------------------

/** Resolve a Telegram file_id → direct download URL. Also returns file_size if known. */
async function resolveFile(fileId: string): Promise<{ url: string; size: number | null }> {
  const r = await fetch(`${TELEGRAM_API}/getFile?file_id=${encodeURIComponent(fileId)}`);
  const data = (await r.json()) as {
    ok: boolean;
    result?: { file_path?: string; file_size?: number };
    description?: string;
  };
  if (!data.ok || !data.result?.file_path) {
    throw new Error(`getFile failed for ${fileId}: ${data.description ?? "unknown"}`);
  }
  const url = `https://api.telegram.org/file/bot${config.telegramBotToken}/${data.result.file_path}`;
  return { url, size: data.result.file_size ?? null };
}

/** Download a URL to a local path. */
async function downloadFile(url: string, destPath: string): Promise<void> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed: ${res.status}`);
  const buf = await res.arrayBuffer();
  writeFileSync(destPath, Buffer.from(buf));
}

/** Send a clean photo to Telegram. Deletes the file after upload. */
async function uploadAndDeletePhoto(
  chatId: number,
  filePath: string,
  caption: string,
): Promise<void> {
  const form = new FormData();
  form.append("chat_id", String(chatId));
  const blob = new Blob([readFileSync(filePath)], { type: "image/jpeg" });
  form.append("photo", blob, "clean.jpg");
  form.append("caption", caption);

  const res = await fetch(`https://api.telegram.org/bot${config.telegramBotToken}/sendPhoto`, {
    method: "POST",
    body: form,
  });
  const data = (await res.json()) as { ok: boolean; description?: string };
  safeUnlink(filePath);
  if (!data.ok) throw new Error(`sendPhoto failed: ${data.description}`);
}

/** Send a clean video/document to Telegram. Deletes the file after upload. */
async function uploadAndDeleteVideo(
  chatId: number,
  filePath: string,
  ext: string,
  caption: string,
): Promise<void> {
  const form = new FormData();
  form.append("chat_id", String(chatId));
  const blob = new Blob([readFileSync(filePath)], { type: "video/mp4" });
  form.append("document", blob, `clean.${ext}`);
  form.append("caption", caption);

  const res = await fetch(`https://api.telegram.org/bot${config.telegramBotToken}/sendDocument`, {
    method: "POST",
    body: form,
  });
  const data = (await res.json()) as { ok: boolean; description?: string };
  safeUnlink(filePath);
  if (!data.ok) throw new Error(`sendDocument failed: ${data.description}`);
}

// ---------------------------------------------------------------------------
// Keyboard builders
// ---------------------------------------------------------------------------

function themeKeyboard(themes: Array<{ label: string }>): InlineKeyboard {
  const kb = new InlineKeyboard();
  themes.forEach((t, i) => kb.text(t.label, `t:${i}`).row());
  return kb;
}

function platformKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("📸 TikTok", "p:tiktok")
    .text("📷 Instagram", "p:instagram")
    .text("🤖 Reddit", "p:reddit");
}

// ---------------------------------------------------------------------------
// Core media processing (runs on Railway)
// ---------------------------------------------------------------------------

async function processMedia(
  ctx: Context,
  fileId: string,
  isVideo: boolean,
  ext: string,
  userContext: string,
  chatId: number,
): Promise<void> {
  const tag = `${chatId}_${Date.now()}`;
  const inPath = tmpPath(`orig_${tag}.${ext}`);
  const outPath = tmpPath(`clean_${tag}.${ext}`);

  try {
    // 1. Resolve file URL + size check for large videos
    await ctx.api.sendChatAction(chatId, "upload_photo").catch(() => {});
    const { url, size } = await resolveFile(fileId);

    if (isVideo && size !== null && size > VIDEO_SIZE_LIMIT) {
      await ctx.api.sendMessage(
        chatId,
        `⚠️ This video is ${(size / 1024 / 1024 / 1024).toFixed(1)} GB — too large to process on the server (limit: 1 GB).\n\nUse the Claude Cowork skill instead: send the video there and say "process it".`,
      );
      return;
    }

    // 2. Download
    await ctx.api.sendMessage(chatId, "⬇️ Downloading...").catch(() => {});
    await downloadFile(url, inPath);

    // 3. Strip metadata
    await ctx.api.sendMessage(chatId, "🧹 Stripping metadata...").catch(() => {});
    if (isVideo) {
      stripVideoMetadata(inPath, outPath);
    } else {
      await stripPhotoMetadata(inPath, outPath);
    }
    safeUnlink(inPath); // original no longer needed

    // 4. Send clean file back, then delete it from Railway
    await ctx.api.sendMessage(chatId, "📤 Sending clean file...").catch(() => {});
    const cleanCaption = "✅ Metadata stripped — GPS, device info & timestamps removed.";
    if (isVideo) {
      await uploadAndDeleteVideo(chatId, outPath, ext, cleanCaption);
    } else {
      // Read for Claude BEFORE deleting
      const imageBase64 = readFileSync(outPath).toString("base64");
      await uploadAndDeletePhoto(chatId, outPath, cleanCaption); // outPath deleted inside

      // 5. Generate theme buttons via Claude Haiku
      await ctx.api.sendChatAction(chatId, "typing").catch(() => {});
      const themes = await generateThemes(userContext, imageBase64);

      const draft: PostDraft = { userContext, imageBase64, themes };
      saveDraft(chatId, draft);

      await ctx.api.sendMessage(chatId, "Choose a creative angle for your post:", {
        reply_markup: themeKeyboard(themes),
      });
      return;
    }

    // For video: no theme/copy flow yet — just confirm
    await ctx.api.sendMessage(chatId, "✅ Done! Clean video sent.");

  } catch (err) {
    console.error("[processMedia] error:", err);
    await ctx.api
      .sendMessage(chatId, `⚠️ Error: ${String(err)}`)
      .catch(() => {});
  } finally {
    // Always clean up temp files
    safeUnlink(inPath);
    safeUnlink(outPath);
  }
}

// ---------------------------------------------------------------------------
// Text helper
// ---------------------------------------------------------------------------

export function splitForTelegram(text: string, limit = TELEGRAM_MAX_MSG): string[] {
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

async function askClaude(chatId: number, userText: string): Promise<string> {
  const history = getHistory(chatId);
  appendTurn(chatId, "user", userText);

  const response = await anthropic.messages.create({
    model: config.claudeModel,
    max_tokens: config.maxTokens,
    system: config.systemPrompt,
    messages: [...history, { role: "user", content: userText }],
  });

  const reply = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();

  const text = reply || "(Claude returned an empty response.)";
  appendTurn(chatId, "assistant", text);
  return text;
}

// ---------------------------------------------------------------------------
// Bot wiring
// ---------------------------------------------------------------------------

export const bot = new Bot(config.telegramBotToken);

bot.command(["start", "help"], async (ctx) => {
  const u = ctx.from;
  const chatId = ctx.chat?.id;
  if (!chatId) return;
  if (u) setOwner({ chatId, username: u.username ?? null, firstName: u.first_name ?? null });

  const user = ensureUser(chatId);
  if (user.pendingAction === "awaiting_name") {
    await ctx.reply("Hi! 👋 I'm a Claude-powered bot. What's your name?");
    return;
  }

  const greeting = user.name ? `Hi, ${user.name}! 👋\n\n` : "Hi! 👋\n\n";
  await ctx.reply(
    greeting +
      "📸 Send me a photo or video and I'll:\n" +
      "  1. Strip all metadata (GPS, device info)\n" +
      "  2. Let you pick a creative theme\n" +
      "  3. Generate TikTok, Instagram & Reddit copy\n\n" +
      "Commands:\n" +
      "/reset — clear conversation history\n" +
      "/model — show active Claude model\n" +
      "/whoami — show your chat_id",
  );
});

bot.command("reset", async (ctx) => {
  if (ctx.chat) {
    clearHistory(ctx.chat.id);
    deleteDraftForChat(ctx.chat.id);
  }
  await ctx.reply("Conversation cleared. What's next?");
});

bot.command("model", async (ctx) => {
  await ctx.reply(`Using model: ${config.claudeModel}`);
});

bot.command("whoami", async (ctx) => {
  await ctx.reply(`chat_id: ${ctx.chat?.id ?? "n/a"}\nuser_id: ${ctx.from?.id ?? "n/a"}`);
});

bot.command("version", async (ctx) => {
  await ctx.reply("v1.3.0 — Railway-side processing, persistent memory, inline buttons");
});

// ---------------------------------------------------------------------------
// Media handlers
// ---------------------------------------------------------------------------

bot.on("message:photo", async (ctx) => {
  const chatId = ctx.chat?.id;
  if (!chatId) return;
  if (ctx.from) setOwner({ chatId, username: ctx.from.username ?? null, firstName: ctx.from.first_name ?? null });

  const user = ensureUser(chatId);
  if (user.pendingAction === "awaiting_name") {
    await ctx.reply("Before we start — what's your name? 😊");
    return;
  }

  const best = ctx.message.photo[ctx.message.photo.length - 1];
  if (!best) return;

  // Greet on first message of the day
  if (shouldGreetToday(user)) {
    markGreetedToday(chatId);
    await ctx.reply(`Hello, ${user.name}! 👋`);
  }

  const caption = ctx.message.caption ?? "";
  recordIncoming({ chatId, userId: ctx.from?.id ?? null, username: ctx.from?.username ?? null, text: caption, fileType: "photo", fileName: `photo_${best.file_unique_id}.jpg` });

  await ctx.reply("📥 Got it! Processing on the server...");
  await processMedia(ctx, best.file_id, false, "jpg", caption || "a photo", chatId);
});

bot.on("message:video", async (ctx) => {
  const chatId = ctx.chat?.id;
  if (!chatId) return;
  if (ctx.from) setOwner({ chatId, username: ctx.from.username ?? null, firstName: ctx.from.first_name ?? null });

  const user = ensureUser(chatId);
  if (user.pendingAction === "awaiting_name") {
    await ctx.reply("Before we start — what's your name? 😊");
    return;
  }

  if (shouldGreetToday(user)) {
    markGreetedToday(chatId);
    await ctx.reply(`Hello, ${user.name}! 👋`);
  }

  const video = ctx.message.video;
  const ext = video.mime_type === "video/quicktime" ? "mov" : "mp4";
  const caption = ctx.message.caption ?? "";

  recordIncoming({ chatId, userId: ctx.from?.id ?? null, username: ctx.from?.username ?? null, text: caption, fileType: "video", fileName: `video_${video.file_unique_id}.${ext}` });

  await ctx.reply("📥 Got it! Processing on the server...");
  await processMedia(ctx, video.file_id, true, ext, caption || "a video", chatId);
});

bot.on("message:document", async (ctx) => {
  const chatId = ctx.chat?.id;
  if (!chatId) return;
  if (ctx.from) setOwner({ chatId, username: ctx.from.username ?? null, firstName: ctx.from.first_name ?? null });

  const doc = ctx.message.document;
  const isVideo = doc.mime_type?.startsWith("video/") ?? false;
  const isImage = doc.mime_type?.startsWith("image/") ?? false;
  if (!isVideo && !isImage) {
    await ctx.reply("I can only process photo/video files.");
    return;
  }

  const ext = doc.file_name?.split(".").pop() ?? (isVideo ? "mp4" : "jpg");
  const caption = ctx.message.caption ?? "";

  recordIncoming({ chatId, userId: ctx.from?.id ?? null, username: ctx.from?.username ?? null, text: caption, fileType: isVideo ? "video" : "photo", fileName: doc.file_name ?? `file_${doc.file_unique_id}` });

  await ctx.reply("📥 Got it! Processing on the server...");
  await processMedia(ctx, doc.file_id, isVideo, ext, caption || "a file", chatId);
});

// ---------------------------------------------------------------------------
// Callback query handler (button taps)
// ---------------------------------------------------------------------------

bot.on("callback_query:data", async (ctx) => {
  const chatId = ctx.chat?.id ?? ctx.callbackQuery.from.id;
  const data = ctx.callbackQuery.data;
  await ctx.answerCallbackQuery();

  const draft = loadDraft(chatId);
  if (!draft) {
    await ctx.api.sendMessage(chatId, "⚠️ Session expired. Send a new photo to start again.");
    return;
  }

  // --- Theme selection ---
  if (data.startsWith("t:")) {
    const idx = parseInt(data.slice(2), 10);
    const theme = draft.themes[idx];
    if (!theme) return;

    draft.selectedAngle = theme.angle;
    await ctx.api.sendMessage(chatId, `✅ *${theme.label}*\n\nGenerating copy for all platforms...`, { parse_mode: "Markdown" });
    await ctx.api.sendChatAction(chatId, "typing").catch(() => {});

    try {
      const copies = await generateCopy(draft.userContext, theme.angle, draft.imageBase64);
      draft.copies = copies;
      saveDraft(chatId, draft);

      await ctx.api.sendMessage(chatId, "Pick a platform to get your copy:", {
        reply_markup: platformKeyboard(),
      });
    } catch (err) {
      await ctx.api.sendMessage(chatId, `⚠️ Error generating copy: ${String(err)}`);
    }
    return;
  }

  // --- Platform selection ---
  if (data.startsWith("p:")) {
    const platform = data.slice(2) as "tiktok" | "instagram" | "reddit";
    if (!draft.copies) {
      await ctx.api.sendMessage(chatId, "⚠️ No copy found. Please select a theme first.");
      return;
    }

    const labels: Record<string, string> = { tiktok: "📸 TikTok", instagram: "📷 Instagram", reddit: "🤖 Reddit" };
    const body = draft.copies[platform];
    const text = `${labels[platform]}\n\n${body}`;

    for (const chunk of splitForTelegram(text)) {
      await ctx.api.sendMessage(chatId, chunk);
    }

    // Offer other platforms
    await ctx.api.sendMessage(chatId, "Need another platform?", { reply_markup: platformKeyboard() });
    return;
  }
});

// ---------------------------------------------------------------------------
// Text handler
// ---------------------------------------------------------------------------

bot.on("message:text", async (ctx: Context) => {
  const text = ctx.message?.text;
  const chatId = ctx.chat?.id;
  if (!text || !chatId) return;

  if (ctx.from) setOwner({ chatId, username: ctx.from.username ?? null, firstName: ctx.from.first_name ?? null });

  // --- Multi-user: ensure user record exists ---
  const user = ensureUser(chatId);

  // --- Awaiting name: treat this message as the user's name ---
  if (user.pendingAction === "awaiting_name") {
    const name = text.trim().split(/\s+/)[0] ?? text.trim(); // use first word
    setUserName(chatId, name);
    markGreetedToday(chatId);
    await ctx.reply(
      `Nice to meet you, ${name}! 🙌\n\n` +
        "Send me a photo or video to strip its metadata and generate social post copy. " +
        "Or just chat — I'm powered by Claude.",
    );
    return;
  }

  recordIncoming({ chatId, userId: ctx.from?.id ?? null, username: ctx.from?.username ?? null, text });

  // --- Daily greeting: first message of the day ---
  if (shouldGreetToday(user)) {
    markGreetedToday(chatId);
    await ctx.reply(`Hello, ${user.name}! 👋`);
  }

  await ctx.api.sendChatAction(chatId, "typing").catch(() => {});

  let reply: string;
  try {
    reply = await askClaude(chatId, text);
  } catch (err) {
    console.error("[telegram] claude call failed", err);
    await ctx.reply("Sorry — I hit an error talking to Claude. Try again in a moment.");
    return;
  }

  for (const chunk of splitForTelegram(reply)) {
    await ctx.reply(chunk);
  }
});

bot.catch((err) => {
  console.error("[telegram] handler error", err);
});

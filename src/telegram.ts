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
  getUserByName,
  getAllUsers,
  setAutoForward,
  getAutoForwardChatId,
  type PostDraft,
} from "./db.js";

const MARY_CHAT_ID = 8898794877;

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

const MANDATORY_CATEGORIES = ["Sexy", "Flirting", "Emotions", "Casual", "Elegant", "Erotic"];

/** Generate 4 photo-context categories to complement the 6 mandatory ones. */
async function generateContextCategories(
  userContext: string,
  imageBase64: string,
): Promise<string[]> {
  const msg = await anthropic.messages.create({
    model: HAIKU,
    max_tokens: 200,
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
            text: `Context: "${userContext}"\n\nLook at this photo and suggest exactly 4 short category labels (1-2 words each) for social media post angles — based ONLY on the surroundings: location, setting, lighting, atmosphere, objects, food, decor, time of day. Do NOT reference the person. Do NOT suggest: Sexy, Flirting, Emotions, Casual, Elegant, Erotic — those are already covered.\n\nRespond ONLY with a JSON array of 4 strings, e.g. ["Night Out", "Italian Vibes", "Candlelight", "City Life"]`,
          },
        ],
      },
    ],
  });

  const raw = (msg.content[0] as Anthropic.TextBlock).text.trim();
  try {
    const parsed = JSON.parse(raw) as string[];
    return parsed.slice(0, 4);
  } catch {
    return ["Mood", "Lifestyle", "Aesthetic", "Moment"];
  }
}

const PLATFORM_TREND_GUIDES: Record<string, string> = {
  tiktok: `TikTok 2025 trends:
- Hook in first 3 words (question, bold claim, or relatable statement)
- Very short sentences, punchy rhythm
- Lowercase or mixed case feels more authentic
- 1-3 sentences max before hashtags
- 5-8 hashtags: mix of #fyp #foryou with niche tags
- Emojis used sparingly but strategically (1-3 max)
- Slang: "it's giving", "no cap", "lowkey", "slay", "rent free", "understood the assignment"`,

  instagram: `Instagram 2025 trends:
- First line is the hook (shows before "more" cutoff — max ~125 chars)
- Conversational, slightly longer captions are performing well
- Authentic > polished — people respond to real moments
- Line breaks between sentences for readability
- CTA at end (save this, tag someone, tell me in comments)
- 8-15 hashtags, mix of sizes
- Emojis used as bullet points or accent, not decoration`,

  reddit: `Reddit 2025 trends:
- Title: direct, specific, sometimes self-deprecating or curious
- Body: 1-3 sentences, genuine voice, no hashtags, no emojis or minimal
- Subreddit matters — suggest the most fitting one
- Avoid obvious humble-brag; frame as sharing, not showing off
- Relatable or slightly vulnerable angle performs best`,
};

/** Generate one fresh description for platform + category, never repeating previous ones. */
async function generateDescription(
  imageBase64: string,
  userContext: string,
  platform: string,
  category: string,
  previousDescriptions: string[],
): Promise<string> {
  const trendGuide = PLATFORM_TREND_GUIDES[platform] ?? "";
  const avoidBlock = previousDescriptions.length > 0
    ? `\n\nDO NOT write anything similar to these already-shown descriptions:\n${previousDescriptions.map((d, i) => `${i + 1}. ${d}`).join("\n")}`
    : "";

  const platformLabel = platform === "reddit" ? "Reddit" : platform === "instagram" ? "Instagram" : "TikTok";

  const msg = await anthropic.messages.create({
    model: HAIKU,
    max_tokens: 400,
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
            text: `You are writing a ${platformLabel} post caption.\n\nPhoto context: "${userContext}"\nCategory/vibe: "${category}"\n\n${trendGuide}${avoidBlock}\n\nFocus ONLY on the surroundings — the location, setting, lighting, colors, atmosphere, time of day, interior/exterior design, food, objects, background details. Do NOT describe or reference the person's body, appearance, or clothing.\n\nWrite ONE caption that:\n- Draws from the environment and mood of the scene\n- Fits the "${category}" vibe authentically\n- Follows current ${platformLabel} trends above\n- Feels human and natural, not AI-generated\n- Is genuinely different from any previous suggestions\n\nReturn ONLY the caption text. No explanations, no quotes around it.`,
          },
        ],
      },
    ],
  });

  return (msg.content[0] as Anthropic.TextBlock).text.trim();
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

/** Send a clean photo to Telegram. Deletes the file after upload. Returns Telegram file_id. */
async function uploadAndDeletePhoto(
  chatId: number,
  filePath: string,
  caption: string,
): Promise<string | undefined> {
  const form = new FormData();
  form.append("chat_id", String(chatId));
  const blob = new Blob([readFileSync(filePath)], { type: "image/jpeg" });
  form.append("photo", blob, "clean.jpg");
  form.append("caption", caption);

  const res = await fetch(`https://api.telegram.org/bot${config.telegramBotToken}/sendPhoto`, {
    method: "POST",
    body: form,
  });
  const data = (await res.json()) as {
    ok: boolean;
    description?: string;
    result?: { photo?: Array<{ file_id: string; file_unique_id: string }> };
  };
  safeUnlink(filePath); // delete local file regardless of outcome

  if (!data.ok) throw new Error(`sendPhoto failed: ${data.description}`);

  const fileId = data.result?.photo?.at(-1)?.file_id;
  console.log(`[upload] sendPhoto ok, file_id=${fileId ?? "MISSING"}`);
  return fileId;
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

function platformKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("📸 TikTok", "pl:tiktok")
    .text("📷 Instagram", "pl:instagram")
    .text("🤖 Reddit", "pl:reddit");
}

function categoryKeyboard(categories: string[]): InlineKeyboard {
  const kb = new InlineKeyboard();
  categories.forEach((cat, i) => {
    kb.text(cat, `cat:${i}`);
    if (i % 2 === 1) kb.row(); // 2 per row
  });
  if (categories.length % 2 !== 0) kb.row();
  return kb;
}

function refreshKeyboard(): InlineKeyboard {
  return new InlineKeyboard().text("🔄 Try another", "ref");
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
      const cleanFileId = await uploadAndDeletePhoto(chatId, outPath, cleanCaption); // outPath deleted inside

      // Auto-forward clean photo to Mary if enabled
      const autoFwdTarget = getAutoForwardChatId(chatId);
      console.log(`[auto-forward] target=${autoFwdTarget ?? "none"} fileId=${cleanFileId ?? "none"}`);
      if (autoFwdTarget) {
        if (cleanFileId) {
          await bot.api.sendPhoto(autoFwdTarget, cleanFileId, {
            caption: "📸 Clean photo (metadata stripped)",
          }).catch((err) => console.error("[auto-forward] sendPhoto failed:", err));
        } else {
          console.error("[auto-forward] skipped — cleanFileId is undefined");
        }
      }

      // 5. Generate categories: 6 mandatory + 4 from photo context
      await ctx.api.sendChatAction(chatId, "typing").catch(() => {});
      const contextCats = await generateContextCategories(userContext, imageBase64);
      const categories = [...MANDATORY_CATEGORIES, ...contextCats]; // 10 total

      const draft: PostDraft = { userContext, imageBase64, categories, previousDescriptions: [], cleanFileId };
      saveDraft(chatId, draft);

      await ctx.api.sendMessage(chatId, "Choose a platform:", {
        reply_markup: platformKeyboard(),
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

// ---------------------------------------------------------------------------
// Send-to-contact helpers
// ---------------------------------------------------------------------------

// Matches: "send this to Mary", "send photo to Mary", "send it to Mary", etc.
const SEND_TO_REGEX = /send\s+(this|it|version|caption|description|photo|pic|image)\s+to\s+(\w+)/i;

async function handleSendTo(
  senderChatId: number,
  what: string,
  targetName: string,
): Promise<string> {
  const contact = getUserByName(targetName);
  if (!contact) {
    return `❌ I don't know "${targetName}" — they need to have messaged this bot at least once.\nUse /users to see everyone I know.`;
  }

  const isPhoto = /photo|pic|image/.test(what.toLowerCase());
  const draft = loadDraft(senderChatId);

  if (isPhoto) {
    if (!draft?.cleanFileId) {
      return "❌ No clean photo in the current session. Send a photo first.";
    }
    try {
      await bot.api.sendPhoto(contact.chatId, draft.cleanFileId, { caption: "📸 Sent via bot" });
      return `✅ Clean photo sent to ${contact.name}.`;
    } catch (err) {
      return `❌ Failed to send photo to ${contact.name}: ${String(err)}`;
    }
  } else {
    const lastDesc = draft?.previousDescriptions?.at(-1);
    if (!lastDesc) {
      return "❌ No caption to send yet. Generate one first.";
    }
    try {
      await bot.api.sendMessage(contact.chatId, lastDesc);
      return `✅ Caption sent to ${contact.name}.`;
    } catch (err) {
      return `❌ Failed to send to ${contact.name}: ${String(err)}`;
    }
  }
}

async function sendMessageToContact(targetName: string, text: string): Promise<string> {
  const contact = getUserByName(targetName);
  if (!contact) {
    return `❌ I don't know "${targetName}".\nUse /users to see everyone I know.`;
  }
  try {
    await bot.api.sendMessage(contact.chatId, text);
    return `✅ Message sent to ${contact.name}.`;
  } catch (err) {
    return `❌ Failed to send to ${contact.name}: ${String(err)}`;
  }
}

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
  // Load history BEFORE appending the new turn so it reflects prior exchanges
  const history = getHistory(chatId);
  appendTurn(chatId, "user", userText);

  // history already contains previous turns; append current user message for the API call
  const messages: Array<{ role: "user" | "assistant"; content: string }> = [
    ...history,
    { role: "user", content: userText },
  ];

  console.log(`[claude] chat=${chatId} history_turns=${history.length} sending ${messages.length} messages`);

  const response = await anthropic.messages.create({
    model: config.claudeModel,
    max_tokens: config.maxTokens,
    system: config.systemPrompt,
    messages,
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

  const user = ensureUser(chatId, u?.first_name);
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
      "/users — list all known users\n" +
      "/msg Name Text — send a message to someone\n" +
      "/mary on|off — auto-forward clean photos to Mary\n" +
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
  await ctx.reply("v1.6.0 — /users list, /msg, auto-forward to Mary");
});

bot.command("mary", async (ctx) => {
  const chatId = ctx.chat?.id;
  if (!chatId) return;

  const arg = ctx.match?.trim().toLowerCase(); // "on" or "off"
  if (arg === "on") {
    setAutoForward(chatId, MARY_CHAT_ID);
    await ctx.reply("✅ Auto-forward to Mary enabled — every clean photo will be sent to her automatically.");
  } else if (arg === "off") {
    setAutoForward(chatId, null);
    await ctx.reply("🚫 Auto-forward to Mary disabled.");
  } else {
    const current = getAutoForwardChatId(chatId);
    const status = current ? "✅ enabled" : "🚫 disabled";
    await ctx.reply(
      `Auto-forward to Mary is currently ${status}.\n\nUse:\n/mary on — enable\n/mary off — disable`,
    );
  }
});

bot.command("users", async (ctx) => {
  const users = getAllUsers();
  if (users.length === 0) {
    await ctx.reply(
      "No users in the database yet.\n\n" +
      "Note: the DB resets on each Railway deploy unless you have a /data volume mounted. " +
      "Users are recorded as they interact with the bot.",
    );
    return;
  }
  const lines = users.map((u, i) => {
    const name = u.name ?? "(no name)";
    return `${i + 1}. ${name}  —  chat_id: ${u.chatId}`;
  });
  await ctx.reply(`👥 Known users (${users.length}):\n\n${lines.join("\n")}`);
});

// /msg UserName Hello there! → sends "Hello there!" to UserName's chat
bot.command("msg", async (ctx) => {
  const args = ctx.match?.trim() ?? "";
  // First word is the name, rest is the message
  const spaceIdx = args.indexOf(" ");
  if (spaceIdx === -1) {
    await ctx.reply("Usage: /msg Name Your message here\n\nExample: /msg Mary Hey, check this out!");
    return;
  }
  const targetName = args.slice(0, spaceIdx).trim();
  const text = args.slice(spaceIdx + 1).trim();
  if (!text) {
    await ctx.reply("Message can't be empty.\n\nUsage: /msg Mary Your message here");
    return;
  }
  const result = await sendMessageToContact(targetName, text);
  await ctx.reply(result);
});

// ---------------------------------------------------------------------------
// Media handlers
// ---------------------------------------------------------------------------

bot.on("message:photo", async (ctx) => {
  const chatId = ctx.chat?.id;
  if (!chatId) return;
  if (ctx.from) setOwner({ chatId, username: ctx.from.username ?? null, firstName: ctx.from.first_name ?? null });

  const user = ensureUser(chatId, ctx.from?.first_name);
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

  const user = ensureUser(chatId, ctx.from?.first_name);
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

  // --- Platform selection (first step) ---
  if (data.startsWith("pl:")) {
    const platform = data.slice(3);
    draft.selectedPlatform = platform;
    draft.selectedCategory = undefined;
    draft.previousDescriptions = [];
    saveDraft(chatId, draft);

    const platformLabel: Record<string, string> = { tiktok: "📸 TikTok", instagram: "📷 Instagram", reddit: "🤖 Reddit" };
    await ctx.api.sendMessage(
      chatId,
      `${platformLabel[platform] ?? platform} — choose a category:`,
      { reply_markup: categoryKeyboard(draft.categories) },
    );
    return;
  }

  // --- Category selection ---
  if (data.startsWith("cat:")) {
    const idx = parseInt(data.slice(4), 10);
    const category = draft.categories[idx];
    if (!category || !draft.selectedPlatform) return;

    draft.selectedCategory = category;
    saveDraft(chatId, draft);

    await ctx.api.sendChatAction(chatId, "typing").catch(() => {});
    try {
      const description = await generateDescription(
        draft.imageBase64,
        draft.userContext,
        draft.selectedPlatform,
        category,
        draft.previousDescriptions,
      );
      draft.previousDescriptions.push(description);
      saveDraft(chatId, draft);

      await ctx.api.sendMessage(chatId, description, { reply_markup: refreshKeyboard() });
    } catch (err) {
      await ctx.api.sendMessage(chatId, `⚠️ Error: ${String(err)}`);
    }
    return;
  }

  // --- Refresh: generate a new description for same platform + category ---
  if (data === "ref") {
    if (!draft.selectedPlatform || !draft.selectedCategory) {
      await ctx.api.sendMessage(chatId, "⚠️ Please select a platform and category first.");
      return;
    }

    await ctx.api.sendChatAction(chatId, "typing").catch(() => {});
    try {
      const description = await generateDescription(
        draft.imageBase64,
        draft.userContext,
        draft.selectedPlatform,
        draft.selectedCategory,
        draft.previousDescriptions,
      );
      draft.previousDescriptions.push(description);
      saveDraft(chatId, draft);

      await ctx.api.sendMessage(chatId, description, { reply_markup: refreshKeyboard() });
    } catch (err) {
      await ctx.api.sendMessage(chatId, `⚠️ Error: ${String(err)}`);
    }
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
  const user = ensureUser(chatId, ctx.from?.first_name);

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

  // --- Send-to-contact shortcut ---
  const sendMatch = text.match(SEND_TO_REGEX);
  if (sendMatch) {
    const what = sendMatch[1]!;
    const targetName = sendMatch[2]!;
    const result = await handleSendTo(chatId, what, targetName);
    await ctx.reply(result);
    return;
  }

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

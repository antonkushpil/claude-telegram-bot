/**
 * Telegram bot: grammy handlers + Claude proxy.
 *
 * - /start: records the sender as the owner; prints intro.
 * - /reset: clears the rolling per-chat memory.
 * - /model: prints which Claude model is active.
 * - /whoami: prints chat_id and user_id.
 * - text:  feeds the message into Claude, splits the reply for Telegram.
 */

import Anthropic from "@anthropic-ai/sdk";
import type { Context } from "grammy";
import { Bot } from "grammy";
import { config, TELEGRAM_MAX_MSG } from "./config.js";
import { recordIncoming, setOwner } from "./db.js";

const anthropic = new Anthropic({ apiKey: config.anthropicApiKey });

// chatId -> rolling deque of { role, content }
type Turn = { role: "user" | "assistant"; content: string };
const histories = new Map<number, Turn[]>();

function getHistory(chatId: number): Turn[] {
  let h = histories.get(chatId);
  if (!h) {
    h = [];
    histories.set(chatId, h);
  }
  return h;
}

function trimHistory(h: Turn[]): void {
  const max = config.maxHistoryTurns * 2; // each turn = user + assistant
  while (h.length > max) h.shift();
}

/** Split a long reply on paragraph/line breaks so each chunk fits in one message. */
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

async function askClaude(history: Turn[], userText: string): Promise<string> {
  history.push({ role: "user", content: userText });

  const response = await anthropic.messages.create({
    model: config.claudeModel,
    max_tokens: config.maxTokens,
    system: config.systemPrompt,
    messages: history.map((t) => ({ role: t.role, content: t.content })),
  });

  const reply = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();

  const text = reply || "(Claude returned an empty response.)";
  history.push({ role: "assistant", content: text });
  trimHistory(history);
  return text;
}

// ---------------------------------------------------------------------------
// Bot wiring
// ---------------------------------------------------------------------------

export const bot = new Bot(config.telegramBotToken);

bot.command(["start", "help"], async (ctx) => {
  const u = ctx.from;
  if (ctx.chat && u) {
    setOwner({
      chatId: ctx.chat.id,
      username: u.username ?? null,
      firstName: u.first_name ?? null,
    });
  }
  await ctx.reply(
    "Hi! I'm a Claude-powered bot. Send me a message and I'll reply.\n\n" +
      "Commands:\n" +
      "/reset — clear our conversation history\n" +
      "/model — show which Claude model I'm using\n" +
      "/whoami — show your chat_id (used by Claude when pushing to you)",
  );
});

bot.command("reset", async (ctx) => {
  if (ctx.chat) histories.delete(ctx.chat.id);
  await ctx.reply("Conversation cleared. What's next?");
});

bot.command("model", async (ctx) => {
  await ctx.reply(`Using model: ${config.claudeModel}`);
});

bot.command("whoami", async (ctx) => {
  await ctx.reply(
    `chat_id: ${ctx.chat?.id ?? "n/a"}\nuser_id: ${ctx.from?.id ?? "n/a"}`,
  );
});

// Catch-all for text messages (commands are handled above).
bot.on("message:text", async (ctx: Context) => {
  const text = ctx.message?.text;
  const chatId = ctx.chat?.id;
  if (!text || !chatId) return;

  // Persist for read_recent_messages, remember the owner.
  recordIncoming({
    chatId,
    userId: ctx.from?.id ?? null,
    username: ctx.from?.username ?? null,
    text,
  });
  if (ctx.from) {
    setOwner({
      chatId,
      username: ctx.from.username ?? null,
      firstName: ctx.from.first_name ?? null,
    });
  }

  await ctx.api.sendChatAction(chatId, "typing").catch(() => {});

  const history = getHistory(chatId);
  let reply: string;
  try {
    reply = await askClaude(history, text);
  } catch (err) {
    console.error("[telegram] claude call failed", err);
    // Don't poison history with a half-completed turn.
    if (history.length && history[history.length - 1]?.role === "user") {
      history.pop();
    }
    await ctx.reply(
      "Sorry — I hit an error talking to Claude. Try again in a moment.",
    );
    return;
  }

  for (const chunk of splitForTelegram(reply)) {
    await ctx.reply(chunk);
  }
});

bot.catch((err) => {
  console.error("[telegram] handler error", err);
});

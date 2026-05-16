/**
 * Centralised config. Throws clearly if anything required is missing.
 */

function required(name: string): string {
  const v = process.env[name];
  if (!v || !v.trim()) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return v;
}

function optional(name: string, fallback = ""): string {
  return process.env[name]?.trim() || fallback;
}

function intOr(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

export const config = {
  // Required
  telegramBotToken: required("TELEGRAM_BOT_TOKEN"),
  anthropicApiKey: required("ANTHROPIC_API_KEY"),

  // Required in production
  publicUrl: optional("PUBLIC_URL").replace(/\/+$/, ""),
  port: intOr("PORT", 8080),

  // MCP
  mcpSecret: optional("MCP_SECRET") || null,

  // Optional bot behaviour
  claudeModel: optional("CLAUDE_MODEL", "claude-sonnet-4-6"),
  systemPrompt: optional(
    "SYSTEM_PROMPT",
    "You are a helpful assistant talking to a user over Telegram. " +
      "Keep replies concise and friendly. Use plain text — avoid heavy markdown, " +
      "tables, or code fences unless the user is clearly asking for code.",
  ),
  maxHistoryTurns: intOr("MAX_HISTORY_TURNS", 10),
  maxTokens: intOr("MAX_TOKENS", 1024),

  // Webhook auth (recommended)
  webhookSecret: optional("WEBHOOK_SECRET") || null,

  // Fallback owner chat_id before /start has been called
  ownerChatIdFallback: (() => {
    const raw = process.env["OWNER_CHAT_ID"]?.trim();
    if (!raw) return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  })(),

  // SQLite path override
  dbPathOverride: optional("DB_PATH") || null,
};

// Derived constants
export const TELEGRAM_API = `https://api.telegram.org/bot${config.telegramBotToken}`;
export const TELEGRAM_MAX_MSG = 4000; // Telegram caps at 4096; leave headroom.

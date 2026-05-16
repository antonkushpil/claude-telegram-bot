"""
Telegram bot that proxies user messages to the Claude API.

- Runs in webhook mode (production on Railway).
- Falls back to long polling if PUBLIC_URL is not set (handy for local dev).
- Keeps a small rolling conversation history per chat, in memory.

Required environment variables:
  TELEGRAM_BOT_TOKEN   Bot token from @BotFather
  ANTHROPIC_API_KEY    Key from console.anthropic.com
  PUBLIC_URL           Public HTTPS URL of this service (Railway sets a domain
                       for you, e.g. https://your-app.up.railway.app). Leave
                       unset for local long-polling.

Optional:
  CLAUDE_MODEL         Defaults to "claude-sonnet-4-6"
  SYSTEM_PROMPT        Defaults to a generic helpful assistant prompt
  MAX_HISTORY_TURNS    Number of user+assistant turn pairs to keep (default 10)
  MAX_TOKENS           Max output tokens per reply (default 1024)
  WEBHOOK_SECRET       Optional secret token to validate Telegram webhooks
  PORT                 HTTP port (Railway sets this automatically)
"""

from __future__ import annotations

import logging
import os
from collections import defaultdict, deque
from typing import Deque, Dict

from anthropic import AsyncAnthropic
from telegram import Update
from telegram.constants import ChatAction
from telegram.ext import (
    Application,
    CommandHandler,
    ContextTypes,
    MessageHandler,
    filters,
)

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

logging.basicConfig(
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    level=logging.INFO,
)
# httpx is very chatty at INFO
logging.getLogger("httpx").setLevel(logging.WARNING)
log = logging.getLogger("claude-tg-bot")

TELEGRAM_BOT_TOKEN = os.environ["TELEGRAM_BOT_TOKEN"]
ANTHROPIC_API_KEY = os.environ["ANTHROPIC_API_KEY"]

PUBLIC_URL = os.environ.get("PUBLIC_URL", "").rstrip("/")
PORT = int(os.environ.get("PORT", "8080"))
WEBHOOK_SECRET = os.environ.get("WEBHOOK_SECRET")  # optional

CLAUDE_MODEL = os.environ.get("CLAUDE_MODEL", "claude-sonnet-4-6")
SYSTEM_PROMPT = os.environ.get(
    "SYSTEM_PROMPT",
    "You are a helpful assistant talking to a user over Telegram. "
    "Keep replies concise and friendly. Use plain text — avoid heavy markdown, "
    "tables, or code fences unless the user is clearly asking for code.",
)
MAX_HISTORY_TURNS = int(os.environ.get("MAX_HISTORY_TURNS", "10"))
MAX_TOKENS = int(os.environ.get("MAX_TOKENS", "1024"))

# Telegram caps a single message at 4096 chars.
TELEGRAM_MAX_MSG = 4000

claude = AsyncAnthropic(api_key=ANTHROPIC_API_KEY)

# chat_id -> deque of {"role": "user"|"assistant", "content": str}
# Each user turn + assistant reply = 2 entries, so cap is 2 * MAX_HISTORY_TURNS.
History = Deque[Dict[str, str]]
_histories: Dict[int, History] = defaultdict(
    lambda: deque(maxlen=2 * MAX_HISTORY_TURNS)
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _split_for_telegram(text: str, limit: int = TELEGRAM_MAX_MSG) -> list[str]:
    """Split a long reply into Telegram-sized chunks on paragraph/line breaks."""
    if len(text) <= limit:
        return [text]
    chunks: list[str] = []
    remaining = text
    while len(remaining) > limit:
        cut = remaining.rfind("\n\n", 0, limit)
        if cut == -1:
            cut = remaining.rfind("\n", 0, limit)
        if cut == -1 or cut < limit // 2:
            cut = limit
        chunks.append(remaining[:cut].rstrip())
        remaining = remaining[cut:].lstrip()
    if remaining:
        chunks.append(remaining)
    return chunks


async def _ask_claude(history: History, user_text: str) -> str:
    """Call Claude with the rolling history plus the new user message."""
    history.append({"role": "user", "content": user_text})

    response = await claude.messages.create(
        model=CLAUDE_MODEL,
        max_tokens=MAX_TOKENS,
        system=SYSTEM_PROMPT,
        messages=list(history),
    )

    # Concatenate any text blocks in the response.
    reply = "".join(
        block.text for block in response.content if getattr(block, "type", "") == "text"
    ).strip()

    if not reply:
        reply = "(Claude returned an empty response.)"

    history.append({"role": "assistant", "content": reply})
    return reply


# ---------------------------------------------------------------------------
# Handlers
# ---------------------------------------------------------------------------

async def start(update: Update, _: ContextTypes.DEFAULT_TYPE) -> None:
    await update.message.reply_text(
        "Hi! I'm a Claude-powered bot. Send me a message and I'll reply.\n\n"
        "Commands:\n"
        "/reset — clear our conversation history\n"
        "/model — show which Claude model I'm using"
    )


async def reset(update: Update, _: ContextTypes.DEFAULT_TYPE) -> None:
    _histories.pop(update.effective_chat.id, None)
    await update.message.reply_text("Conversation cleared. What's next?")


async def model_cmd(update: Update, _: ContextTypes.DEFAULT_TYPE) -> None:
    await update.message.reply_text(f"Using model: {CLAUDE_MODEL}")


async def on_message(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    if not update.message or not update.message.text:
        return

    chat_id = update.effective_chat.id
    user_text = update.message.text

    await context.bot.send_chat_action(chat_id=chat_id, action=ChatAction.TYPING)

    history = _histories[chat_id]
    try:
        reply = await _ask_claude(history, user_text)
    except Exception:
        log.exception("Claude call failed for chat %s", chat_id)
        # Don't poison history with a half-completed turn.
        if history and history[-1]["role"] == "user":
            history.pop()
        await update.message.reply_text(
            "Sorry — I hit an error talking to Claude. Try again in a moment."
        )
        return

    for chunk in _split_for_telegram(reply):
        await update.message.reply_text(chunk)


async def on_error(update: object, context: ContextTypes.DEFAULT_TYPE) -> None:
    log.exception("Unhandled error", exc_info=context.error)


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def main() -> None:
    app = Application.builder().token(TELEGRAM_BOT_TOKEN).build()

    app.add_handler(CommandHandler("start", start))
    app.add_handler(CommandHandler("help", start))
    app.add_handler(CommandHandler("reset", reset))
    app.add_handler(CommandHandler("model", model_cmd))
    app.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, on_message))
    app.add_error_handler(on_error)

    if PUBLIC_URL:
        webhook_path = TELEGRAM_BOT_TOKEN  # unguessable path
        webhook_url = f"{PUBLIC_URL}/{webhook_path}"
        log.info("Starting in webhook mode on port %s -> %s", PORT, webhook_url)
        app.run_webhook(
            listen="0.0.0.0",
            port=PORT,
            url_path=webhook_path,
            webhook_url=webhook_url,
            secret_token=WEBHOOK_SECRET,
            allowed_updates=Update.ALL_TYPES,
        )
    else:
        log.info("PUBLIC_URL not set — falling back to long polling (dev mode).")
        app.run_polling(allowed_updates=Update.ALL_TYPES)


if __name__ == "__main__":
    main()

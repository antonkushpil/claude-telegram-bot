# Claude × Telegram bot

A small Telegram bot that forwards user messages to the Claude API and replies
with Claude's answer. Runs in webhook mode on Railway.

## What's in this folder

| File | Purpose |
| --- | --- |
| `bot.py` | The bot. Webhook in prod, long-polling locally. |
| `requirements.txt` | Python deps (`python-telegram-bot`, `anthropic`). |
| `Procfile` | Tells Railway how to start the process. |
| `railway.json` | Railway build/deploy config (Nixpacks, restart policy). |
| `runtime.txt` | Pins Python 3.12. |
| `.env.example` | Documents the env vars you need to set. |
| `.gitignore` | Keeps `.env` and caches out of git. |

## 1. Get your credentials

1. **Telegram bot token** — open Telegram, message [@BotFather](https://t.me/BotFather),
   send `/newbot`, follow prompts. Save the token (looks like `123456:ABC-xyz...`).
2. **Anthropic API key** — go to <https://console.anthropic.com/>, create an API
   key, save it.

## 2. (Optional) Run locally with long polling

```bash
python -m venv .venv
source .venv/bin/activate          # Windows: .venv\Scripts\activate
pip install -r requirements.txt

cp .env.example .env
# fill in TELEGRAM_BOT_TOKEN and ANTHROPIC_API_KEY, leave PUBLIC_URL empty
export $(grep -v '^#' .env | xargs)  # or use direnv / dotenv
python bot.py
```

Now open Telegram, find your bot, send `/start`. Replies come from Claude.

## 3. Deploy to Railway

Railway is the simplest path: it builds from GitHub, gives you HTTPS, and
exposes the public URL Telegram needs for webhooks.

### a) Push this folder to GitHub

```bash
git init
git add .
git commit -m "Claude telegram bot"
gh repo create claude-telegram-bot --private --source=. --push
# or: create a repo on github.com and push manually
```

### b) Create the Railway service

1. Go to <https://railway.app/> → **New Project** → **Deploy from GitHub repo**
   → pick your repo.
2. Railway detects Python, installs `requirements.txt`, and runs `python bot.py`
   (from `Procfile` / `railway.json`).
3. The first deploy will **crash** — that's expected; we haven't set env vars
   yet.

### c) Set environment variables

In the Railway project → your service → **Variables**, add:

| Variable | Value |
| --- | --- |
| `TELEGRAM_BOT_TOKEN` | from BotFather |
| `ANTHROPIC_API_KEY` | from console.anthropic.com |
| `PUBLIC_URL` | leave blank for now, we'll fill it in next |
| `CLAUDE_MODEL` | `claude-sonnet-4-6` (optional) |
| `WEBHOOK_SECRET` | any long random string (optional but recommended) |

### d) Get a public URL

In **Settings → Networking** click **Generate Domain**. You'll get something
like `https://claude-telegram-bot-production.up.railway.app`.

Copy it. Back in **Variables**, set:

```
PUBLIC_URL = https://claude-telegram-bot-production.up.railway.app
```

Railway will redeploy automatically. On startup the bot calls
`setWebhook` itself — no manual `curl` needed.

### e) Verify

1. Check Railway **Deploy Logs** — you should see:
   `Starting in webhook mode on port 8080 -> https://.../<token>`
2. (Optional) ask Telegram what it thinks the webhook is:
   ```bash
   curl "https://api.telegram.org/bot<YOUR_TOKEN>/getWebhookInfo"
   ```
   `url` should match `PUBLIC_URL/<YOUR_TOKEN>` and `pending_update_count`
   should be 0.
3. Open Telegram, message the bot — Claude replies.

## Commands

- `/start` or `/help` — intro message.
- `/reset` — clear conversation history for this chat.
- `/model` — show which Claude model is active.

## Costs to keep in mind

- **Railway** has a free starter trial; after that the cheapest hobby plan is
  ~$5/month. The bot itself uses very little RAM/CPU.
- **Anthropic** charges per token. A general chat bot with one user is cents
  per day; if you open it to the public, add rate limits or per-user quotas.

## Hardening ideas (not done here)

- Allow-list `update.effective_user.id` so only you can talk to the bot.
- Persist history to Redis / Postgres instead of in-memory `dict`
  (Railway restarts wipe the current history).
- Add per-user rate limiting.
- Handle voice messages, images, or documents (Claude supports vision).

## Troubleshooting

- **Bot doesn't respond, no logs**: webhook not set. Check `PUBLIC_URL` exactly
  matches the Railway domain (no trailing slash, includes `https://`). Hit
  `getWebhookInfo` and look at `last_error_message`.
- **`401 Unauthorized` from Anthropic**: bad/expired `ANTHROPIC_API_KEY`.
- **`Conflict: terminated by other getUpdates request`**: you have a local
  `python bot.py` still running in polling mode. Stop it — only one consumer
  can read updates at a time.
- **Replies are cut off**: bump `MAX_TOKENS`.

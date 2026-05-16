# Claude × Telegram bot

A small Telegram bot that forwards user messages to the Claude API and replies
with Claude's answer. Runs in webhook mode on Railway. **Also** exposes an MCP
endpoint so Claude (in any UI that supports custom connectors) can push
messages, audio, photos, and documents back to your Telegram and read messages
you recently sent the bot.

Written in TypeScript, runs on Node 20.

## What's in this folder

| File | Purpose |
| --- | --- |
| `src/index.ts` | Hono HTTP server: Telegram webhook + MCP endpoint. |
| `src/telegram.ts` | grammy bot handlers + Claude proxy. |
| `src/mcp.ts` | MCP server with the six push/read tools. |
| `src/db.ts` | SQLite persistence (owner chat_id + 24h message log). |
| `src/config.ts` | Env var parsing in one place. |
| `package.json` | npm deps + scripts. |
| `tsconfig.json` | TypeScript config. |
| `Procfile` | Railway start command. |
| `railway.json` | Railway build config. |
| `.env.example` | Documented env vars. |
| `.gitignore` | Keeps `.env`, `node_modules`, `dist`, `bot.db` out of git. |

## Architecture

```
                ┌────────────────────────────────┐
                │  Railway service (one process) │
   Telegram ◄──►│  POST /<TELEGRAM_BOT_TOKEN>    │ ◄── Telegram → Claude
                │  /mcp-<MCP_SECRET>/mcp         │ ◄── Claude → Telegram (MCP)
                │                                │
                │  SQLite: chat_id + recent msgs │
                └────────────────────────────────┘
```

One service, two surfaces. Telegram messages come in via the standard webhook
and get answered by Claude. The MCP endpoint, mounted at a path containing a
secret, lets Claude push messages/audio/photos/documents back to your Telegram
and read the last 24h of messages you sent the bot.

## 1. Get your credentials

1. **Telegram bot token** — Telegram → [@BotFather](https://t.me/BotFather) →
   `/newbot` → save the token.
2. **Anthropic API key** — <https://console.anthropic.com> → API Keys →
   Create Key.

## 2. Run locally

The bot uses webhooks, so for local dev you need a public HTTPS tunnel
(`ngrok`, `cloudflared`, or similar) — Telegram won't deliver to localhost.

```bash
nvm use 20         # or any other way to get Node 20+
npm install

cp .env.example .env
# fill in TELEGRAM_BOT_TOKEN, ANTHROPIC_API_KEY
# set PUBLIC_URL to your ngrok https URL

npm run dev        # tsx in watch mode
```

In another terminal:

```bash
ngrok http 8080
# copy the https URL into .env as PUBLIC_URL, then restart npm run dev
```

Open Telegram, find your bot, send `/start`. Replies come from Claude.

## 3. Deploy to Railway

### a) Push to GitHub

```bash
git add .
git commit -m "Rewrite in TypeScript: grammy + hono + better-sqlite3"
git push
```

Railway redeploys automatically.

### b) Set environment variables

Service → **Variables**:

| Variable | Value |
| --- | --- |
| `TELEGRAM_BOT_TOKEN` | from BotFather |
| `ANTHROPIC_API_KEY` | from console.anthropic.com |
| `PUBLIC_URL` | your Railway domain (Settings → Networking → Generate Domain) |
| `MCP_SECRET` | any long random string — needed to enable the MCP endpoint |
| `CLAUDE_MODEL` | optional, default `claude-sonnet-4-6` |
| `WEBHOOK_SECRET` | optional but recommended — any long random string |

Click the purple **Deploy** button to apply.

### c) Verify

Deploy logs should show:

```
[db] using /data/bot.db   (or ./bot.db without a volume)
[boot] Telegram webhook set to https://.../<your-token>
[boot] MCP endpoint enabled at /mcp-xxxx…/mcp
[boot] listening on :8080
```

Open Telegram, send `/start` to your bot. Replies come from Claude.

## Commands

- `/start` or `/help` — intro message. Also records your chat_id so the MCP
  can push to you.
- `/reset` — clear conversation history for this chat.
- `/model` — show which Claude model is active.
- `/whoami` — print your chat_id and user_id.

## 4. Enable Claude → Telegram (MCP custom connector)

### Add the connector in Claude

1. Open <https://claude.ai/customize/connectors> (or Claude Desktop → Settings
   → Connectors).
2. Click **+** → **Add custom connector**.
3. **Remote MCP server URL**: paste

   ```
   https://<your-railway-domain>/mcp-<MCP_SECRET>/mcp
   ```

4. Leave OAuth fields empty. The URL itself is the credential — anyone with
   it can push messages through your bot, so don't share it.
5. Click **Add**.

In any chat: **+** at bottom-left → **Connectors** → toggle
**telegram-bot-bridge** on.

### Try it

```
You:    send me "hello from Claude" on my Telegram
Claude: [calls send_message] → message arrives in your Telegram

You:    what did I just send you on Telegram?
Claude: [calls read_recent_messages] → digest of the last ~20 messages
```

### Tools the MCP exposes

Two flavors. **URL-based** tools take a public https URL (Telegram fetches the
file server-side — the file never touches your Railway service). **Data-based**
tools take base64-encoded bytes (the file passes through MCP → Railway →
Telegram; capped at 20 MB).

| Tool | When to use it |
| --- | --- |
| `send_message(text)` | Plain text. |
| `send_typing()` | "typing…" indicator. |
| `send_photo(url, caption?)` | Photo already hosted at a public URL. |
| `send_audio(url, caption?, title?, performer?)` | MP3/M4A at a public URL. |
| `send_document(url, caption?, filename?)` | Any file ≤50 MB at a public URL. |
| `send_photo_data(filename, content_base64, caption?)` | Local image file. |
| `send_audio_data(filename, content_base64, caption?, title?, performer?)` | Local audio file. |
| `send_document_data(filename, content_base64, caption?)` | Any local file ≤20 MB. |
| `read_recent_messages(limit=20)` | Last N messages you sent the bot (24h). |

### Sending a file from your computer

You have two routes for local files:

1. **Keep the file in your Cowork-mounted folder** (default
   `~/Documents/Claude/Projects/Telegram/`). Then just ask Claude:
   *"Send `song.mp3` from the folder to my Telegram."* Claude reads the file
   with its `Read` tool, base64-encodes it, and calls `send_audio_data`.
2. **Drag the file into the Cowork chat input.** Same flow — it lands in the
   sandbox's `uploads/` directory which Claude can read.

For files >20 MB, upload them to any public host (Dropbox public link, GitHub
release, S3 with a public ACL, etc.) and use the URL-based variants instead.

## 5. Optional: persistent SQLite across deploys

Without a Railway volume, `bot.db` is wiped on every redeploy — you'd have to
`/start` the bot again and the message backlog resets. To keep state:

1. Railway service → **Settings → Volumes** → **+ New Volume**.
2. Mount path: `/data`. Size: 1 GB is plenty.
3. Redeploy. The bot auto-detects `/data` and writes `bot.db` there.

## Costs

- **Railway** — ~$5/month after the free trial. The bot uses very little
  RAM/CPU.
- **Anthropic** — pay-per-token. A personal-use chat bot is cents per day.
  Set a usage limit at <https://console.anthropic.com> → Billing → Limits.

## Troubleshooting

- **`Conflict: terminated by other getUpdates request`** — you have a local
  `npm run dev` still running. Only one consumer can read updates at a time;
  stop it.
- **`401 Unauthorized` from Anthropic** — bad/expired `ANTHROPIC_API_KEY`.
- **Build fails: `gyp ERR! build error`** — `better-sqlite3` needs prebuilt
  binaries; if Railway can't fetch them, add `npm_config_build_from_source=false`
  to your Variables, or pin Node 20 LTS explicitly via `engines` in
  `package.json` (already done).
- **MCP connector returns 404** — `MCP_SECRET` not set, or the secret in the
  URL doesn't match. Trailing slash matters: use `/mcp-<secret>/mcp` (no
  trailing slash).
- **`No owner chat_id is recorded`** — `/start` the bot in Telegram once, or
  set the `OWNER_CHAT_ID` env var as a fallback.

## Future ideas

- Allow-list `from.id` so only you can talk to the bot.
- Add a vision tool (Claude can describe images you send the bot).
- Add yt-dlp + ffmpeg in the build for in-bot song splitting.
- Move history to Postgres / Redis for cross-restart memory.
- Per-user rate limiting.

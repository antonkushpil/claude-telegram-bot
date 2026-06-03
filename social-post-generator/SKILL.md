---
name: social-post-generator
description: Strip metadata from a Telegram photo/video and generate TikTok, Instagram, and Reddit post copy (3 options each). Sends cleaned file + copy back to Telegram. Use this skill only for videos larger than 1 GB — smaller photos and videos are processed automatically by the Telegram bot itself.
triggers:
  - "process my photo"
  - "clean this photo"
  - "generate post"
  - "here is a photo of"
  - "here is a video of"
  - "process it"
  - "process large video"
tools:
  - mcp__0fe2af84-f6da-4861-858d-54b2d8cfaf0d__read_recent_messages
  - mcp__0fe2af84-f6da-4861-858d-54b2d8cfaf0d__send_message
  - mcp__workspace__bash
---

# Social Post Generator Skill

## When to use this skill

The Telegram bot (running on Railway) **automatically handles photos and videos ≤ 1 GB** — it strips metadata, sends the clean file back, and shows interactive theme + platform buttons. No Cowork involvement needed.

Use this skill **only for videos > 1 GB** that the bot can't process on the server.

---

## Credentials (always available from .env.tg)

Read `/Users/antonkushpil/Documents/Claude/Projects/Telegram/.env.tg` to get:
- `TELEGRAM_BOT_TOKEN` — used in all curl calls
- `TELEGRAM_CHAT_ID` — the owner's chat ID to send to

---

## Workflow

### STEP 1 — Read recent Telegram messages

Say: `"📥 Checking Telegram for your latest photo/video..."`

Call `read_recent_messages` with limit 10. Find the most recent entry with a `file_url` line:
```
→ [photo] file_name=photo_ABC.jpg file_url=https://api.telegram.org/file/bot.../photos/file_0.jpg
```

Extract `file_url`, `file_name`, `file_type` (photo or video), and any caption/context text.

If no media found: `"❌ No photo or video in recent Telegram messages. Send one to the bot first."`

### STEP 2 — Download via curl

Say: `"⬇️ Downloading..."`

Read credentials:
```bash
BOT_TOKEN=$(grep TELEGRAM_BOT_TOKEN /sessions/peaceful-wonderful-davinci/mnt/Telegram/.env.tg | cut -d= -f2)
CHAT_ID=$(grep TELEGRAM_CHAT_ID /sessions/peaceful-wonderful-davinci/mnt/Telegram/.env.tg | cut -d= -f2)
```

Download the file:
```bash
curl -s -L -o /sessions/peaceful-wonderful-davinci/mnt/outputs/original.<ext> "<file_url>"
ls -lh /sessions/peaceful-wonderful-davinci/mnt/outputs/original.<ext>
```

Say: `"✅ Downloaded [size]"`

### STEP 3 — Strip metadata

Say: `"🧹 Stripping metadata..."`

For photos (jpg, jpeg, png, webp):
```bash
ffmpeg -i /sessions/peaceful-wonderful-davinci/mnt/outputs/original.<ext> \
  -map_metadata -1 \
  /sessions/peaceful-wonderful-davinci/mnt/outputs/clean.<ext> -y 2>&1 | tail -3
```

For video (mp4, mov):
```bash
ffmpeg -i /sessions/peaceful-wonderful-davinci/mnt/outputs/original.<ext> \
  -map_metadata -1 -c:v copy -c:a copy \
  /sessions/peaceful-wonderful-davinci/mnt/outputs/clean.<ext> -y 2>&1 | tail -3
```

Verify clean:
```bash
ffprobe -v quiet -print_format json -show_format /sessions/peaceful-wonderful-davinci/mnt/outputs/clean.<ext> 2>&1 | python3 -c "
import sys, json
d = json.load(sys.stdin)
tags = d.get('format', {}).get('tags', {})
print('Remaining tags:', tags if tags else 'NONE — clean!')
"
```

Say: `"✅ Metadata stripped — [what was removed or NONE]"`

### STEP 4 — Analyze the image

Say: `"🔍 Analyzing..."`

Use the Read tool on the clean file at its Mac path:
`/Users/antonkushpil/Library/Application Support/Claude/local-agent-mode-sessions/95cb78ec-4906-4f73-8ea9-b79060ebb8ad/1da70abc-1b68-44c2-b035-aef2a12cb5d3/local_46fe30de-f50f-4b1b-acec-acc060ad786f/outputs/clean.<ext>`

Combine visual observations with the user's context words (person name, location, occasion, etc.).

### STEP 5 — Generate post copy

Say: `"✍️ Writing TikTok, Instagram, Reddit copy..."`

Generate 3 options (A, B, C) per platform — each with a distinctly different angle.

**TikTok** — casual, Gen-Z, 1–3 punchy sentences, hook first, 5–8 hashtags incl. #fyp
**Instagram** — aspirational, aesthetic, 2–4 sentences + CTA, 10–15 hashtags
**Reddit** — authentic, no hashtags, best subreddit, Title + Body separately

### STEP 6 — Send clean file to Telegram

Say: `"📤 Sending clean file to Telegram..."`

```bash
curl -s \
  -F "chat_id=$CHAT_ID" \
  -F "photo=@/sessions/peaceful-wonderful-davinci/mnt/outputs/clean.<ext>" \
  -F "caption=✅ Metadata stripped — GPS, device info & timestamps removed." \
  "https://api.telegram.org/bot${BOT_TOKEN}/sendPhoto" | python3 -c "import sys,json; d=json.load(sys.stdin); print('OK' if d.get('ok') else f'ERROR: {d}')"
```

For video/HEIC use `sendDocument` and `-F "document=@..."` instead.

### STEP 7 — Send post copy to Telegram

Say: `"📨 Sending post copy..."`

Send each platform's copy as **two separate messages**: first the platform label, then the copy text on its own — so the user can copy just the text without the label.

```
send_message("📸 TikTok — Option A:")
send_message("[tiktok copy A]")
send_message("📸 TikTok — Option B:")
send_message("[tiktok copy B]")
send_message("📸 TikTok — Option C:")
send_message("[tiktok copy C]")

send_message("📷 Instagram — Option A:")
send_message("[instagram copy A]")
...

send_message("🤖 Reddit → r/[subreddit] — Option A:")
send_message("[reddit title + body A]")
...
```

Split any message over 4096 chars into multiple `send_message` calls.

### STEP 8 — Done

Say: `"✅ Done! Clean file + 3×3 post options sent to your Telegram."`

---

## Rules

- **Never use `download_file` MCP tool** — base64 of real photos exceeds context window. Always use curl in bash.
- Never send the original unstripped file.
- Always show exact error output — never hide it.
- Keep copy authentic — don't over-polish.
- Send platform label and copy text as **separate messages** so the copy is clean to paste.

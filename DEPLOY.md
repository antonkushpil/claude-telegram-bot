# Push to GitHub → Deploy to Railway

These are commands **you run on your Mac** in Terminal. The bot folder is at
`~/Documents/Claude/Projects/Telegram`.

## 0. One-time cleanup

I tried to `git init` inside the sandbox earlier, but the sandbox didn't have
permission to finish, so it left a half-initialized `.git/` folder behind. Wipe
it so we can start clean:

```bash
cd ~/Documents/Claude/Projects/Telegram
sudo rm -rf .git        # password = your Mac login password
```

You only need this step once.

## 1. Install prerequisites (skip what you already have)

```bash
# Git — usually already installed on macOS
git --version

# GitHub CLI — the easiest way to create + push a repo in one shot
brew install gh
```

If you don't have Homebrew, see <https://brew.sh>, or create the repo via the
GitHub website instead (path B below).

## 2. Initialize the repo locally

```bash
cd ~/Documents/Claude/Projects/Telegram

git init -b main
git config user.email "anton.kushpil@gmail.com"
git config user.name  "Anton Kushpil"

git add .
git status              # sanity check — should NOT list any .env file
git commit -m "Initial commit: Claude-powered Telegram bot"
```

The `.gitignore` I wrote already excludes `.env`, `.venv/`, `__pycache__/`, etc.

## 3a. Push — easy path (GitHub CLI)

```bash
gh auth login           # follow prompts: GitHub.com → HTTPS → browser auth
gh repo create claude-telegram-bot --private --source=. --push
```

That single `gh repo create` command creates the GitHub repo, wires up the
remote, and pushes `main`. When it finishes it prints the URL — open it in your
browser to confirm.

## 3b. Push — manual path (no `gh`)

1. Go to <https://github.com/new>.
2. Repository name: `claude-telegram-bot`. Visibility: **Private**. Don't add
   a README/license/.gitignore — we already have them.
3. Click **Create repository**.
4. On the empty-repo page GitHub shows commands. Use the "push an existing
   repository" block. It looks like:

   ```bash
   git remote add origin https://github.com/<your-username>/claude-telegram-bot.git
   git branch -M main
   git push -u origin main
   ```

   First push will pop a browser window (or ask for a Personal Access Token).

## 4. Connect Railway to the repo

1. Go to <https://railway.app/> and sign in (with GitHub if you can — easiest).
2. **New Project → Deploy from GitHub repo**.
3. If Railway can't see your repo yet, click "Configure GitHub App" and grant
   access to `claude-telegram-bot` (you can grant access to just this one repo;
   you don't have to give it all repos).
4. Pick the repo. Railway starts a build. It will **fail** on first deploy —
   that's normal, we haven't set env vars.
5. Open the service → **Variables** tab → add:

   ```
   TELEGRAM_BOT_TOKEN = <from @BotFather>
   ANTHROPIC_API_KEY  = <from console.anthropic.com>
   ```

6. Service → **Settings → Networking → Generate Domain**. Copy the URL.
7. Back in **Variables**, add one more:

   ```
   PUBLIC_URL = https://<that-railway-domain>
   ```

   Railway auto-redeploys. The bot registers its own Telegram webhook on
   startup — no manual `curl setWebhook` needed.

## 5. Verify

In Railway, open **Deploy Logs**. Look for:

```
Starting in webhook mode on port 8080 -> https://.../<token>
```

Then open Telegram, find your bot, send `/start`. Claude should reply.

## Future updates

Anytime you change the code:

```bash
cd ~/Documents/Claude/Projects/Telegram
git add .
git commit -m "what changed"
git push
```

Railway watches the repo and redeploys automatically.

## Common snags

- **`error: pathspec '.' did not match any files`** — you're not in the project
  folder. `cd ~/Documents/Claude/Projects/Telegram` first.
- **`refusing to merge unrelated histories`** — you let GitHub create a README
  when making the repo. Either delete the GitHub repo and recreate it empty, or
  run `git pull origin main --allow-unrelated-histories` and resolve conflicts.
- **`Permission denied (publickey)`** — `gh auth login` again, choose HTTPS,
  not SSH.
- **Railway build fails: `ModuleNotFoundError`** — make sure
  `requirements.txt` was committed: `git ls-files | grep requirements`.

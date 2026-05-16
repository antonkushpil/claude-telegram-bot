# Connect Claude Desktop to GitHub (remote MCP, OAuth)

A 2-minute setup that gives Claude full read+write access to your GitHub
account — repos, issues, PRs, code search, branches, files, commits.

## What you're adding

GitHub publishes an official, hosted MCP server at:

```
https://api.githubcopilot.com/mcp/
```

You add it to Claude as a **custom connector**. Claude does the OAuth handshake
with GitHub in your browser; no Personal Access Token to copy, no Docker, no
config file editing.

> Custom connectors are currently in beta. Free plans get one custom connector;
> Pro/Max/Team/Enterprise have no per-user cap.

## Steps

1. **Open** <https://claude.ai/customize/connectors> (or in Claude Desktop:
   click your name → Settings → Connectors).
2. Click **+** → **Add custom connector**.
3. **Remote MCP server URL**: paste
   ```
   https://api.githubcopilot.com/mcp/
   ```
4. Leave "Advanced settings" alone (no OAuth Client ID/Secret needed — GitHub
   handles OAuth automatically).
5. Click **Add**.
6. Claude opens a browser tab to GitHub. **Authorize** the OAuth app.
7. Review the requested scopes. For full read+write, accept all. You can
   restrict per-organization access here too.
8. You're done. The connector appears in your list as "Connected".

## Enable it in a chat

Inside any conversation:

1. Click the **+** at the bottom-left of the chat.
2. Open **Connectors**.
3. Toggle **GitHub** on for that conversation.

You only need to do this per-conversation if you want fine-grained control —
Claude can be told to "always use GitHub" via the connector settings.

## Try it

Quick smoke tests once it's connected:

- "List my GitHub repos, most recently updated first."
- "Show open issues on `<your-username>/claude-telegram-bot`."
- "Create a new private repo called `scratchpad`."
- "In `claude-telegram-bot`, open an issue titled 'Add per-user allow-list'."

## Revoke / remove

- **In Claude**: <https://claude.ai/customize/connectors> → three dots →
  Remove.
- **On GitHub**: <https://github.com/settings/applications> → revoke the
  Claude / GitHub MCP app authorization.

## Couple of notes

- Connection originates from **Anthropic's servers**, not your laptop. So your
  laptop's firewall/VPN doesn't matter, but the remote MCP server has to be
  reachable from the public internet (it is — it's hosted by GitHub).
- Claude can take destructive actions through this connector (delete repos,
  force-push, close issues). It will ask for approval on tool calls; only
  click "Allow always" for actions you trust unsupervised.
- If you ever want a local alternative (no Anthropic-hosted broker), the same
  server is also available as a Docker image at
  `ghcr.io/github/github-mcp-server`, configured via
  `~/Library/Application Support/Claude/claude_desktop_config.json`. Ask me
  and I can set that up too.

## Sources

- [Get started with custom connectors using remote MCP — Claude Help Center](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp)
- [GitHub's official MCP server (github/github-mcp-server)](https://github.com/github/github-mcp-server)

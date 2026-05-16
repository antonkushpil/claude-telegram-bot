/**
 * Entry point. Hono HTTP server with three routes:
 *
 *   GET  /                       health check
 *   POST /<TELEGRAM_BOT_TOKEN>   Telegram webhook
 *   ALL  /mcp-<MCP_SECRET>/mcp   MCP server (Streamable HTTP)
 *
 * On boot, registers the Telegram webhook with PUBLIC_URL automatically.
 */

import { serve, type ServerType } from "@hono/node-server";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import type { IncomingMessage, ServerResponse } from "node:http";
import { config, TELEGRAM_API } from "./config.js";
import { getOwnerChatIdOrFallback } from "./db.js";
import { mcpServer } from "./mcp.js";
import { bot } from "./telegram.js";

// ---------------------------------------------------------------------------
// MCP session management (stateful Streamable HTTP)
// ---------------------------------------------------------------------------

const mcpTransports = new Map<string, StreamableHTTPServerTransport>();

async function getOrCreateTransport(
  sessionId: string | undefined,
): Promise<StreamableHTTPServerTransport> {
  if (sessionId) {
    const existing = mcpTransports.get(sessionId);
    if (existing) return existing;
  }
  // Use `let` to allow the onsessioninitialized callback to reference the
  // not-yet-initialized binding without TS strict TDZ errors.
  let transport: StreamableHTTPServerTransport;
  transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: (id) => {
      mcpTransports.set(id, transport);
    },
  });
  transport.onclose = () => {
    if (transport.sessionId) mcpTransports.delete(transport.sessionId);
  };
  await mcpServer.connect(transport);
  return transport;
}

// ---------------------------------------------------------------------------
// Hono app
// ---------------------------------------------------------------------------

type Env = {
  Bindings: {
    incoming: IncomingMessage;
    outgoing: ServerResponse;
  };
};

const app = new Hono<Env>();

app.get("/", (c) =>
  c.json({
    ok: true,
    service: "claude-tg-bot",
    model: config.claudeModel,
    mcp_enabled: config.mcpSecret !== null,
    owner_chat_id_known: getOwnerChatIdOrFallback() !== null,
  }),
);

// Telegram webhook. The token in the path is the unguessable shared secret;
// WEBHOOK_SECRET (if set) is the proper auth via header.
app.post(`/${config.telegramBotToken}`, async (c) => {
  if (config.webhookSecret) {
    const sent = c.req.header("x-telegram-bot-api-secret-token");
    if (sent !== config.webhookSecret) {
      console.warn("[webhook] auth failed (header mismatch)");
      return c.body(null, 401);
    }
  }
  let update: unknown;
  try {
    update = await c.req.json();
  } catch {
    return c.body(null, 400);
  }
  try {
    // grammy's handleUpdate runs the full middleware chain.
    await bot.handleUpdate(update as Parameters<typeof bot.handleUpdate>[0]);
  } catch (err) {
    console.error("[webhook] handler threw", err);
  }
  return c.body(null, 200);
});

// MCP endpoint — only mounted when MCP_SECRET is set.
if (config.mcpSecret) {
  const mcpPath = `/mcp-${config.mcpSecret}/mcp`;

  app.all(mcpPath, async (c) => {
    const req = c.env.incoming;
    const res = c.env.outgoing;
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    const transport = await getOrCreateTransport(sessionId);

    // For POST requests, parse the body and pass it to the transport.
    let parsedBody: unknown = undefined;
    if (req.method === "POST") {
      try {
        parsedBody = await c.req.json();
      } catch {
        parsedBody = undefined;
      }
    }

    await transport.handleRequest(req, res, parsedBody);

    // The transport writes to `res` directly. Tell Hono not to send a response.
    // Returning a Response object Hono will see `res.writableEnded` and skip
    // its own write. An empty body is the safe sentinel.
    return c.body(null);
  });
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

async function registerTelegramWebhook(): Promise<void> {
  if (!config.publicUrl) {
    console.warn(
      "[boot] PUBLIC_URL not set — running without a webhook. Telegram will " +
        "not deliver updates. Set PUBLIC_URL on Railway to fix.",
    );
    return;
  }
  const url = `${config.publicUrl}/${config.telegramBotToken}`;
  try {
    const body: Record<string, unknown> = {
      url,
      allowed_updates: [
        "message",
        "edited_message",
        "callback_query",
        "channel_post",
      ],
      drop_pending_updates: false,
    };
    if (config.webhookSecret) body["secret_token"] = config.webhookSecret;
    const r = await fetch(`${TELEGRAM_API}/setWebhook`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = (await r.json()) as { ok: boolean; description?: string };
    if (!data.ok) {
      console.error("[boot] setWebhook failed:", data.description);
    } else {
      console.log(`[boot] Telegram webhook set to ${url}`);
    }
  } catch (err) {
    console.error("[boot] setWebhook error", err);
  }
}

async function main(): Promise<ServerType> {
  // grammy's init has to happen before handleUpdate is called.
  await bot.init();

  await registerTelegramWebhook();

  if (config.mcpSecret) {
    console.log(
      `[boot] MCP endpoint enabled at /mcp-${config.mcpSecret.slice(0, 4)}…/mcp`,
    );
  } else {
    console.log("[boot] MCP_SECRET not set — MCP endpoint disabled.");
  }

  const server = serve({
    fetch: app.fetch,
    port: config.port,
    hostname: "0.0.0.0",
  });

  console.log(`[boot] listening on :${config.port}`);

  const shutdown = (sig: string) => {
    console.log(`[shutdown] ${sig} received, closing…`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 5000).unref();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  return server;
}

main().catch((err) => {
  console.error("[boot] fatal", err);
  process.exit(1);
});

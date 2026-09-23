#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";

import { registerAccountTools } from "./tools/accounts.mjs";
import { registerTemplateTools } from "./tools/templates.mjs";
import { registerMessagingTools } from "./tools/messaging.mjs";
import { registerGenericTools } from "./tools/generic.mjs";
import { registerResources } from "./resources.mjs";
import { consumeUpload } from "./template-upload-browser.mjs";

export function buildServer() {
  const server = new McpServer({
    name: "whatsapp-business",
    version: "1.1.0",
  });

  registerAccountTools(server);
  registerTemplateTools(server);
  registerMessagingTools(server);
  registerGenericTools(server);
  registerResources(server);

  return server;
}

async function startStdio() {
  const server = buildServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// Streamable HTTP transport. Each session is held in-memory by sessionId so the
// transport can multiplex multiple clients on the same Node process. Suitable
// for deploying to Railway, Fly.io, Render, etc.
async function startHttp() {
  const port = Number(process.env.PORT || 3000);
  const host = process.env.HOST || "0.0.0.0";
  const path = process.env.MCP_HTTP_PATH || "/mcp";
  const bearer = process.env.MCP_BEARER_TOKEN; // optional shared secret

  const sessions = new Map(); // sessionId -> { transport, server }

  const httpServer = createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (url.pathname === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, sessions: sessions.size }));
      return;
    }

    const uploadMatch = url.pathname.match(/^\/upload\/template-image\/([A-Za-z0-9_-]{43})$/);
    if (req.method === "POST" && uploadMatch) {
      try {
        const uploaded = await consumeUpload(req, uploadMatch[1]);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ received: true, file_name: uploaded.fileName, bytes: uploaded.bytes.length, sha256: uploaded.sha256 }));
      } catch (error) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: error.message }));
      }
      return;
    }

    if (url.pathname !== path) {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("Not found");
      return;
    }

    if (bearer) {
      const auth = req.headers["authorization"] || "";
      if (auth !== `Bearer ${bearer}`) {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "Unauthorized" }));
        return;
      }
    }

    const sessionId = req.headers["mcp-session-id"];
    let entry = sessionId ? sessions.get(sessionId) : null;

    if (!entry) {
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sid) => {
          sessions.set(sid, { transport, server });
        },
      });
      const server = buildServer();
      transport.onclose = () => {
        if (transport.sessionId) sessions.delete(transport.sessionId);
      };
      await server.connect(transport);
      entry = { transport, server };
    }

    try {
      await entry.transport.handleRequest(req, res);
    } catch (e) {
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      }
    }
  });

  httpServer.listen(port, host, () => {
    const authNote = bearer ? " (Bearer auth required)" : " (no auth — set MCP_BEARER_TOKEN to require)";
    console.error(`whatsapp-business MCP listening on http://${host}:${port}${path}${authNote}`);
  });
}

const transportMode = (process.env.MCP_TRANSPORT || "stdio").toLowerCase();
if (transportMode === "http" || transportMode === "sse") {
  await startHttp();
} else {
  await startStdio();
}

#!/usr/bin/env node
/**
 * @implexa/mcp-server — stdio proxy that forwards MCP requests to
 * IMPLEXA_API_URL/api/v2/mcp using the user's IMPLEXA_API_KEY.
 *
 * Why a proxy: Claude Desktop, Claude Code, Cursor — most MCP clients
 * speak stdio. Implexa's real MCP server runs over streamable HTTP at
 * core.implexa.ai. This shim bridges them: stdio in, HTTP out.
 *
 * Single update path — when we add new tools server-side, every user
 * sees them on the next restart without a plugin upgrade.
 *
 * Env vars (set in the user's shell or the plugin .mcp.json):
 *   IMPLEXA_API_KEY   required    'imp_live_...' from implexa.ai/settings
 *   IMPLEXA_API_URL   optional    base URL, defaults to https://core.implexa.ai
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { boundedTimeout, buildMcpEndpoint, callUpstream, safeFailureLine } from './upstream.js';

const API_KEY = process.env.IMPLEXA_API_KEY;
let MCP_URL;
try { MCP_URL = buildMcpEndpoint(process.env.IMPLEXA_API_URL); } catch (error) {
  process.stderr.write(`${safeFailureLine(error)}\n`);
  process.exit(1);
}

if (!API_KEY) {
  // Fail LOUD, don't limp along. Without a key the upstream authenticates as
  // nobody and tools/list returns an empty set — the server "connects" but
  // exposes ZERO tools. That silent-empty state is the worst failure mode:
  // unattended/scheduled runs see no Implexa tools and hang or no-op with no
  // signal. Exiting non-zero surfaces a real "MCP server failed" in the host
  // client (Claude Desktop/Code, Cursor) so the misconfiguration is visible.
  process.stderr.write(
    '[implexa-mcp-server] IMPLEXA_API_KEY not set — refusing to start.\n'
    + '  Visit https://implexa.ai/settings → API Keys to create one.\n'
    + '  Then set IMPLEXA_API_KEY in your client config (and, for scheduled/\n'
    + '  background runs, export it in your shell profile e.g. ~/.zshrc so the\n'
    + '  non-interactive runtime can read it too).\n'
  );
  process.exit(1);
}

const upstream = (method, params) => callUpstream({
  endpoint: MCP_URL, apiKey: API_KEY, method, params,
  timeoutMs: boundedTimeout(process.env.IMPLEXA_MCP_TIMEOUT_MS),
});

const server = new Server(
  { name: 'implexa-mcp-server', version: '0.1.1' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return await upstream('tools/list', {});
});

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  return await upstream('tools/call', req.params);
});

// A stdio initialize handshake alone is not a usable connection. Prove the
// configured key reaches the upstream and exposes the required control-plane
// capability before announcing the server to Claude.
try {
  const result = await upstream('tools/list', {});
  process.stderr.write(`[implexa-mcp-server] ${result.tools.length} tools available.\n`);
} catch (error) {
  process.stderr.write(`${safeFailureLine(error)}\n`);
  process.exit(1);
}

const transport = new StdioServerTransport();
await server.connect(transport);
process.stderr.write(`[implexa-mcp-server] connected to ${MCP_URL}\n`);

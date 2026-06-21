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

const API_KEY = process.env.IMPLEXA_API_KEY;
const API_URL = (process.env.IMPLEXA_API_URL || 'https://core.implexa.ai').replace(/\/$/, '');
const MCP_URL = `${API_URL}/api/v2/mcp`;

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

async function callUpstream(method, params) {
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });
  const res = await fetch(MCP_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${API_KEY || ''}`,
      'Content-Type':  'application/json',
      'Accept':        'application/json, text/event-stream',
    },
    body,
  });
  // Streamable HTTP may return either JSON or SSE; parse uniformly.
  const text = await res.text();
  // SSE frames look like "event: message\ndata: {...}\n\n". Pick the last data line.
  const dataLines = text.split('\n').filter(l => l.startsWith('data: '));
  const lastData = dataLines.length ? dataLines[dataLines.length - 1].slice(6) : text;
  let parsed;
  try { parsed = JSON.parse(lastData); }
  catch (_) { throw new Error(`Upstream returned malformed response (status ${res.status})`); }
  if (parsed.error) throw new Error(`${method} failed: ${parsed.error.message || JSON.stringify(parsed.error)}`);
  return parsed.result;
}

const server = new Server(
  { name: 'implexa-mcp-server', version: '0.1.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return await callUpstream('tools/list', {});
});

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  return await callUpstream('tools/call', req.params);
});

const transport = new StdioServerTransport();
await server.connect(transport);
process.stderr.write(`[implexa-mcp-server] connected to ${MCP_URL}\n`);

// Self-check: a KEY can be present but invalid/revoked, or pointed at a backend
// that doesn't recognize it — in which case the upstream returns 0 tools and the
// server looks "connected" while exposing nothing. That's the silent failure an
// unattended/scheduled runtime can't recover from. Probe tools/list once at
// startup and shout to stderr if it comes back empty so the misconfig is visible
// in the host client's MCP log. Best-effort: never throw (a transient network
// blip shouldn't take the server down — real calls will surface their own errors).
(async () => {
  try {
    const res = await callUpstream('tools/list', {});
    const n = (res && Array.isArray(res.tools)) ? res.tools.length : 0;
    if (n === 0) {
      process.stderr.write(
        `[implexa-mcp-server] WARNING: connected to ${MCP_URL} but tools/list is EMPTY.\n`
        + '  The API key is likely invalid/revoked, for a different account, or this\n'
        + '  URL is the wrong backend. No Implexa tools will be available. Re-create\n'
        + '  your key at https://implexa.ai/settings and re-set IMPLEXA_API_KEY.\n'
      );
    } else {
      process.stderr.write(`[implexa-mcp-server] ${n} tools available.\n`);
    }
  } catch (err) {
    process.stderr.write(`[implexa-mcp-server] startup tools/list probe failed: ${err.message}\n`);
  }
})();

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
  process.stderr.write(
    '[implexa-mcp-server] IMPLEXA_API_KEY not set.\n'
    + '  Visit https://implexa.ai/settings → API Keys to create one.\n'
    + '  Then set IMPLEXA_API_KEY in your client config.\n'
  );
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

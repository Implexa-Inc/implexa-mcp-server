# @implexa/mcp-server

The official MCP proxy for Implexa. Bridges MCP-over-stdio clients (Claude Desktop, Claude Code, Cursor, etc.) to Implexa's HTTP backend at `core.implexa.ai`.

## Install

```bash
npm install -g @implexa/mcp-server
```

Or invoke via `npx`:

```bash
npx -y @implexa/mcp-server
```

The Implexa Claude Code plugin wires this up automatically — install the plugin and you're done.

## Configuration

Two env vars:

```bash
IMPLEXA_API_KEY=imp_live_...                    # required — from implexa.ai/settings
IMPLEXA_API_URL=https://core.implexa.ai         # optional — override for local dev
```

For local dev against `implexa-backend` on port 8001:

```bash
export IMPLEXA_API_URL=http://localhost:8001
```

## What it does

- Accepts MCP requests on stdio
- Forwards `tools/list` and `tools/call` to `${IMPLEXA_API_URL}/api/v2/mcp` with `Authorization: Bearer ${IMPLEXA_API_KEY}`
- Returns the upstream response verbatim

That's it — single update path. When Implexa ships new tools server-side, every user gets them on the next client restart without a package upgrade.

## License

MIT

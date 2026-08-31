import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function loopback(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function proxyTransport(url, apiKey = 'test-key') {
  return new StdioClientTransport({
    command: process.execPath,
    args: ['src/index.js'],
    cwd: root,
    stderr: 'pipe',
    env: { ...process.env, IMPLEXA_API_URL: url, IMPLEXA_API_KEY: apiKey, IMPLEXA_MCP_TIMEOUT_MS: '2000' },
  });
}

test('real stdio client completes initialize, tools/list and tools/call through loopback HTTP', async (t) => {
  const seen = [];
  const local = await loopback(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const message = JSON.parse(body);
    seen.push({ method: message.method, auth: req.headers.authorization, id: message.id });
    const result = message.method === 'tools/list'
      ? { tools: [{ name: 'get_pending_run_requests', description: 'test', inputSchema: { type: 'object', properties: {} } }] }
      : { content: [{ type: 'text', text: 'loopback-ok' }] };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
  });
  t.after(() => local.close());

  const transport = proxyTransport(local.url);
  const client = new Client({ name: 'proxy-lifecycle-test', version: '1.0.0' });
  t.after(() => client.close().catch(() => {}));
  await client.connect(transport);
  const listed = await client.listTools();
  assert.deepEqual(listed.tools.map((tool) => tool.name), ['get_pending_run_requests']);
  const called = await client.callTool({ name: 'get_pending_run_requests', arguments: {} });
  assert.equal(called.content[0].text, 'loopback-ok');
  assert.deepEqual(seen.map((item) => item.method), ['tools/list', 'tools/list', 'tools/call']);
  assert.ok(seen.every((item) => item.auth === 'Bearer test-key'));
  assert.equal(new Set(seen.map((item) => item.id)).size, seen.length);
});

test('real stdio startup refuses an upstream authentication failure', async (t) => {
  const local = await loopback(async (_req, res) => {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not authorized', secret: 'must-not-surface' }));
  });
  t.after(() => local.close());
  const transport = proxyTransport(local.url, 'bad-key');
  const stderr = [];
  transport.stderr?.on('data', (chunk) => stderr.push(String(chunk)));
  const client = new Client({ name: 'proxy-refusal-test', version: '1.0.0' });
  let timer;
  const boundedConnect = (async () => {
    try {
      return await Promise.race([
        client.connect(transport),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('connect timed out')), 4000); }),
      ]);
    } finally { clearTimeout(timer); }
  })();
  await assert.rejects(boundedConnect);
  await transport.close().catch(() => {});
  const diagnostic = stderr.join('');
  assert.match(diagnostic, /auth_refused/);
  assert.doesNotMatch(diagnostic, /must-not-surface|bad-key/);
});

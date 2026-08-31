import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { boundedTimeout, buildMcpEndpoint, callUpstream, parseEnvelope, ProxyFailure, safeFailureLine } from './upstream.js';

const endpoint = 'https://core.implexa.ai/api/v2/mcp';
const response = (status, body) => ({ ok: status >= 200 && status < 300, status, text: async () => body });
const requestId = 'test-request';
const envelope = (result, id = requestId) => JSON.stringify({ jsonrpc: '2.0', id, result });

async function loopback(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return server;
}

async function connectionCount(server) {
  return new Promise((resolve, reject) => server.getConnections((error, count) => (
    error ? reject(error) : resolve(count)
  )));
}

async function waitForNoConnections(server, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await connectionCount(server) === 0) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return (await connectionCount(server)) === 0;
}

test('accepts JSON and SSE tools/list only with required control-plane capability', async () => {
  const result = await callUpstream({
    endpoint, apiKey: 'secret', method: 'tools/list', params: {}, requestId,
    fetchImpl: async (_url, init) => {
      assert.equal(init.redirect, 'error');
      assert.equal(init.headers.Authorization, 'Bearer secret');
      assert.equal(init.body.includes('secret'), false);
      return response(200, `event: message\ndata:${envelope({ tools: [{ name: 'get_pending_run_requests' }] })}\n\n`);
    },
  });
  assert.equal(result.tools[0].name, 'get_pending_run_requests');
});

test('endpoint validation permits HTTPS or loopback HTTP, strips query/hash and rejects embedded credentials', () => {
  assert.equal(buildMcpEndpoint('https://core.implexa.ai?key=leak#fragment'), 'https://core.implexa.ai/api/v2/mcp');
  assert.equal(buildMcpEndpoint('http://127.0.0.1:8000/dev/'), 'http://127.0.0.1:8000/dev/api/v2/mcp');
  assert.throws(() => buildMcpEndpoint('http://core.implexa.ai'), { code: 'endpoint_invalid' });
  assert.throws(() => buildMcpEndpoint('https://user:secret@core.implexa.ai'), { code: 'endpoint_invalid' });
});

test('timeout configuration is numeric and clamped to one through thirty seconds', () => {
  assert.equal(boundedTimeout(undefined), 10_000);
  assert.equal(boundedTimeout('bad'), 10_000);
  assert.equal(boundedTimeout(-1), 1_000);
  assert.equal(boundedTimeout(999_999), 30_000);
  assert.equal(boundedTimeout(4_321.9), 4_321);
});

test('missing credential, auth refusal, malformed payload and missing capability are typed', async () => {
  await assert.rejects(callUpstream({ endpoint, method: 'tools/list', params: {}, requestId }), { code: 'credential_missing' });
  await assert.rejects(callUpstream({ endpoint, apiKey: 'secret', method: 'tools/list', params: {}, requestId, fetchImpl: async () => response(401, '') }), { code: 'auth_refused' });
  await assert.rejects(callUpstream({ endpoint, apiKey: 'secret', method: 'tools/list', params: {}, requestId, fetchImpl: async () => response(200, 'bad') }), { code: 'upstream_protocol_invalid' });
  await assert.rejects(callUpstream({ endpoint, apiKey: 'secret', method: 'tools/list', params: {}, requestId, fetchImpl: async () => response(200, envelope({ tools: [] })) }), { code: 'capability_missing' });
  await assert.rejects(callUpstream({ endpoint, apiKey: 'secret', method: 'tools/list', params: {}, requestId, fetchImpl: async () => response(200, envelope({ tools: [{ name: 'get_pending_run_requests' }] }, 'wrong')) }), { code: 'upstream_protocol_invalid' });
});

test('a hanging upstream is aborted within the explicit timeout', async () => {
  const started = Date.now();
  await assert.rejects(callUpstream({
    endpoint, apiKey: 'secret', method: 'tools/list', params: {}, timeoutMs: 1_000, requestId,
    fetchImpl: async (_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    }),
  }), { code: 'upstream_timeout' });
  assert.ok(Date.now() - started < 1_500);
});

test('timeout remains active while the response body is streaming', async () => {
  await assert.rejects(callUpstream({
    endpoint, apiKey: 'secret', method: 'tools/list', params: {}, timeoutMs: 1_000, requestId,
    fetchImpl: async () => ({ ok: true, status: 200, text: async () => new Promise(() => {}) }),
  }), { code: 'upstream_timeout' });
});

test('response body is bounded even when content-length is absent', async () => {
  await assert.rejects(callUpstream({
    endpoint, apiKey: 'secret', method: 'tools/list', params: {}, requestId, maxResponseBytes: 32,
    fetchImpl: async () => response(200, envelope({ tools: [{ name: 'get_pending_run_requests' }] })),
  }), { code: 'upstream_response_too_large' });
});

test('oversize and non-OK hanging responses release their loopback sockets', async (t) => {
  for (const scenario of ['oversize', 'auth']) {
    const server = await loopback((_req, res) => {
      const status = scenario === 'auth' ? 401 : 200;
      res.writeHead(status, {
        'content-type': 'application/json',
        'content-length': String(9 * 1024 * 1024),
      });
      res.write('{'); // headers arrive; the deliberately incomplete body never ends
    });
    t.after(() => {
      server.closeAllConnections();
      return new Promise((resolve) => server.close(resolve));
    });
    const url = `http://127.0.0.1:${server.address().port}`;
    await assert.rejects(callUpstream({
      endpoint: url, apiKey: 'secret', method: 'tools/list', params: {}, requestId, timeoutMs: 2000,
    }), { code: scenario === 'auth' ? 'auth_refused' : 'upstream_response_too_large' });
    assert.equal(await waitForNoConnections(server), true, `${scenario} response retained its HTTP connection`);
  }
});

test('safe diagnostics contain only typed text, never provider bodies or credentials', () => {
  const line = safeFailureLine(new ProxyFailure('auth_refused', 'Implexa rejected the configured credential'));
  assert.match(line, /auth_refused/);
  assert.equal(line.includes('secret'), false);
  assert.throws(() => parseEnvelope('imp_live_secret'), { code: 'upstream_protocol_invalid' });
});

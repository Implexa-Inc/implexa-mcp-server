import test from 'node:test';
import assert from 'node:assert/strict';
import { boundedTimeout, buildMcpEndpoint, callUpstream, parseEnvelope, ProxyFailure, safeFailureLine } from './upstream.js';

const endpoint = 'https://core.implexa.ai/api/v2/mcp';
const response = (status, body) => ({ ok: status >= 200 && status < 300, status, text: async () => body });

test('accepts JSON and SSE tools/list only with required control-plane capability', async () => {
  const result = await callUpstream({
    endpoint, apiKey: 'secret', method: 'tools/list', params: {},
    fetchImpl: async (_url, init) => {
      assert.equal(init.redirect, 'error');
      assert.equal(init.headers.Authorization, 'Bearer secret');
      assert.equal(init.body.includes('secret'), false);
      return response(200, 'event: message\ndata: {"result":{"tools":[{"name":"get_pending_run_requests"}]}}\n\n');
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
  await assert.rejects(callUpstream({ endpoint, method: 'tools/list', params: {} }), { code: 'credential_missing' });
  await assert.rejects(callUpstream({ endpoint, apiKey: 'secret', method: 'tools/list', params: {}, fetchImpl: async () => response(401, '') }), { code: 'auth_refused' });
  await assert.rejects(callUpstream({ endpoint, apiKey: 'secret', method: 'tools/list', params: {}, fetchImpl: async () => response(200, 'bad') }), { code: 'upstream_protocol_invalid' });
  await assert.rejects(callUpstream({ endpoint, apiKey: 'secret', method: 'tools/list', params: {}, fetchImpl: async () => response(200, '{"result":{"tools":[]}}') }), { code: 'capability_missing' });
});

test('a hanging upstream is aborted within the explicit timeout', async () => {
  const started = Date.now();
  await assert.rejects(callUpstream({
    endpoint, apiKey: 'secret', method: 'tools/list', params: {}, timeoutMs: 1_000,
    fetchImpl: async (_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    }),
  }), { code: 'upstream_timeout' });
  assert.ok(Date.now() - started < 1_500);
});

test('safe diagnostics contain only typed text, never provider bodies or credentials', () => {
  const line = safeFailureLine(new ProxyFailure('auth_refused', 'Implexa rejected the configured credential'));
  assert.match(line, /auth_refused/);
  assert.equal(line.includes('secret'), false);
  assert.throws(() => parseEnvelope('imp_live_secret'), { code: 'upstream_protocol_invalid' });
});

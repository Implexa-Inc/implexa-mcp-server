import { randomUUID } from 'node:crypto';

const DEFAULT_TIMEOUT_MS = 10_000;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

export class ProxyFailure extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ProxyFailure';
    this.code = code;
  }
}

export function parseEnvelope(text) {
  const raw = String(text || '');
  const events = raw.split(/\r?\n\r?\n/);
  let payload = raw;
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const data = events[i].split(/\r?\n/)
      .map((line) => /^data:\s?(.*)$/.exec(line))
      .filter(Boolean)
      .map((match) => match[1]);
    if (data.length) { payload = data.join('\n'); break; }
  }
  try { return JSON.parse(payload); } catch {
    throw new ProxyFailure('upstream_protocol_invalid', 'Upstream returned an invalid MCP envelope');
  }
}

function abortFailure(signal) {
  let onAbort;
  const promise = new Promise((_, reject) => {
    if (signal.aborted) {
      reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      return;
    }
    onAbort = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    signal.addEventListener('abort', onAbort, { once: true });
  });
  return { promise, dispose: () => { if (onAbort) signal.removeEventListener('abort', onAbort); } };
}

export async function readBoundedBody(response, { signal, maxBytes = MAX_RESPONSE_BYTES } = {}) {
  const declared = Number(response?.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new ProxyFailure('upstream_response_too_large', 'Implexa MCP upstream response exceeded the safe limit');
  }
  if (response?.body && typeof response.body.getReader === 'function') {
    const reader = response.body.getReader();
    const aborted = abortFailure(signal);
    const chunks = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await Promise.race([reader.read(), aborted.promise]);
        if (done) break;
        size += value.byteLength;
        if (size > maxBytes) {
          try { await reader.cancel(); } catch { /* best effort */ }
          throw new ProxyFailure('upstream_response_too_large', 'Implexa MCP upstream response exceeded the safe limit');
        }
        chunks.push(value);
      }
    } finally {
      aborted.dispose();
      try { reader.releaseLock(); } catch { /* best effort */ }
    }
    const joined = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.byteLength; }
    return new TextDecoder().decode(joined);
  }
  const aborted = abortFailure(signal);
  let text;
  try { text = await Promise.race([response.text(), aborted.promise]); }
  finally { aborted.dispose(); }
  if (Buffer.byteLength(text, 'utf8') > maxBytes) {
    throw new ProxyFailure('upstream_response_too_large', 'Implexa MCP upstream response exceeded the safe limit');
  }
  return text;
}

export function boundedTimeout(value, fallback = DEFAULT_TIMEOUT_MS) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Math.trunc(parsed)));
}

export function buildMcpEndpoint(value) {
  let url;
  try { url = new URL(value || 'https://core.implexa.ai'); } catch {
    throw new ProxyFailure('endpoint_invalid', 'Implexa MCP endpoint is invalid');
  }
  const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '::1';
  if (url.username || url.password || (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))) {
    throw new ProxyFailure('endpoint_invalid', 'Implexa MCP endpoint is not trusted');
  }
  url.pathname = `${url.pathname.replace(/\/$/, '')}/api/v2/mcp`;
  url.search = '';
  url.hash = '';
  return url.toString();
}

export async function callUpstream({ endpoint, apiKey, method, params, fetchImpl = fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS, requestId = randomUUID(), maxResponseBytes = MAX_RESPONSE_BYTES }) {
  if (!apiKey) throw new ProxyFailure('credential_missing', 'Implexa credential is not configured');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), boundedTimeout(timeoutMs));
  try {
    const response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params }),
      signal: controller.signal,
      redirect: 'error',
    });
    if (response.status === 401 || response.status === 403) {
      throw new ProxyFailure('auth_refused', 'Implexa rejected the configured credential');
    }
    if (!response.ok) {
      throw new ProxyFailure(response.status >= 500 ? 'upstream_unavailable' : 'upstream_refused',
        `Implexa MCP upstream refused the request (status ${response.status})`);
    }
    const parsed = parseEnvelope(await readBoundedBody(response, { signal: controller.signal, maxBytes: maxResponseBytes }));
    if (parsed?.jsonrpc !== '2.0' || parsed.id !== requestId) {
      throw new ProxyFailure('upstream_protocol_invalid', 'Upstream MCP response identity did not match the request');
    }
    if (parsed.error) throw new ProxyFailure('upstream_rpc_error', `Implexa MCP ${method} failed`);
    if (!Object.prototype.hasOwnProperty.call(parsed, 'result')) {
      throw new ProxyFailure('upstream_protocol_invalid', 'Upstream MCP response omitted result');
    }
    if (method === 'tools/list') {
      if (!parsed.result || !Array.isArray(parsed.result.tools)) {
        throw new ProxyFailure('upstream_protocol_invalid', 'Upstream MCP tools/list result is invalid');
      }
      if (!parsed.result.tools.some((tool) => tool && tool.name === 'get_pending_run_requests')) {
        throw new ProxyFailure('capability_missing', 'Required Implexa control-plane capability is unavailable');
      }
    }
    return parsed.result;
  } catch (error) {
    if (error instanceof ProxyFailure) throw error;
    const timedOut = controller.signal.aborted || (error && error.name === 'AbortError');
    throw new ProxyFailure(timedOut ? 'upstream_timeout' : 'upstream_unreachable',
      timedOut ? 'Implexa MCP upstream timed out' : 'Implexa MCP upstream is unreachable');
  } finally {
    clearTimeout(timer);
  }
}

export function safeFailureLine(error) {
  const code = error instanceof ProxyFailure ? error.code : 'internal_error';
  const message = error instanceof ProxyFailure ? error.message : 'Implexa MCP proxy failed';
  return `[implexa-mcp-server] ${code}: ${message}`;
}

export { MAX_RESPONSE_BYTES };

const DEFAULT_TIMEOUT_MS = 10_000;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 30_000;

export class ProxyFailure extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ProxyFailure';
    this.code = code;
  }
}

export function parseEnvelope(text) {
  const lines = String(text || '').split(/\r?\n/).filter((line) => line.startsWith('data: '));
  const payload = lines.length ? lines[lines.length - 1].slice(6) : String(text || '');
  try { return JSON.parse(payload); } catch {
    throw new ProxyFailure('upstream_protocol_invalid', 'Upstream returned an invalid MCP envelope');
  }
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

export async function callUpstream({ endpoint, apiKey, method, params, fetchImpl = fetch, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  if (!apiKey) throw new ProxyFailure('credential_missing', 'Implexa credential is not configured');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), boundedTimeout(timeoutMs));
  let response;
  try {
    response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: controller.signal,
      redirect: 'error',
    });
  } catch (error) {
    const timedOut = controller.signal.aborted || (error && error.name === 'AbortError');
    throw new ProxyFailure(timedOut ? 'upstream_timeout' : 'upstream_unreachable',
      timedOut ? 'Implexa MCP upstream timed out' : 'Implexa MCP upstream is unreachable');
  } finally {
    clearTimeout(timer);
  }
  if (response.status === 401 || response.status === 403) {
    throw new ProxyFailure('auth_refused', 'Implexa rejected the configured credential');
  }
  if (!response.ok) {
    throw new ProxyFailure(response.status >= 500 ? 'upstream_unavailable' : 'upstream_refused',
      `Implexa MCP upstream refused the request (status ${response.status})`);
  }
  const parsed = parseEnvelope(await response.text());
  if (parsed.error) throw new ProxyFailure('upstream_rpc_error', `Implexa MCP ${method} failed`);
  if (!parsed.result) throw new ProxyFailure('upstream_protocol_invalid', 'Upstream MCP response omitted result');
  if (method === 'tools/list') {
    if (!Array.isArray(parsed.result.tools)) {
      throw new ProxyFailure('upstream_protocol_invalid', 'Upstream MCP tools/list result is invalid');
    }
    if (!parsed.result.tools.some((tool) => tool && tool.name === 'get_pending_run_requests')) {
      throw new ProxyFailure('capability_missing', 'Required Implexa control-plane capability is unavailable');
    }
  }
  return parsed.result;
}

export function safeFailureLine(error) {
  const code = error instanceof ProxyFailure ? error.code : 'internal_error';
  const message = error instanceof ProxyFailure ? error.message : 'Implexa MCP proxy failed';
  return `[implexa-mcp-server] ${code}: ${message}`;
}

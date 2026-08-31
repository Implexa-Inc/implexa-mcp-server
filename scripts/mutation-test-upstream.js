import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

const file = new URL('../src/upstream.js', import.meta.url);
const original = fs.readFileSync(file, 'utf8');
const mutations = [
  ["if (!apiKey) throw new ProxyFailure('credential_missing'", "if (false) throw new ProxyFailure('credential_missing'"],
  ["if (response.status === 401 || response.status === 403)", "if (false)"],
  ["const timedOut = controller.signal.aborted || (error && error.name === 'AbortError');", "const timedOut = false;"],
  ["if (!parsed.result.tools.some((tool) => tool && tool.name === 'get_pending_run_requests'))", "if (false)"],
  ["redirect: 'error'", "redirect: 'follow'"],
  ["if (url.username || url.password || (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)))", "if (false)"],
  ["url.search = '';", "url.search = url.search;"],
  ["return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Math.trunc(parsed)));", "return Math.trunc(parsed);"],
  ["if (parsed?.jsonrpc !== '2.0' || parsed.id !== requestId)", "if (false)"],
  ["if (Buffer.byteLength(text, 'utf8') > maxBytes)", "if (false)"],
];
let killed = 0;
try {
  for (const [anchor, replacement] of mutations) {
    const mutant = original.replace(anchor, replacement);
    if (mutant === original) throw new Error(`missing mutation seam: ${anchor}`);
    fs.writeFileSync(file, mutant);
    const run = spawnSync(process.execPath, ['--test', 'src/upstream.test.js'], { cwd: new URL('..', import.meta.url), encoding: 'utf8' });
    if (run.status === 0) throw new Error(`SURVIVED: ${anchor}`);
    killed += 1;
  }
} finally {
  fs.writeFileSync(file, original);
}
process.stdout.write(`MCP upstream mutations killed: ${killed}/${mutations.length}\n`);

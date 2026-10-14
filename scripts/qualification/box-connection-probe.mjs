import { Agent, globalAgent, request } from 'node:https';
import { createHash } from 'node:crypto';
import { channel } from 'node:diagnostics_channel';
import { apiRequest } from './box-upload.mjs';

const { URL, AbortSignal, Buffer, performance } = globalThis;
const origin = 'https://box.nju.edu.cn';
const token = process.env.MIZAR_BOX_REPO_TOKEN;
const safeCodes = new Set(['ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'BOX_RESPONSE_LIMIT']);
const code = (error) => safeCodes.has(error?.code ?? error?.cause?.code)
  ? error?.code ?? error?.cause?.code : error?.name === 'TimeoutError' || error?.name === 'AbortError' ? 'timeout' : 'unknown';
let activeFetch;
for (const phase of ['beforeConnect', 'connected', 'connectError']) {
  channel(`undici:client:${phase}`).subscribe((message) => {
    if (activeFetch) activeFetch(`fetch_${phase}`, phase === 'connectError' ? { code: code(message.error) } : {});
  });
}
async function probe(label, transport, path, fresh = false) {
  const began = performance.now();
  const record = (phase, fields = {}) => console.log(JSON.stringify({ label, phase, elapsedMs: Math.round(performance.now() - began), ...fields }));
  const url = new URL('/api/v2.1/via-repo-token/download-link/', origin);
  url.searchParams.set('path', path);
  const options = { method: 'GET', headers: { Authorization: `Token ${token}`, Accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(120000) };
  const agent = fresh ? new Agent({ ...globalAgent.options, keepAlive: false }) : undefined;
  record('begin', { transport, freshAgent: fresh });
  try {
    let response;
    if (transport === 'native') {
      response = await apiRequest(url, options, (target, requestOptions, callback) => {
        const outgoing = request(target, { ...requestOptions, ...(agent ? { agent } : {}) }, (incoming) => {
          record('headers', { status: incoming.statusCode });
          let bytes = 0;
          incoming.on('data', (chunk) => { bytes += chunk.length; });
          incoming.on('end', () => record('body_end', { bytes }));
          incoming.on('aborted', () => record('body_aborted'));
          incoming.on('error', (error) => record('body_error', { code: code(error) }));
          callback(incoming);
        });
        outgoing.on('socket', (socket) => {
          record('socket', { reused: outgoing.reusedSocket });
          socket.once('lookup', (error, _address, family) => record('lookup', { family, ...(error ? { code: code(error) } : {}) }));
          socket.once('connect', () => record('connect'));
          socket.once('secureConnect', () => record('tls', { authorized: socket.authorized, sessionReused: socket.isSessionReused(), peerHash: createHash('sha256').update(socket.remoteAddress ?? '').digest('hex').slice(0, 12) }));
          socket.once('timeout', () => record('socket_timeout'));
        });
        outgoing.on('finish', () => record('request_sent'));
        outgoing.on('error', (error) => record('request_error', { code: code(error) }));
        return outgoing;
      });
    } else {
      activeFetch = record;
      response = await globalThis.fetch(url, options);
      record('headers', { status: response.status });
    }
    if (!response.ok) { await response.body?.cancel(); record('http_terminal', { status: response.status }); return; }
    const chunks = [];
    let bytes = 0;
    for await (const chunk of response.body) {
      bytes += chunk.length;
      if (bytes > 2 * 1024 * 1024) throw Object.assign(new Error('limit'), { code: 'BOX_RESPONSE_LIMIT' });
      chunks.push(Buffer.from(chunk));
    }
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const link = typeof value === 'string' ? new URL(value) : undefined;
    record('success', { bytes, validLink: Boolean(link && link.origin === origin && link.pathname.startsWith('/seafhttp/')) });
  } catch (error) { record('failure', { code: code(error) }); }
  finally { activeFetch = undefined; agent?.destroy(); }
}
async function main() {
  if (!token) throw new Error('missing token');
  console.log(JSON.stringify({ node: process.version, globalKeepAlive: globalAgent.options.keepAlive, globalSocketTimeout: globalAgent.options.timeout, proxyConfigured: Boolean(process.env.HTTPS_PROXY || process.env.HTTP_PROXY) }));
  const stable = '/Stable/Mizar-v1.3.3-Windows-x64-Setup.exe';
  const runtime = '/Runtime/v1.3.4/machine-metadata.json';
  await probe('control_before_A1', 'native', runtime);
  await new Promise((resolve) => globalThis.setTimeout(resolve, 30000));
  await probe('A1_native_stable', 'native', stable);
  await probe('B1_fetch_stable', 'fetch', stable);
  await probe('B2_fetch_stable', 'fetch', stable);
  await probe('control_before_A2', 'native', runtime);
  await new Promise((resolve) => globalThis.setTimeout(resolve, 30000));
  await probe('A2_native_stable', 'native', stable);
  await probe('C_fresh_native_stable', 'native', stable, true);
}
main().catch(() => { console.error('Read-only connection probe initialization failed'); process.exitCode = 1; });

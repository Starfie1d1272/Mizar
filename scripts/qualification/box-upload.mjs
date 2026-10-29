import { request as httpsRequest } from 'node:https';
import { Buffer } from 'node:buffer';

const { Headers, Request, Response, performance } = globalThis;

function boundConnection(outgoing) {
  const connecting = globalThis.setTimeout(
    () =>
      outgoing.destroy(Object.assign(new Error('Box connection timeout'), { code: 'ETIMEDOUT' })),
    15000,
  );
  const connected = () => globalThis.clearTimeout(connecting);
  outgoing.on('socket', (socket) => {
    if (!socket.connecting && !socket.secureConnecting) connected();
    else socket.once('secureConnect', connected);
  });
  outgoing.once('close', connected);
  outgoing.setTimeout(60000, () =>
    outgoing.destroy(Object.assign(new Error('Box socket stalled'), { code: 'ETIMEDOUT' })),
  );
}

// Small JSON API requests use the caller's deadline, including connection setup.
// Do not follow redirects or replay mutations when a response is uncertain.
export async function apiRequest(url, options, request = httpsRequest) {
  options.signal.throwIfAborted();
  if (options.body !== undefined && typeof options.body !== 'string')
    throw new Error('Box API body must be the original JSON string');
  const body = options.body === undefined ? undefined : Buffer.from(options.body);
  const headers = Object.fromEntries(new Headers(options.headers).entries());
  if (body) headers['content-length'] = String(body.length);
  return new Promise((resolve, reject) => {
    let secureConnected = false;
    const outgoing = request(
      url,
      { method: options.method ?? 'GET', headers, signal: options.signal },
      (incoming) => {
        let locallyDestroyed = false;
        incoming.on('error', reject);
        incoming.on('close', () => {
          if (!incoming.complete && !locallyDestroyed) {
            reject(
              options.signal.aborted
                ? options.signal.reason
                : Object.assign(new Error('Box API response interrupted'), { code: 'ECONNRESET' }),
            );
          }
        });
        const status = incoming.statusCode;
        if (!Number.isInteger(status) || status < 200 || status > 599) {
          locallyDestroyed = true;
          reject(new Error('Box API response status invalid'));
          incoming.destroy();
          return;
        }
        if (status >= 300) {
          locallyDestroyed = true;
          resolve(
            new Response(null, {
              status,
              headers: incoming.headers['retry-after']
                ? { 'Retry-After': incoming.headers['retry-after'] }
                : {},
            }),
          );
          incoming.destroy();
          return;
        }
        const chunks = [];
        let size = 0;
        incoming.on('data', (chunk) => {
          size += chunk.length;
          if (size > 2 * 1024 * 1024) {
            locallyDestroyed = true;
            const error = Object.assign(new Error('Box API response exceeds limit'), {
              code: 'BOX_RESPONSE_LIMIT',
            });
            reject(error);
            incoming.destroy(error);
            return;
          }
          chunks.push(chunk);
        });
        incoming.on('end', () => {
          try {
            resolve(new Response(size ? Buffer.concat(chunks) : null, { status }));
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    outgoing.on('socket', (socket) => {
      if (!socket.connecting && !socket.secureConnecting) secureConnected = true;
      else socket.once('secureConnect', () => (secureConnected = true));
    });
    boundConnection(outgoing);
    outgoing.on('error', (error) => {
      // HTTPS cannot have sent an application request before the TLS handshake.
      if (!secureConnected) error.retrySafeMutation = true;
      reject(error);
    });
    outgoing.end(body);
  });
}

// Native HTTPS respects the caller's total deadline without fetch's separate
// 300-second response-header deadline. No retries or redirects for mutations.
export async function multipartUpload(url, options, request = httpsRequest) {
  const encoded = new Request(url, { method: 'POST', body: options.body });
  const bytes = Buffer.from(await encoded.arrayBuffer());
  options.signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const started = performance.now();
    const outgoing = request(
      url,
      {
        method: 'POST',
        signal: options.signal,
        headers: {
          'Content-Type': encoded.headers.get('content-type'),
          'Content-Length': String(bytes.length),
        },
      },
      (incoming) => {
        incoming.on('error', reject);
        const status = incoming.statusCode;
        if (!Number.isInteger(status) || status < 200 || status > 599) {
          reject(new Error('Box upload response status invalid'));
          incoming.destroy();
          return;
        }
        if (status >= 300) {
          console.log(
            `Box 上传响应 HTTP ${status}（${Math.round(performance.now() - started)}ms）`,
          );
          resolve(
            new Response(null, {
              status,
              headers: incoming.headers['retry-after']
                ? { 'Retry-After': incoming.headers['retry-after'] }
                : {},
            }),
          );
          incoming.destroy();
          return;
        }
        const chunks = [];
        let size = 0;
        incoming.on('data', (chunk) => {
          size += chunk.length;
          if (size > 65536) {
            const error = Object.assign(new Error('Box upload response exceeds limit'), {
              code: 'BOX_RESPONSE_LIMIT',
            });
            reject(error);
            incoming.destroy(error);
            return;
          }
          chunks.push(chunk);
        });
        incoming.on('end', () => {
          try {
            const response = new Response(size ? Buffer.concat(chunks) : null, { status });
            console.log(
              `Box 上传响应 HTTP ${status}（${Math.round(performance.now() - started)}ms）`,
            );
            resolve(response);
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    boundConnection(outgoing);
    outgoing.on('error', (error) => {
      console.log(
        `Box 上传失败（${Math.round(performance.now() - started)}ms，socket 已写出 ${outgoing.socket?.bytesWritten ?? 0} bytes）`,
      );
      reject(error);
    });
    outgoing.on('finish', () => {
      console.log(
        `Box 上传请求体已写出 ${bytes.length} bytes（${Math.round(performance.now() - started)}ms）`,
      );
    });
    outgoing.end(bytes);
  });
}

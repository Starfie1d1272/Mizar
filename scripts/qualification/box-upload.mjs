import { request as httpsRequest } from 'node:https';
import { Buffer } from 'node:buffer';

const { Headers, Request, Response, performance } = globalThis;

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
    const outgoing = request(
      url,
      { method: options.method ?? 'GET', headers, signal: options.signal },
      (incoming) => {
        const chunks = [];
        let size = 0;
        incoming.on('data', (chunk) => {
          size += chunk.length;
          if (size > 2 * 1024 * 1024) {
            incoming.destroy(new Error('Box API response exceeds limit'));
            return;
          }
          chunks.push(chunk);
        });
        incoming.on('error', reject);
        incoming.on('aborted', () => reject(new Error('Box API response interrupted')));
        incoming.on('end', () => {
          try {
            const status = incoming.statusCode;
            if (!Number.isInteger(status) || status < 200 || status > 599)
              throw new Error('Box API response status invalid');
            resolve(new Response(size ? Buffer.concat(chunks) : null, { status }));
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    outgoing.on('error', reject);
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
        const chunks = [];
        let size = 0;
        incoming.on('data', (chunk) => {
          size += chunk.length;
          if (size > 65536) {
            incoming.destroy(new Error('Box upload response exceeds limit'));
            return;
          }
          chunks.push(chunk);
        });
        incoming.on('error', reject);
        incoming.on('end', () => {
          try {
            const status = incoming.statusCode;
            if (!Number.isInteger(status) || status < 200 || status > 599)
              throw new Error('Box upload response status invalid');
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
    outgoing.on('error', reject);
    outgoing.on('finish', () => {
      console.log(
        `Box 上传请求体已写出 ${bytes.length} bytes（${Math.round(performance.now() - started)}ms）`,
      );
    });
    outgoing.end(bytes);
  });
}

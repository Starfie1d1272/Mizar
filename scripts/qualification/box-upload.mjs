import { request as httpsRequest } from 'node:https';

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
          console.log(
            `Box 上传响应 HTTP ${incoming.statusCode}（${Math.round(performance.now() - started)}ms）`,
          );
          resolve(new Response(Buffer.concat(chunks), { status: incoming.statusCode }));
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

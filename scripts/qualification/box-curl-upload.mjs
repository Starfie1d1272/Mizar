import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Buffer } from 'node:buffer';

const { Request, Response } = globalThis;

// Explicit alternate transport for a manual recovery. No mutation retries,
// redirects, credentials in argv, or raw curl diagnostics in workflow logs.
export async function curlMultipartUpload(url, options) {
  options.signal.throwIfAborted();
  const encoded = new Request(url, { method: 'POST', body: options.body });
  const directory = await mkdtemp(join(tmpdir(), 'mizar-box-upload-'));
  const input = join(directory, 'body');
  const output = join(directory, 'response');
  try {
    await writeFile(input, Buffer.from(await encoded.arrayBuffer()), { mode: 0o600 });
    await writeFile(output, '', { mode: 0o600 });
    options.signal.throwIfAborted();
    const status = await new Promise((resolve, reject) => {
      // -q must be first to ignore machine-specific curlrc. URL is supplied only
      // through stdin; generated multipart boundary is non-secret.
      const child = spawn(
        'curl',
        [
          '-q',
          '--config',
          '-',
          '--silent',
          '--show-error',
          '--proto',
          '=https',
          '--connect-timeout',
          '30',
          '--max-time',
          '600',
          '--request',
          'POST',
          '--header',
          `Content-Type: ${encoded.headers.get('content-type')}`,
          '--data-binary',
          `@${input}`,
          '--output',
          output,
          '--write-out',
          '%{http_code}',
          '--max-filesize',
          '65536',
        ],
        { stdio: ['pipe', 'pipe', 'ignore'], signal: options.signal },
      );
      let result = '';
      child.stdout.on('data', (chunk) => {
        result += chunk.toString('utf8');
        if (result.length > 16) child.kill();
      });
      child.on('error', () =>
        reject(Object.assign(new Error('Box curl transport failed'), { code: 'BOX_CURL_FAILED' })),
      );
      child.stdin.on('error', () =>
        reject(Object.assign(new Error('Box curl input failed'), { code: 'BOX_CURL_FAILED' })),
      );
      child.on('close', (code) => {
        if (code !== 0 || !/^[1-5]\d{2}$/.test(result)) {
          console.log(`Box curl 上传失败，退出码 ${Number.isInteger(code) ? code : 'signal'}`);
          reject(
            Object.assign(new Error(`Box curl exit ${Number.isInteger(code) ? code : 'signal'}`), {
              code: 'BOX_CURL_FAILED',
            }),
          );
          return;
        }
        resolve(Number(result));
      });
      // JSON quoting matches curl config escaping for these validated HTTPS URLs.
      child.stdin.end(`url = ${JSON.stringify(String(url))}\n`);
    });
    if (status >= 300) return new Response(null, { status });
    if ((await stat(output)).size > 65536) throw new Error('Box curl response exceeds limit');
    const bytes = await readFile(output);
    console.log(`Box curl 上传响应 HTTP ${status}`);
    return new Response(bytes.length ? bytes : null, { status });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

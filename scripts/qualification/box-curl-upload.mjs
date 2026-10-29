import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Buffer } from 'node:buffer';

const { Request, Response } = globalThis;

// Single-attempt transport; the caller reconciles remote bytes before recovery. No
// redirects, credentials in argv, or raw curl diagnostics in workflow logs.
export async function curlMultipartUpload(url, options, run = spawn) {
  options.signal.throwIfAborted();
  const encoded = new Request(url, { method: 'POST', body: options.body });
  const directory = await mkdtemp(join(tmpdir(), 'mizar-box-upload-'));
  const input = join(directory, 'body');
  const output = join(directory, 'response');
  try {
    const bodyBytes = Buffer.from(await encoded.arrayBuffer());
    await writeFile(input, bodyBytes, { mode: 0o600 });
    await writeFile(output, '', { mode: 0o600 });
    options.signal.throwIfAborted();
    const status = await new Promise((resolve, reject) => {
      // -q must be first to ignore machine-specific curlrc. URL is supplied only
      // through stdin; generated multipart boundary is non-secret.
      const child = run(
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
          '15',
          '--speed-limit',
          '1024',
          '--speed-time',
          '60',
          '--max-time',
          '175',
          '--request',
          'POST',
          '--header',
          `Content-Type: ${encoded.headers.get('content-type')}`,
          ...(options.headers
            ? Object.entries(options.headers).flatMap(([key, value]) => [
                '--header',
                `${key}: ${value}`,
              ])
            : []),
          '--data-binary',
          `@${input}`,
          '--output',
          output,
          '--write-out',
          '%{http_code} %{time_namelookup} %{time_connect} %{time_appconnect} %{time_pretransfer} %{time_starttransfer} %{time_total} %{size_upload} %{speed_upload}',
          '--max-filesize',
          '65536',
        ],
        { stdio: ['pipe', 'pipe', 'ignore'], signal: options.signal },
      );
      let result = '';
      let failure;
      child.stdout.on('data', (chunk) => {
        result += chunk.toString('utf8');
        if (result.length > 1024) {
          failure = new Error('Box curl metrics exceed limit');
          child.kill();
        }
      });
      child.on('error', () => {
        failure = new Error('Box curl transport failed');
      });
      child.stdin.on('error', () => {
        failure = new Error('Box curl input failed');
        child.kill();
      });
      child.on('close', (code) => {
        const fields = result.trim().split(/\s+/);
        const numbers = fields.map(Number);
        const valid =
          !failure &&
          fields.length === 9 &&
          numbers.every((n) => Number.isFinite(n) && n >= 0) &&
          /^\d{3}$/.test(fields[0]);
        if (valid) {
          const [http, dns, tcp, tls, ready, firstByte, total, sent, speed] = numbers;
          console.log(
            `Box curl HTTP ${http}, exit ${code}; DNS=${dns}s TCP=${tcp}s TLS=${tls}s ready=${ready}s firstByte=${firstByte}s total=${total}s sent=${sent}B speed=${speed}B/s`,
          );
        }
        if (code !== 0 || !valid || numbers[0] < 200 || numbers[0] > 599) {
          const error = Object.assign(new Error('Box curl upload failed'), {
            code: 'BOX_CURL_FAILED',
            httpStatus: valid && numbers[0] >= 400 ? numbers[0] : undefined,
            uploadTimedOut: code === 28 || options.signal.aborted,
            // Only failures before any body bytes were sent can authorize replay.
            // Partial/complete uploads with a lost response are reconciled instead.
            retrySafeUpload:
              valid &&
              numbers[0] === 0 &&
              [6, 7, 18, 28, 35, 52, 55, 56].includes(code) &&
              numbers[7] === 0,
          });
          if (!valid) console.log('Box curl 阶段及发送字节不可用（未收到完整指标）');
          console.log(`Box curl 上传失败，退出码 ${Number.isInteger(code) ? code : 'signal'}`);
          reject(error);
          return;
        }
        resolve(numbers[0]);
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

import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { Buffer } from 'node:buffer';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { awaitDesktopStart, createCompanionLog, createSupervisorLog } from './product-logs.mjs';

const roots = [];
async function directory() {
  const root = await mkdtemp(join(tmpdir(), 'mizar-product-logs-'));
  roots.push(root);
  return root;
}
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe('startup evidence retention', () => {
  it('preserves the previous three startup failures after repeated retries', async () => {
    const root = await directory();
    for (let attempt = 0; attempt < 5; attempt++) {
      const output = createCompanionLog(root, 'companion.stderr.log', `session-${attempt}`);
      output.write(Buffer.from(`failure-${attempt}\n`));
      output.end();
    }
    const files = await readdir(join(root, 'logs'));
    expect(files).toHaveLength(4);
    for (let index = 0; index <= 3; index++) {
      const name = `companion.stderr.log${index ? `.${index}` : ''}`;
      const text = await readFile(join(root, 'logs', name), 'utf8');
      expect(text).toContain(`session-${4 - index}`);
      expect(text).toContain(`failure-${4 - index}`);
    }
  });

  it('bounds files and partial lines while draining output, and records truncation', async () => {
    const root = await directory();
    const output = createCompanionLog(root, 'companion.log', 'bounded', { maxBytes: 512 });
    for (let index = 0; index < 100; index++) output.write(Buffer.alloc(64 * 1024, 'x'));
    output.write(Buffer.from('\n'));
    for (let index = 0; index < 100; index++) output.write(Buffer.from('normal output\n'));
    output.end();
    const path = join(root, 'logs/companion.log');
    expect((await stat(path)).size).toBeLessThanOrEqual(512);
    const text = await readFile(path, 'utf8');
    expect(text).toContain('oversized log line omitted');
    expect(text).toContain('log size limit reached');
  });

  it('redacts credentials even when chunks split the secret and preserves UTF-8', async () => {
    const root = await directory();
    const output = createCompanionLog(root, 'companion.log', 'safe', {
      secrets: ['private-value'],
    });
    const bytes = Buffer.from('启动 private-value credential=another-secret\n');
    for (const byte of bytes) output.write(Buffer.from([byte]));
    output.end();
    const text = await readFile(join(root, 'logs/companion.log'), 'utf8');
    expect(text).toContain('启动 [redacted] credential=[redacted]');
    expect(text).not.toContain('private-value');
    expect(text).not.toContain('another-secret');
  });

  it('appends supervisor sessions without erasing earlier errors and bounds history', async () => {
    const root = await directory();
    const first = createSupervisorLog(root, 'first', { maxBytes: 512 });
    first('runtime_error', { error: 'WebView setup failed' });
    const second = createSupervisorLog(root, 'second', { maxBytes: 512 });
    second('process_start');
    let text = await readFile(join(root, 'logs/supervisor.ndjson'), 'utf8');
    expect(text).toContain('WebView setup failed');
    expect(text).toContain('second');
    for (let index = 0; index < 100; index++) second('runtime_error', { code: index });
    const files = await readdir(join(root, 'logs'));
    expect(files).toHaveLength(4);
    for (const file of files) {
      expect((await stat(join(root, 'logs', file))).size).toBeLessThanOrEqual(512);
      text = await readFile(join(root, 'logs', file), 'utf8');
      for (const line of text.trim().split('\n'))
        expect(JSON.parse(line).startupSessionId).toBe('second');
    }
  });

  it('keeps structured errors parseable when redacting escaped values', async () => {
    const root = await directory();
    const log = createSupervisorLog(root, 'escaped');
    log('runtime_error', { error: 'password=secret"quoted path=C:\\Windows token=private' });
    const text = await readFile(join(root, 'logs/supervisor.ndjson'), 'utf8');
    const entry = JSON.parse(text);
    expect(entry.error).toContain('path=C:\\Windows');
    expect(entry.error).not.toContain('secret');
    expect(entry.error).not.toContain('private');
  });
});

describe('Desktop supervisor ownership gate', () => {
  it('waits for the complete Desktop handoff before allowing startup', async () => {
    const input = new PassThrough();
    const start = awaitDesktopStart(input);
    input.write('MIZAR_DESKTOP_');
    input.end('START\r\n');
    await expect(start).resolves.toBeUndefined();
    expect(input.listenerCount('data')).toBe(0);
  });

  it('rejects missing, invalid, and unbounded handoffs', async () => {
    for (const message of ['', 'invalid\n', 'x'.repeat(100)]) {
      const input = new PassThrough();
      const start = awaitDesktopStart(input);
      input.end(message);
      await expect(start).rejects.toThrow('桌面启动控制');
    }
  });

  it('fails within a bounded deadline if the Desktop dies before handoff', async () => {
    const input = new PassThrough();
    await expect(awaitDesktopStart(input, { timeoutMs: 10 })).rejects.toThrow('超时');
    expect(input.listenerCount('data')).toBe(0);
    input.destroy();
  });
});

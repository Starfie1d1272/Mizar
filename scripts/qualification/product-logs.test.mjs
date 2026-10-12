import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { Buffer } from 'node:buffer';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { awaitDesktopStart, createCompanionLog } from './product-logs.mjs';

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
});

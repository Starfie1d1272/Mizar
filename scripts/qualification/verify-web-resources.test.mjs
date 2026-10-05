import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { verifyWebResources } from './verify-web-resources.mjs';

it('rejects missing production replays and leaked development assets', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mizar-web-resources-'));
  try {
    await expect(verifyWebResources(root)).rejects.toThrow();
    for (const name of ['ancient-round-03', 'ancient-round-11-defuse']) {
      const replay = join(root, 'fixtures', name, 'replay');
      await mkdir(replay, { recursive: true });
      await writeFile(join(replay, 'manifest.json'), '{}');
    }
    await expect(verifyWebResources(root)).resolves.toBeUndefined();
    await mkdir(join(root, 'fixtures/nuke-demo-round-01'));
    await expect(verifyWebResources(root)).rejects.toThrow('development-only');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

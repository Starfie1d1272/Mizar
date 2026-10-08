import { cp, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { verifyWebResources } from './verify-web-resources.mjs';

it('rejects missing production replays and leaked development assets', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mizar-web-resources-'));
  try {
    await expect(verifyWebResources(root)).rejects.toThrow();
    await cp(
      new URL('../../apps/web/public/fixture-media', import.meta.url),
      join(root, 'fixture-media'),
      { recursive: true },
    );
    for (const name of ['epl-inferno-opening', 'epl-inferno-final-round']) {
      const replay = join(root, 'fixtures', name, 'replay');
      await mkdir(replay, { recursive: true });
      await writeFile(join(replay, 'manifest.json'), '{}');
    }
    await cp(
      new URL('../../apps/web/public/fixtures/epl-inferno-video', import.meta.url),
      join(root, 'fixtures/epl-inferno-video'),
      { recursive: true },
    );
    await expect(verifyWebResources(root)).resolves.toBeUndefined();
    await mkdir(join(root, 'fixtures/nuke-demo-round-01'));
    await expect(verifyWebResources(root)).rejects.toThrow('development-only');
    await rm(join(root, 'fixtures/nuke-demo-round-01'), { recursive: true });
    await writeFile(join(root, 'fixtures/epl-inferno-video/replay/background.mp4'), 'corrupt');
    await expect(verifyWebResources(root)).rejects.toThrow(
      'artifact hash mismatch: background.mp4',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

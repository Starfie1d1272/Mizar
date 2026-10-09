import { URL } from 'node:url';
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

it('keeps required Core assets intact and refuses optional resources or mismatched build modes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mizar-core-resources-'));
  try {
    await cp(new URL('../../apps/web/public/brand', import.meta.url), join(root, 'brand'), {
      recursive: true,
    });
    await cp(new URL('../../packages/cs2-assets/generated/public', import.meta.url), root, {
      recursive: true,
    });
    await writeFile(
      join(root, 'web-resource-mode.json'),
      JSON.stringify({ schemaVersion: 1, resourceMode: 'core-only' }),
    );
    await writeFile(join(root, 'index.html'), '<html></html>');
    await writeFile(join(root, 'product-shell.css'), '');
    await expect(verifyWebResources(root, 'core-only')).resolves.toBeUndefined();
    await expect(verifyWebResources(root, 'full')).rejects.toThrow('mode');
    await expect(verifyWebResources(root, 'unknown')).rejects.toThrow('Unknown');
    await mkdir(join(root, 'fixtures'));
    await expect(verifyWebResources(root, 'core-only')).rejects.toThrow('optional');
    await rm(join(root, 'fixtures'), { recursive: true });
    await writeFile(join(root, 'brand/mizar-mark.svg'), 'corrupt');
    await expect(verifyWebResources(root, 'core-only')).rejects.toThrow('Required Core');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

import { URL } from 'node:url';
import { readFile, readdir } from 'node:fs/promises';
import { expect, it } from 'vitest';

it('enables the required close_review ACL exclusively for its dedicated window', async () => {
  const root = new URL('../../apps/desktop/src-tauri/', import.meta.url);
  const config = JSON.parse(await readFile(new URL('tauri.conf.json', root), 'utf8'));
  const enabled = config.app.security.capabilities;
  const capabilities = await Promise.all(
    (await readdir(new URL('capabilities/', root)))
      .filter((name) => name.endsWith('.json'))
      .map(async (name) =>
        JSON.parse(await readFile(new URL(`capabilities/${name}`, root), 'utf8')),
      ),
  );
  const review = capabilities.find((capability) => capability.identifier === 'review');
  expect(review).toMatchObject({
    windows: ['tool-review'],
    remote: { urls: ['http://127.0.0.1:3000/*'] },
    permissions: ['allow-close-review'],
  });
  expect(enabled).toContain('review');
  expect(
    capabilities
      .filter((capability) => capability.permissions.includes('allow-close-review'))
      .map((capability) => capability.identifier),
  ).toEqual(['review']);
});

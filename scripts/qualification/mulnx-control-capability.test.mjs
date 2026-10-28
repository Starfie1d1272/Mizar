import { readFile, readdir } from 'node:fs/promises';
import { URL } from 'node:url';
import { expect, it } from 'vitest';

it('enables MulNX control only for the preparation window', async () => {
  const root = new URL('../../apps/desktop/src-tauri/', import.meta.url);
  const config = JSON.parse(await readFile(new URL('tauri.conf.json', root), 'utf8'));
  const build = await readFile(new URL('build.rs', root), 'utf8');
  const capabilities = await Promise.all(
    (await readdir(new URL('capabilities/', root)))
      .filter((name) => name.endsWith('.json'))
      .map(async (name) =>
        JSON.parse(await readFile(new URL(`capabilities/${name}`, root), 'utf8')),
      ),
  );
  expect(build).toContain('"mulnx_control"');
  expect(config.app.security.capabilities).toContain('mulnx-control');
  expect(
    capabilities.filter((item) => item.permissions.includes('allow-mulnx-control')),
  ).toMatchObject([
    {
      identifier: 'mulnx-control',
      windows: ['main'],
      remote: { urls: ['http://127.0.0.1:3000/*'] },
      permissions: ['allow-mulnx-control'],
    },
  ]);
});

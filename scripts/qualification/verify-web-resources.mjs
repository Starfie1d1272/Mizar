import { access } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export async function verifyWebResources(root) {
  for (const name of ['ancient-round-03', 'ancient-round-11-defuse']) {
    await access(resolve(root, 'fixtures', name, 'replay', 'manifest.json'));
  }
  let forbidden = false;
  try {
    await access(resolve(root, 'fixtures/nuke-demo-round-01'));
    forbidden = true;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (forbidden) throw new Error('Production Web contains the development-only Nuke replay');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await verifyWebResources(resolve(process.argv[2] ?? 'apps/web/dist'));
  console.log('Production Web: Ancient editor replays retained; development-only Nuke excluded.');
}

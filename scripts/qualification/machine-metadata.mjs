import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeMachineMetadata } from '../../packages/resource-pack-contract/transport.mjs';
import { RESOURCE_ASSET_NAMES } from '../../packages/resource-pack-contract/catalog.mjs';
export async function machineMetadata(product, resources, index) {
  const files = new Map();
  for (const name of [
    'release-manifest.json',
    'distribution-manifest.json',
    'core-release-manifest.json',
    'core-distribution-manifest.json',
    'NSIS-LICENSE.txt',
    'qualification-provenance.json',
  ])
    files.set(name, await readFile(join(product, name)));
  for (const name of Object.values(RESOURCE_ASSET_NAMES))
    files.set(name, await readFile(join(resources, name)));
  if (index) files.set('update-index.json', await readFile(index));
  return makeMachineMetadata(files);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [product, resources, index, output] = process.argv.slice(2);
  await writeFile(
    output,
    await machineMetadata(product, resources, index === '-' ? undefined : index),
    { flag: 'wx' },
  );
}

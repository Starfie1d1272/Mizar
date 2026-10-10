import { URL } from 'node:url';
import { cp, mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
const output = resolve(process.argv[2]);
const bridge = join(output, 'resources/app/dist/web-installer');
await mkdir(bridge, { recursive: true });
for (const name of [
  'install-official-pack.mjs',
  'complete-bootstrap.mjs',
  'published-bootstrap.mjs',
  'resource-mirror.mjs',
  'installed-entry.mjs',
  'cancel-control.mjs',
])
  await cp(new URL(name, import.meta.url), join(bridge, name));
await mkdir(join(output, 'resources/scripts'), { recursive: true });
for (const name of ['product-runtime.mjs', 'product-logs.mjs'])
  await cp(
    new URL(`../qualification/${name}`, import.meta.url),
    join(output, 'resources/scripts', name),
  );

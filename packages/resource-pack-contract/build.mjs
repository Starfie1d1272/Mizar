import { readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
const root = import.meta.dirname,
  dist = join(root, 'dist');
await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });
for (const file of [
  'index.mjs',
  'index.d.mts',
  'content.mjs',
  'content.d.mts',
  'archive.mjs',
  'publication.mjs',
  'attestation.mjs',
  'attestation.d.mts',
  'runtime.mjs',
  'runtime.d.mts',
]) {
  const destination = file.replace(/\.mjs$/, '.js').replace(/\.d\.mts$/, '.d.ts');
  const text = (await readFile(join(root, file), 'utf8')).replace(
    /(from\s+['"]\.[^'"]*)\.mjs(['"])/g,
    '$1.js$2',
  );
  await writeFile(join(dist, destination), text);
}

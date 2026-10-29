import { cp, mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, URL } from 'node:url';

async function copyCss(source, destination) {
  await mkdir(destination, { recursive: true });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const from = join(source, entry.name);
    const to = join(destination, entry.name);
    if (entry.isDirectory()) await copyCss(from, to);
    else if (entry.name.endsWith('.css')) await cp(from, to);
  }
}
await copyCss(
  fileURLToPath(new URL('../src', import.meta.url)),
  fileURLToPath(new URL('../dist', import.meta.url)),
);

import { cp, mkdir, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

// The portable host runs node.exe directly and never installs dependencies.
export async function copyNodeRuntime(source, destination) {
  await mkdir(destination, { recursive: true });
  for (const name of ['node.exe', 'LICENSE']) {
    await cp(join(source, name), join(destination, name));
  }
}

export function isDevelopmentFile(name) {
  return /(?:\.d\.(?:ts|mts|cts)(?:\.map)?|\.(?:js|mjs|cjs|jsx|ts|mts|cts|tsx|css)\.map|\.tsbuildinfo)$/.test(
    name,
  );
}

export async function pruneDevelopmentFiles(appDir) {
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(path);
      } else if (entry.isFile() && isDevelopmentFile(entry.name)) {
        await rm(path);
      }
    }
  }
  await visit(appDir);
}

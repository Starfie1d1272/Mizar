import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { copyNodeRuntime, pruneDevelopmentFiles } from './portable-files.mjs';

const roots = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'mizar portable files '));
  roots.push(root);
  return root;
}

describe('portable runtime files', () => {
  it('ships the Node executable and license without npm, Corepack or development commands', async () => {
    const root = await fixture();
    const source = join(root, 'source');
    const destination = join(root, 'runtime');
    await mkdir(join(source, 'node_modules/npm'), { recursive: true });
    for (const name of ['node.exe', 'LICENSE', 'npm.cmd', 'corepack.cmd']) {
      await writeFile(join(source, name), name);
    }
    await copyNodeRuntime(source, destination);
    expect((await readdir(destination)).sort()).toEqual(['LICENSE', 'node.exe']);
    expect(await readFile(join(destination, 'LICENSE'), 'utf8')).toBe('LICENSE');
  });
  it('removes declarations and source maps while retaining executable code, data and licenses', async () => {
    const root = await fixture();
    const directories = [
      'dist',
      'node_modules/@mizar/core/dist',
      'node_modules/cs2-c4-damage/dist',
    ];
    for (const directory of directories) {
      const path = join(root, directory);
      await mkdir(path, { recursive: true });
      for (const name of [
        'app.js',
        'app.d.ts',
        'app.d.ts.map',
        'app.d.mts',
        'app.d.cts',
        'app.d.mts.map',
        'app.d.cts.map',
        'app.mjs.map',
        'app.cjs.map',
        'app.css.map',
        'app.js.map',
        'app.tsbuildinfo',
        'data.json',
        'map.bin',
        'world.map',
        'LICENSE',
      ]) {
        await writeFile(join(path, name), name);
      }
    }
    await pruneDevelopmentFiles(root);
    for (const directory of directories) {
      expect((await readdir(join(root, directory))).sort()).toEqual([
        'LICENSE',
        'app.js',
        'data.json',
        'map.bin',
        'world.map',
      ]);
      expect(await readFile(join(root, directory, 'app.js'), 'utf8')).toBe('app.js');
    }
  });
});

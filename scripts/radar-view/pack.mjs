import { execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
/** Pack the built library, never workspace-only build dependencies or lifecycle scripts. */
export async function packRadar(output) {
  const stage = await mkdtemp(join(tmpdir(), 'mizar-radar-pack-'));
  try {
    const source = join(root, 'packages/radar-view');
    const manifest = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'));
    delete manifest.devDependencies;
    delete manifest.scripts;
    await cp(join(source, 'dist'), join(stage, 'dist'), { recursive: true });
    await cp(join(source, 'README.md'), join(stage, 'README.md'));
    await cp(join(root, 'LICENSE'), join(stage, 'LICENSE'));
    await writeFile(join(stage, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');
    await mkdir(output, { recursive: true });
    const result = JSON.parse(
      execFileSync(
        process.platform === 'win32' ? 'npm.cmd' : 'npm',
        ['pack', '--json', '--ignore-scripts', '--pack-destination', resolve(output)],
        { cwd: stage, encoding: 'utf8' },
      ),
    );
    return join(resolve(output), result[0].filename);
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(await packRadar(resolve(process.argv[2] ?? '.agent-tmp/radar-package')));
}

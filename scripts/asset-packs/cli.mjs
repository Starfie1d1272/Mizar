import { performance } from 'node:perf_hooks';
import { readFile, writeFile, mkdir, lstat } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { buildOfficialPack, verifyPackBytes, jsonBytes } from './pack.mjs';
import { LIMITS, requireValue } from '../../packages/resource-pack-contract/index.mjs';

const [mode, path, version] = process.argv.slice(2);
if (mode === 'build' && path && version) {
  const root = resolve(import.meta.dirname, '../..');
  const sourceSha = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: root,
    encoding: 'utf8',
  }).trim();
  const start = performance.now();
  const result = await buildOfficialPack(root, { packVersion: version, sourceSha });
  await mkdir(path, { recursive: true });
  const name = `Mizar-official-epl-default-${version}.zip`;
  await writeFile(join(path, name), result.archiveBytes);
  await writeFile(join(path, 'pack-manifest.json'), jsonBytes(result.manifest));
  const report = {
    packId: result.manifest.packId,
    packVersion: version,
    sourceSha,
    archive: { name, ...result.archive },
    manifestSha256: result.manifestSha256,
    files: result.manifest.files.length,
    rawBytes: result.manifest.totalBytes,
    wallTimeMs: Math.round(performance.now() - start),
    trusted: false,
  };
  await writeFile(join(path, 'build-report.json'), jsonBytes(report));
  console.log(JSON.stringify(report));
} else if (mode === 'verify' && path) {
  requireValue(
    (await lstat(path)).isFile() && (await lstat(path)).size <= LIMITS.archiveBytes,
    '归档文件大小或类型无效',
  );
  const result = verifyPackBytes(await readFile(path), { coreVersion: version });
  console.log(
    JSON.stringify({
      packId: result.manifest.packId,
      packVersion: result.manifest.packVersion,
      archive: result.archive,
      manifestSha256: result.manifestSha256,
      trusted: false,
    }),
  );
} else throw new Error('用法：cli.mjs build <输出目录> <packVersion> | verify <归档> [Core版本]');

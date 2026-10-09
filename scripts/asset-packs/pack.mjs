import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import { resolve, sep, relative } from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  PACK_ID,
  LIMITS,
  REPLAY_IDS,
  parsePackManifest,
  assertResourcePath,
  requireValue,
} from '../../packages/resource-pack-contract/index.mjs';
import { encodeArchive } from '../../packages/resource-pack-contract/archive.mjs';
export {
  sha256,
  jsonBytes,
  verifyPackBytes,
} from '../../packages/resource-pack-contract/content.mjs';
import {
  sha256,
  jsonBytes,
  verifyPackBytes,
} from '../../packages/resource-pack-contract/content.mjs';

export async function buildOfficialPack(
  root,
  { packVersion, sourceSha, minimumCoreVersion = '1.1.0', maximumCoreVersionExclusive = '2.0.0' },
) {
  root = await realpath(root);
  const entries = new Map();
  let totalBytes = 0;
  async function add(source, destination) {
    assertResourcePath(destination);
    const path = resolve(root, source),
      actual = await realpath(path);
    requireValue(actual === path && actual.startsWith(`${root}${sep}`), '源路径逃逸或含符号链接');
    const stat = await lstat(path);
    requireValue(stat.isFile() && stat.size <= LIMITS.fileBytes, '源文件类型或大小无效');
    requireValue(!entries.has(destination) && entries.size < LIMITS.files, '源文件重复或数量超限');
    totalBytes += stat.size;
    requireValue(totalBytes <= LIMITS.totalBytes, '源资源总字节超限');
    const bytes = await readFile(path);
    requireValue(bytes.length === stat.size, '源文件在构建中变化');
    entries.set(destination, bytes);
  }
  async function walk(source) {
    const path = resolve(root, source);
    requireValue(
      (await realpath(path)) === path && (await lstat(path)).isDirectory(),
      '源目录含符号链接',
    );
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const child = `${source}/${entry.name}`;
      if (entry.isDirectory()) await walk(child);
      else {
        requireValue(entry.isFile(), '不允许源符号链接或特殊文件');
        await add(
          child,
          relative(resolve(root, 'apps/web/public'), resolve(root, child)).split(sep).join('/'),
        );
      }
    }
  }
  for (const name of REPLAY_IDS) await walk(`apps/web/public/fixtures/${name}`);
  await walk('apps/web/public/fixture-media/epl-s24');
  await add('fixtures/epl-s24/media.json', 'provenance/epl-media.json');
  await add('fixtures/epl-s24/source.json', 'provenance/epl-source.json');
  await add('THIRD-PARTY-NOTICES.md', 'provenance/third-party-notices.txt');
  await add('LICENSE', 'provenance/mizar-license.txt');
  // 来源 SHA 必须来自实际 checkout；不允许为旧输入贴上任意新源码身份。
  const actualSha = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: root,
    encoding: 'utf8',
  }).trim();
  requireValue(sourceSha === actualSha, '构建来源 SHA 不等于 checkout');
  const dirty = execFileSync(
    'git',
    [
      'status',
      '--porcelain',
      '--',
      'apps/web/public/fixtures',
      'apps/web/public/fixture-media/epl-s24',
      'fixtures/epl-s24',
      'THIRD-PARTY-NOTICES.md',
      'LICENSE',
    ],
    { cwd: root, encoding: 'utf8' },
  );
  requireValue(dirty === '', '构建素材包含未提交变更');
  const files = [...entries]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([path, bytes]) => ({ path, bytes: bytes.length, sha256: sha256(bytes) }));
  const manifest = parsePackManifest({
    schemaVersion: 1,
    packId: PACK_ID,
    packVersion,
    compatibility: { resourceSchemaVersion: 1, minimumCoreVersion, maximumCoreVersionExclusive },
    contentKind: 'recorded-replay',
    source: { repository: 'Starfie1d1272/Mizar', gitSha: sourceSha },
    totalBytes: files.reduce((sum, f) => sum + f.bytes, 0),
    files,
  });
  entries.set('pack-manifest.json', jsonBytes(manifest));
  const archive = encodeArchive(entries);
  return { archiveBytes: archive, ...verifyPackBytes(archive) };
}

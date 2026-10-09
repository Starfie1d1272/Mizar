import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
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
import { encodeArchive, decodeArchive } from './archive.mjs';
export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
export const jsonBytes = (value) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);

export function verifyPackBytes(archive, { coreVersion, expectedArchive } = {}) {
  requireValue(archive.length <= LIMITS.archiveBytes, '归档大小超限');
  const identity = { bytes: archive.length, sha256: sha256(archive), format: 'zip' };
  if (expectedArchive)
    requireValue(
      expectedArchive.format === 'zip' &&
        expectedArchive.bytes === identity.bytes &&
        expectedArchive.sha256 === identity.sha256,
      '归档不等于外部声明绑定的字节',
    );
  const entries = decodeArchive(archive),
    manifestBytes = entries.get('pack-manifest.json');
  requireValue(manifestBytes && manifestBytes.length <= LIMITS.manifestBytes, '资源清单缺失或超限');
  const manifest = parsePackManifest(JSON.parse(manifestBytes.toString('utf8')), { coreVersion });
  requireValue(entries.size === manifest.files.length + 1, '归档包含未声明文件');
  for (const file of manifest.files) {
    const bytes = entries.get(file.path);
    requireValue(
      bytes && bytes.length === file.bytes && sha256(bytes) === file.sha256,
      `资源字节与清单不符：${file.path}`,
    );
  }
  // 独立核对现有回放生产契约，视频与时间轴不能半新半旧。
  for (const name of REPLAY_IDS) {
    const prefix = `fixtures/${name}/replay/`;
    const replay = JSON.parse(entries.get(`${prefix}manifest.json`).toString('utf8'));
    requireValue(
      replay.schemaVersion === 1 &&
        replay.eventIndexSchemaVersion === 1 &&
        replay.harnessVersion === 1,
      '回放协议不兼容',
    );
    const artifacts = {
      'frames.jsonl': replay.framesSha256,
      'events.jsonl': replay.eventIndexSha256,
      'match-context.json': replay.matchContextSha256,
      'capture-manifest.json': replay.captureManifestSha256,
    };
    if (name === 'epl-inferno-video') {
      requireValue(replay.video?.file === 'background.mp4', '默认视频绑定无效');
      artifacts['background.mp4'] = replay.video.sha256;
    }
    for (const [file, digest] of Object.entries(artifacts))
      requireValue(
        sha256(entries.get(`${prefix}${file}`)) === digest,
        `回放原子绑定不符：${name}/${file}`,
      );
  }
  const provenance = JSON.parse(
    entries.get('fixtures/epl-inferno-video/provenance.json').toString('utf8'),
  );
  requireValue(
    Array.isArray(provenance.avatars) && provenance.avatars.length === 10,
    '头像来源不完整',
  );
  for (const avatar of provenance.avatars) {
    requireValue(/^[a-f0-9]{64}\.jpg$/.test(avatar), '头像名称无效');
    const bytes = entries.get(`fixtures/epl-inferno-video/media/${avatar}`);
    requireValue(bytes && sha256(bytes) === avatar.slice(0, -4), '头像来源摘要不符');
  }
  const media = JSON.parse(entries.get('provenance/epl-media.json')?.toString('utf8') ?? 'null');
  requireValue(Array.isArray(media?.assets) && media.assets.length === 12, '队标与头像来源不完整');
  for (const asset of media.assets) {
    requireValue(
      typeof asset.path === 'string' &&
        asset.path.startsWith('apps/web/public/fixture-media/epl-s24/'),
      '展示素材来源路径无效',
    );
    const path = asset.path.slice('apps/web/public/'.length);
    assertResourcePath(path);
    const bytes = entries.get(path);
    requireValue(bytes && sha256(bytes) === asset.sha256, '展示素材来源摘要不符');
  }
  return { manifest, manifestSha256: sha256(manifestBytes), archive: identity, entries };
}

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

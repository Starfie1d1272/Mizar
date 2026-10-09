import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import {
  LIMITS,
  REPLAY_IDS,
  parsePackManifest,
  assertResourcePath,
  requireValue,
} from './index.mjs';
import { decodeArchive } from './archive.mjs';
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

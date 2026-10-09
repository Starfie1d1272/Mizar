/** 唯一的官方数据资源契约；完整性校验不代表发行授权。 */
export const PACK_ID = 'official:epl-default';
export const LIMITS = Object.freeze({
  files: 256,
  fileBytes: 128 * 1024 * 1024,
  totalBytes: 256 * 1024 * 1024,
  archiveBytes: 256 * 1024 * 1024,
  manifestBytes: 256 * 1024,
});
export const REPLAY_IDS = Object.freeze([
  'epl-inferno-video',
  'epl-inferno-opening',
  'epl-inferno-final-round',
]);
export function requireValue(ok, message) {
  if (!ok) throw new Error(message);
}
export const isSha256 = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
export const isSourceSha = (value) => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
export const isVersion = (value) =>
  typeof value === 'string' &&
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value) &&
  value.split('.').every((part) => Number.isSafeInteger(Number(part)));
export function compareVersions(a, b) {
  requireValue(isVersion(a) && isVersion(b), '版本必须是正式三段版本');
  const x = a.split('.').map(Number),
    y = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  return 0;
}
export function assertResourcePath(path) {
  requireValue(
    typeof path === 'string' && path.length <= 240 && /^[a-zA-Z0-9][a-zA-Z0-9_./-]*$/.test(path),
    '非法资源路径',
  );
  for (const segment of path.split('/')) {
    requireValue(
      segment !== '' &&
        segment !== '.' &&
        segment !== '..' &&
        !segment.endsWith('.') &&
        !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(segment),
      '非法或 Windows 保留路径',
    );
  }
  requireValue(
    /\.(json|jsonl|mp4|jpg|png|webp|txt|svg)$/i.test(path),
    '不允许可执行或主动内容资源',
  );
  return path;
}
export function assertCompatibility(compatibility, coreVersion) {
  requireValue(
    compatibility &&
      compatibility.resourceSchemaVersion === 1 &&
      isVersion(compatibility.minimumCoreVersion) &&
      isVersion(compatibility.maximumCoreVersionExclusive) &&
      compareVersions(compatibility.minimumCoreVersion, compatibility.maximumCoreVersionExclusive) <
        0,
    '资源兼容范围无效',
  );
  if (coreVersion !== undefined)
    requireValue(
      compareVersions(coreVersion, compatibility.minimumCoreVersion) >= 0 &&
        compareVersions(coreVersion, compatibility.maximumCoreVersionExclusive) < 0,
      '资源包与 Core 不兼容',
    );
}
export function parsePackManifest(value, { coreVersion } = {}) {
  requireValue(
    value && value.schemaVersion === 1 && value.packId === PACK_ID && isVersion(value.packVersion),
    '资源包身份或版本无效',
  );
  assertCompatibility(value.compatibility, coreVersion);
  requireValue(
    value.contentKind === 'recorded-replay' &&
      value.source &&
      value.source.repository === 'Starfie1d1272/Mizar' &&
      isSourceSha(value.source.gitSha),
    '资源来源描述无效',
  );
  requireValue(
    Array.isArray(value.files) && value.files.length > 0 && value.files.length <= LIMITS.files,
    '资源文件数量超限',
  );
  const names = new Set();
  let total = 0;
  for (const file of value.files) {
    assertResourcePath(file.path);
    requireValue(
      file.path !== 'pack-manifest.json' &&
        !names.has(file.path.toLowerCase()) &&
        Number.isSafeInteger(file.bytes) &&
        file.bytes >= 0 &&
        file.bytes <= LIMITS.fileBytes &&
        isSha256(file.sha256),
      '资源文件重复、大小或摘要无效',
    );
    if (/\.svg$/i.test(file.path))
      requireValue(
        file.path === 'fixture-media/epl-s24/epl-navi.svg' &&
          file.sha256 === 'ad2cca38fe4bdc2229c0bfe6f001fce2522736d923f4e1307cd809bfbaa3fd61',
        '不允许未经固定身份核对的 SVG',
      );
    names.add(file.path.toLowerCase());
    total += file.bytes;
  }
  requireValue(
    total <= LIMITS.totalBytes && value.totalBytes === total,
    '资源总字节数不一致或超限',
  );
  for (const path of names) {
    const segments = path.split('/');
    for (let i = 1; i < segments.length; i++)
      requireValue(!names.has(segments.slice(0, i).join('/')), '资源文件与目录冲突');
  }
  for (const name of REPLAY_IDS)
    for (const file of [
      'manifest.json',
      'frames.jsonl',
      'events.jsonl',
      'capture-manifest.json',
      'match-context.json',
    ])
      requireValue(names.has(`fixtures/${name}/replay/${file}`), '原子回放资源缺失');
  requireValue(
    names.has('fixtures/epl-inferno-video/replay/background.mp4') &&
      names.has('fixtures/epl-inferno-video/provenance.json') &&
      names.has('provenance/third-party-notices.txt'),
    '视频或来源说明缺失',
  );
  return value;
}

import { beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { URL } from 'node:url';
import { Buffer } from 'node:buffer';
import { buildOfficialPack, verifyPackBytes, jsonBytes, sha256 } from './pack.mjs';
import { encodeArchive } from './archive.mjs';
import {
  parsePackManifest,
  assertResourcePath,
  LIMITS,
} from '../../packages/resource-pack-contract/index.mjs';

const root = new URL('../../', import.meta.url).pathname;
let pack;
beforeAll(async () => {
  pack = await buildOfficialPack(root, {
    packVersion: '1.0.0',
    sourceSha: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  });
}, 30_000);
function mutate(edit) {
  const entries = new Map(pack.entries),
    manifest = JSON.parse(JSON.stringify(pack.manifest));
  edit(entries, manifest);
  entries.set('pack-manifest.json', jsonBytes(manifest));
  return encodeArchive(entries);
}
describe('官方 EPL 原子资源', () => {
  it('保留现有完整默认素材且相同输入得到相同 ZIP 字节', () => {
    expect(pack.manifest.files).toHaveLength(43);
    expect(pack.manifest.totalBytes).toBe(85680266);
    expect(pack.entries.get('fixtures/epl-inferno-video/replay/background.mp4').length).toBe(
      33440429,
    );
    expect(encodeArchive(pack.entries).equals(pack.archiveBytes)).toBe(true);
    expect(verifyPackBytes(pack.archiveBytes, { coreVersion: '1.1.0' }).manifest.packId).toBe(
      'official:epl-default',
    );
  }, 30_000);
  it('拒绝内容损坏、截断、遗漏、未声明内容和错误外部身份', () => {
    expect(() => verifyPackBytes(pack.archiveBytes.subarray(0, -1))).toThrow();
    const damaged = Buffer.from(pack.archiveBytes);
    damaged[50] ^= 1;
    expect(() => verifyPackBytes(damaged)).toThrow();
    expect(() =>
      verifyPackBytes(
        mutate((entries) => entries.delete('fixtures/epl-inferno-video/replay/background.mp4')),
      ),
    ).toThrow();
    expect(() =>
      verifyPackBytes(mutate((entries) => entries.set('extra.json', Buffer.from('{}')))),
    ).toThrow();
    expect(() =>
      verifyPackBytes(pack.archiveBytes, {
        expectedArchive: { ...pack.archive, sha256: '0'.repeat(64) },
      }),
    ).toThrow();
  }, 30_000);
  it('即使攻击者重算同包 hash，仍拒绝视频与同步数据错配', () => {
    const archive = mutate((entries, manifest) => {
      const path = 'fixtures/epl-inferno-video/replay/events.jsonl',
        bytes = Buffer.from('{}\n');
      entries.set(path, bytes);
      const file = manifest.files.find((f) => f.path === path);
      manifest.totalBytes += bytes.length - file.bytes;
      file.bytes = bytes.length;
      file.sha256 = sha256(bytes);
    });
    expect(() => verifyPackBytes(archive)).toThrow(/原子绑定/);
  }, 15_000);
  it('拒绝重复名称、符号链接、目录逃逸及未固定 SVG', () => {
    const duplicate = new Map(pack.entries);
    duplicate.set('PACK-MANIFEST.json', pack.entries.get('pack-manifest.json'));
    expect(() => verifyPackBytes(encodeArchive(duplicate))).toThrow(/重复/);
    const symlink = Buffer.from(pack.archiveBytes),
      central = symlink.readUInt32LE(symlink.length - 6);
    symlink.writeUInt16LE(0x314, central + 4);
    symlink.writeUInt32LE(0xa1ff0000, central + 38);
    expect(() => verifyPackBytes(symlink)).toThrow(/符号链接/);
    const manifest = JSON.parse(JSON.stringify(pack.manifest));
    manifest.files.push({ path: 'evil.svg', bytes: 0, sha256: sha256('') });
    expect(() => parsePackManifest(manifest)).toThrow(/SVG/);
    manifest.files.at(-1).path = 'evil.SVG';
    expect(() => parsePackManifest(manifest)).toThrow(/SVG/);
    manifest.files.pop();
    manifest.files.push({
      path: 'fixtures/epl-inferno-video/replay/manifest.json/data.json',
      bytes: 0,
      sha256: sha256(''),
    });
    expect(() => parsePackManifest(manifest)).toThrow(/目录冲突/);
  }, 15_000);
});
describe('资源契约安全边界', () => {
  it.each([
    '/absolute.json',
    '../escape.json',
    'a/../escape.json',
    'C:/escape.json',
    'a\\escape.json',
    'a//b.json',
    'a./b.json',
    'CON.json',
    'a/aux.txt',
    'payload.exe',
    'payload.js',
    'payload.html',
    'a%2fb.json',
  ])('拒绝 %s', (path) => expect(() => assertResourcePath(path)).toThrow());
  it('拒绝错版本、错来源、兼容区间外和超限声明', () => {
    for (const patch of [
      { schemaVersion: 2 },
      { packId: 'untrusted:epl' },
      { packVersion: 'latest' },
      { source: { repository: 'evil/Mizar', gitSha: 'a'.repeat(40) } },
      { totalBytes: LIMITS.totalBytes + 1 },
    ])
      expect(() => parsePackManifest({ ...pack.manifest, ...patch })).toThrow();
    expect(() => parsePackManifest(pack.manifest, { coreVersion: '2.0.0' })).toThrow(/不兼容/);
    expect(() => parsePackManifest(pack.manifest, { coreVersion: '1.0.9' })).toThrow(/不兼容/);
  });
});

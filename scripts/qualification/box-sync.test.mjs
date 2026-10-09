import { describe, it, expect } from 'vitest';
import { Buffer } from 'node:buffer';
import {
  digest,
  syncStable,
  validateRelease,
  BoxClient,
  probe,
  promotionTag,
} from './box-sync.mjs';

describe('成功发布任务的版本标签', () => {
  const run = { id: 42, display_title: 'Release Promotion' };
  const job = { run_id: 42, status: 'completed', conclusion: 'success', name: '发布 Mizar v1.0.0' };
  it('固定流程标题仍能从成功任务读取正式版本', () => {
    expect(promotionTag(run, [job])).toBe('v1.0.0');
  });
  it('候选标签可识别，交给已有候选跳过规则处理', () => {
    expect(promotionTag(run, [{ ...job, name: '发布 Mizar v1.0.1-rc.2' }])).toBe('v1.0.1-rc.2');
  });
  it.each([
    [],
    [{ ...job, run_id: 43 }],
    [{ ...job, conclusion: 'failure' }],
    [{ ...job, status: 'in_progress' }],
    [{ ...job, name: '发布 Mizar v1.0.0 extra' }],
    [job, { ...job, name: '发布 Mizar v1.0.1' }],
  ])('缺失、未成功、来源不符或多个标签时停止同步', (...jobs) => {
    expect(() => promotionTag(run, jobs)).toThrow('唯一晋级标签');
  });
});

const make = (version, bytes = Buffer.from(version)) => ({
  version,
  name: `Mizar-v${version}-Windows-x64-Setup.exe`,
  size: bytes.length,
  sha256: digest(bytes),
  bytes,
});
function fakeBox(files = {}) {
  const stored = new Map(Object.entries(files));
  return {
    stored,
    operations: [],
    async initialize() {},
    async list(folder) {
      const prefix = `${folder === '/' ? '' : folder}/`;
      return [...stored.keys()]
        .filter((p) => p.startsWith(prefix) && !p.slice(prefix.length).includes('/'))
        .map((p) => ({ name: p.slice(prefix.length), type: 'file' }));
    },
    async hash(path) {
      const b = stored.get(path);
      if (!b) throw Error('missing');
      return { size: b.length, sha256: digest(b) };
    },
    async upload(folder, name, bytes) {
      this.operations.push('upload');
      stored.set(`${folder}/${name}`, bytes);
    },
    async move(from, to, name) {
      this.operations.push('move');
      stored.set(`${to === '/' ? '' : to}/${name}`, stored.get(`${from}/${name}`));
      stored.delete(`${from}/${name}`);
    },
    async remove(path) {
      this.operations.push('remove');
      stored.delete(path);
    },
    async api() {
      return { type: 'file' };
    },
  };
}
const previous = make('1.0.0'),
  next = make('1.0.1');
const run = (box, identity = next) =>
  syncStable({ box, identity, bytes: identity.bytes, resolveIdentity: async () => previous });

describe('云盘稳定版同步', () => {
  it('先上传验证再归档，并保留人工回滚文件；同版本重试幂等', async () => {
    const old = `/Stable/${previous.name}`,
      backup = '/Archive/manual-keep.exe';
    const box = fakeBox({ [old]: previous.bytes, [backup]: Buffer.from('keep') });
    await run(box);
    expect(box.operations).toEqual(['upload', 'move']);
    expect(box.stored.get(`/Stable/${next.name}`)).toEqual(next.bytes);
    expect(box.stored.get(`/Archive/${previous.name}`)).toEqual(previous.bytes);
    expect(box.stored.has(backup)).toBe(true);
    box.operations = [];
    await run(box);
    expect(box.operations).toEqual([]);
  });
  it.each(['403', '空间不足', '上传中断'])('%s 保留旧稳定版', async (reason) => {
    const path = `/Stable/${previous.name}`;
    const box = fakeBox({ [path]: previous.bytes });
    box.upload = async () => {
      throw Error(reason);
    };
    await expect(run(box)).rejects.toThrow(reason);
    expect(box.stored.get(path)).toEqual(previous.bytes);
  });
  it('远端上传内容损坏时保留旧版并停止归档', async () => {
    const path = `/Stable/${previous.name}`,
      box = fakeBox({ [path]: previous.bytes });
    box.upload = async (folder, name) => box.stored.set(`${folder}/${name}`, Buffer.from('bad'));
    await expect(run(box)).rejects.toThrow('内容冲突');
    expect(box.stored.get(path)).toEqual(previous.bytes);
    expect(box.operations).toEqual([]);
  });
  it('移动失败后保留两个可下载版本，重试完成归档', async () => {
    const box = fakeBox({ [`/Stable/${previous.name}`]: previous.bytes });
    const move = box.move;
    box.move = async () => {
      throw Error('move failed');
    };
    await expect(run(box)).rejects.toThrow('move failed');
    expect((await box.list('/Stable')).length).toBe(2);
    box.move = move;
    await run(box);
    expect((await box.list('/Stable')).map((e) => e.name)).toEqual([next.name]);
  });
  it('同名不同内容、Archive 冲突和外部文件均停止同步', async () => {
    for (const files of [
      { [`/Stable/${next.name}`]: Buffer.from('bad') },
      {
        [`/Stable/${previous.name}`]: previous.bytes,
        [`/Archive/${previous.name}`]: Buffer.from('bad'),
      },
      { '/Stable/unrelated.txt': Buffer.from('keep') },
    ]) {
      const box = fakeBox(files);
      await expect(run(box)).rejects.toThrow();
      expect(box.operations).toEqual([]);
    }
  });
  it('Archive 已有相同回滚包时完成中断后的整理', async () => {
    const box = fakeBox({
      [`/Stable/${previous.name}`]: previous.bytes,
      [`/Archive/${previous.name}`]: previous.bytes,
    });
    await run(box);
    expect(box.operations).toEqual(['upload', 'remove']);
    expect(box.stored.has(`/Archive/${previous.name}`)).toBe(true);
  });
  it('拒绝旧版本重试覆盖新版本', async () => {
    const box = fakeBox({ [`/Stable/${next.name}`]: next.bytes });
    await expect(run(box, previous)).rejects.toThrow('更新版本');
    expect(box.operations).toEqual([]);
  });
  it('小文件探测清理唯一临时文件，保持正式文件', async () => {
    const path = `/Stable/${previous.name}`,
      box = fakeBox({ [path]: previous.bytes });
    await probe(box);
    expect([...box.stored.keys()]).toEqual([path]);
  });
  it('缺失 Token 和外域临时上传地址被拒绝', () => {
    expect(() => new BoxClient('')).toThrow('未配置');
    const box = new BoxClient('test');
    expect(() => box.temporaryUrl('https://elsewhere.example/upload')).toThrow('允许范围');
    expect(() =>
      box.temporaryUrl('https://user:secret@box.nju.edu.cn/seafhttp/upload-api/a'),
    ).toThrow('允许范围');
  });
});

describe('已发布安装包身份', () => {
  const sha = 'a'.repeat(40),
    hash = 'b'.repeat(64);
  const manifest = {
    schemaVersion: 1,
    developmentOnly: false,
    desktopBuildProfile: 'release',
    archive: 'Mizar-v1.0.1-Windows-x64.zip',
    appVersion: '1.0.1',
    gitSha: sha,
    contentDigest: hash,
    archiveSha256: hash,
  };
  const distribution = {
    schemaVersion: 1,
    format: 'nsis-setup',
    ...manifest,
    archive: next.name,
    archiveBytes: next.size,
    archiveSha256: next.sha256,
    originalArchiveSha256: hash,
  };
  const release = {
    tag_name: 'v1.0.1',
    draft: false,
    prerelease: false,
    published_at: '2026-10-09',
    assets: [{ name: next.name, size: next.size, digest: `sha256:${next.sha256}` }],
  };
  it('绑定标签源码、版本、分发内容和 Release 摘要', () => {
    expect(validateRelease(release, manifest, distribution, 'v1.0.1', sha).sha256).toBe(
      next.sha256,
    );
  });
  it.each([
    { draft: true },
    { prerelease: true },
    { tag_name: 'v1.0.0' },
    { published_at: null },
    { assets: [] },
    { assets: [{ name: next.name, size: next.size, digest: `sha256:${hash}` }] },
  ])('拒绝未发布或身份冲突 %j', (change) => {
    expect(() =>
      validateRelease({ ...release, ...change }, manifest, distribution, 'v1.0.1', sha),
    ).toThrow();
  });
  it('拒绝清单版本、源码、大小与内容不一致', () => {
    for (const change of [
      { gitSha: 'c'.repeat(40) },
      { appVersion: '1.0.2' },
      { contentDigest: 'c'.repeat(64) },
      { archiveBytes: 99 },
      { originalArchiveSha256: 'c'.repeat(64) },
    ]) {
      expect(() =>
        validateRelease(release, manifest, { ...distribution, ...change }, 'v1.0.1', sha),
      ).toThrow();
    }
  });
  it.each([
    { developmentOnly: true },
    { desktopBuildProfile: 'ci' },
    { schemaVersion: 2 },
    { archive: 'unrelated.zip' },
    { archiveSha256: undefined },
  ])('拒绝非正式产品清单 %j', (change) => {
    expect(() =>
      validateRelease(release, { ...manifest, ...change }, distribution, 'v1.0.1', sha),
    ).toThrow();
  });
});

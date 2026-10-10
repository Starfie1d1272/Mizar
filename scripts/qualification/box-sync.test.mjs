import { makeMachineMetadata } from '../../packages/resource-pack-contract/transport.mjs';
import { describe, it, expect, vi } from 'vitest';
import { Buffer } from 'node:buffer';
import {
  digest,
  syncStable,
  syncStableRelease,
  syncOffline,
  syncResourceFiles,
  syncRuntimeFiles,
  syncBootstrap,
  syncUserDownloads,
  rollbackDownloads,
  validateOfflineRelease,
  validateRelease,
  BoxClient,
  probe,
  promotionTag,
  cacheReleaseIdentities,
} from './box-sync.mjs';

const { URL, Response, ReadableStream, DOMException } = globalThis;

it('shares same-run verified identity lookup across package kinds, without bypassing rejection', async () => {
  const lookup = vi.fn(async (tag) => {
    if (tag === 'v1.0.0') throw new Error('invalid publication');
    return { version: tag, offline: {}, bootstrap: {} };
  });
  const resolveIdentity = cacheReleaseIdentities(lookup);
  const [full, offline] = await Promise.all([resolveIdentity('v1.1.0'), resolveIdentity('v1.1.0')]);
  expect(full).toBe(offline);
  expect(lookup).toHaveBeenCalledTimes(1);
  await expect(resolveIdentity('v1.0.0')).rejects.toThrow('invalid publication');
  await expect(resolveIdentity('v1.0.0')).rejects.toThrow('invalid publication');
  expect(lookup).toHaveBeenCalledTimes(2);
});
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
  const directories = new Set();
  return {
    stored,
    operations: [],
    async initialize() {},
    async list(folder) {
      const prefix = `${folder === '/' ? '' : folder}/`;
      const entries = new Map();
      for (const path of [...stored.keys(), ...directories]) {
        if (!path.startsWith(prefix)) continue;
        const relative = path.slice(prefix.length);
        const name = relative.split('/')[0];
        if (name)
          entries.set(name, {
            name,
            type: relative.includes('/') || directories.has(path) ? 'dir' : 'file',
          });
      }
      return [...entries.values()];
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
    async copy(from, to, name) {
      this.operations.push('copy');
      if (stored.has(`${to}/${name}`)) throw Error('copy destination exists');
      stored.set(`${to}/${name}`, stored.get(`${from}/${name}`));
    },
    async remove(path) {
      this.operations.push('remove');
      stored.delete(path);
    },
    async api(endpoint, path, method, body) {
      if (endpoint === 'dir' && method === 'POST' && body.operation === 'mkdir') {
        directories.add(path);
        this.operations.push('mkdir');
      }
      return { type: 'file' };
    },
  };
}
const previous = make('1.0.0'),
  next = make('1.0.1');
const run = (box, identity = next) =>
  syncStable({ box, identity, bytes: identity.bytes, resolveIdentity: async () => previous });

const offline = (setup) => ({ ...setup, name: `Mizar-v${setup.version}-Windows-x64.zip` });
const offlinePrevious = offline(previous),
  offlineNext = offline(next);

describe('云盘稳定版同步', () => {
  it('完成安装包校验与归档才发布 Updates 清单，失败保留原清单，重试幂等', async () => {
    const oldIndex = Buffer.from('old signed index');
    const updateIndex = Buffer.from('new signed index');
    const box = fakeBox({
      [`/Stable/${previous.name}`]: previous.bytes,
      '/Updates/latest.json': oldIndex,
    });
    const move = box.move;
    box.move = async () => {
      throw Error('archival failed');
    };
    const sync = () =>
      syncStableRelease({
        box,
        identity: next,
        bytes: next.bytes,
        resolveIdentity: async () => previous,
        updateIndex,
        offline: {
          identity: offlineNext,
          bytes: offlineNext.bytes,
          resolveIdentity: async () => offlinePrevious,
        },
      });
    await expect(sync()).rejects.toThrow('archival failed');
    expect(box.stored.get('/Updates/latest.json')).toEqual(oldIndex);
    expect(box.stored.has(`/Stable/${previous.name}`)).toBe(true);
    box.move = move;
    await sync();
    expect((await box.list('/Stable')).map((e) => e.name)).toEqual([next.name]);
    expect(box.stored.get(`/Archive/${previous.name}`)).toEqual(previous.bytes);
    expect(box.stored.get('/Updates/latest.json')).toEqual(updateIndex);
    expect(box.operations.slice(-2)).toEqual(['move', 'upload']);
    box.operations = [];
    await sync();
    expect(box.operations).toEqual([]);
  });
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
  it('上传失败保留旧稳定版', async () => {
    const path = `/Stable/${previous.name}`;
    const box = fakeBox({ [path]: previous.bytes });
    box.upload = async () => {
      throw Error('上传中断');
    };
    await expect(run(box)).rejects.toThrow('上传中断');
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
  it.each(['timeout', 'http', 'body'])(
    '定位 %s 失败且不泄漏凭据、地址或服务器正文',
    async (failure) => {
      const token = 'private-token-fixture',
        secret = 'private-signed-url-fixture';
      const logs = [];
      const output = vi.spyOn(console, 'log').mockImplementation((value) => logs.push(value));
      vi.stubGlobal('fetch', async (url) => {
        if (/\/(?:upload|download)-link\//.test(new URL(url).pathname))
          return new Response(
            JSON.stringify(`https://box.nju.edu.cn/seafhttp/upload-api/${secret}`),
          );
        if (failure === 'http') return new Response(token + secret, { status: 503 });
        if (failure === 'body')
          return new Response(
            new ReadableStream({
              start(controller) {
                controller.error(new DOMException(token + secret, 'AbortError'));
              },
            }),
          );
        throw new TypeError(token + secret, { cause: { code: 'UND_ERR_CONNECT_TIMEOUT' } });
      });
      try {
        // Production captures fetch at import. Import after the transport fixture,
        // keeping the test off the real mirror and leaving production unchanged.
        vi.resetModules();
        const { BoxClient: TransportClient } = await import('./box-sync.mjs');
        const stage = failure === 'body' ? '回读/Offline' : '上传/Offline';
        let message;
        try {
          const client = new TransportClient(token);
          if (failure === 'body') await client.hash('/Offline/release.zip');
          else await client.upload('/Offline', 'release.zip', Buffer.from('original'));
        } catch (error) {
          message = error.message;
        }
        expect(message).toContain(stage);
        expect(message).toContain(
          failure === 'http'
            ? 'HTTP 503'
            : failure === 'body'
              ? 'timeout'
              : 'UND_ERR_CONNECT_TIMEOUT',
        );
        if (failure === 'timeout') expect(message).toContain('600000ms');
        const reported = logs.join('\n') + message;
        expect(reported).toContain(`Box ${stage} 失败`);
        expect(reported).toMatch(/失败（\d+ms）/);
        expect(reported).not.toContain(token);
        expect(reported).not.toContain(secret);
        expect(reported).not.toContain('https://');
      } finally {
        output.mockRestore();
        vi.unstubAllGlobals();
        vi.resetModules();
      }
    },
  );
  it.each(['recover', 'exhausted', 'write', 'http', 'abort'])(
    '只读连接重试边界：%s',
    async (failure) => {
      vi.useFakeTimers();
      const output = vi.spyOn(console, 'log').mockImplementation(() => {});
      const signals = [];
      const transport = vi.fn(async (_url, options) => {
        signals.push(options.signal);
        if (failure === 'http') return new Response('{}', { status: 503 });
        if (failure === 'abort') throw new DOMException('private error', 'AbortError');
        if (failure === 'recover' && signals.length === 2) return new Response('[]');
        throw new TypeError('private error', { cause: { code: 'UND_ERR_CONNECT_TIMEOUT' } });
      });
      vi.stubGlobal('fetch', transport);
      try {
        vi.resetModules();
        const { BoxClient: TransportClient } = await import('./box-sync.mjs');
        const request = new TransportClient('fixture-token').api(
          'dir',
          '/Archive',
          failure === 'write' ? 'POST' : 'GET',
        );
        const assertion =
          failure === 'recover'
            ? expect(request).resolves.toEqual([])
            : expect(request).rejects.toThrow();
        await vi.advanceTimersByTimeAsync(3000);
        await assertion;
        expect(transport).toHaveBeenCalledTimes(
          failure === 'recover' ? 2 : failure === 'exhausted' ? 3 : 1,
        );
        expect(new Set(signals).size).toBe(signals.length);
        const logs = output.mock.calls.flat().join('\n');
        if (failure === 'recover') expect(logs).toContain('1s 后重试 1/2');
        if (failure === 'exhausted') expect(logs).toContain('2s 后重试 2/2');
      } finally {
        output.mockRestore();
        vi.unstubAllGlobals();
        vi.resetModules();
        vi.useRealTimers();
      }
    },
  );
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

describe('完整离线 ZIP 的独立镜像与共同发布屏障', () => {
  const runOffline = (box, identity = offlineNext) =>
    syncOffline({
      box,
      identity,
      bytes: identity.bytes,
      resolveIdentity: async () => offlinePrevious,
    });
  it('Archive 保留完整旧 ZIP，同版重试不上传或覆盖', async () => {
    const box = fakeBox({ [`/Offline/${offlinePrevious.name}`]: offlinePrevious.bytes });
    await runOffline(box);
    expect(box.stored.get(`/Archive/${offlinePrevious.name}`)).toEqual(offlinePrevious.bytes);
    expect(box.stored.get(`/Offline/${offlineNext.name}`)).toEqual(offlineNext.bytes);
    box.operations = [];
    await runOffline(box);
    expect(box.operations).toEqual([]);
  });
  it('损坏、Archive 冲突、外部文件与降版在整理前拒绝', async () => {
    for (const files of [
      { [`/Offline/${offlineNext.name}`]: Buffer.from('bad') },
      {
        [`/Offline/${offlinePrevious.name}`]: offlinePrevious.bytes,
        [`/Archive/${offlinePrevious.name}`]: Buffer.from('bad'),
      },
      { '/Offline/manual.zip': Buffer.from('keep') },
    ]) {
      const box = fakeBox(files);
      await expect(runOffline(box)).rejects.toThrow();
      expect(box.operations).toEqual([]);
    }
    const newer = fakeBox({ [`/Offline/${offlineNext.name}`]: offlineNext.bytes });
    await expect(runOffline(newer, offlinePrevious)).rejects.toThrow('更新版本');
    expect(newer.operations).toEqual([]);
  });
  it('离线上传损坏或归档中断时保留旧 Updates，重试完成后才发布', async () => {
    const old = Buffer.from('old signed update index'),
      current = Buffer.from('new signed update index');
    const box = fakeBox({
      [`/Offline/${offlinePrevious.name}`]: offlinePrevious.bytes,
      [`/Stable/${previous.name}`]: previous.bytes,
      '/Updates/latest.json': old,
    });
    const upload = box.upload;
    box.upload = async function (folder, name, bytes) {
      await upload.call(this, folder, name, folder === '/Offline' ? Buffer.from('bad') : bytes);
    };
    const sync = () =>
      syncStableRelease({
        box,
        identity: next,
        bytes: next.bytes,
        resolveIdentity: async () => previous,
        offline: {
          identity: offlineNext,
          bytes: offlineNext.bytes,
          resolveIdentity: async () => offlinePrevious,
        },
        updateIndex: current,
      });
    await expect(sync()).rejects.toThrow('内容冲突');
    expect(box.stored.get('/Updates/latest.json')).toEqual(old);
    expect(box.stored.get(`/Offline/${offlinePrevious.name}`)).toEqual(offlinePrevious.bytes);
    expect(box.stored.get(`/Stable/${previous.name}`)).toEqual(previous.bytes);
    box.stored.delete(`/Offline/${offlineNext.name}`); // Operator removes only this failed fixture upload.
    box.upload = upload;
    const move = box.move;
    box.move = async () => {
      throw Error('offline archive interrupted');
    };
    await expect(sync()).rejects.toThrow('archive interrupted');
    expect(box.stored.get('/Updates/latest.json')).toEqual(old);
    box.move = move;
    await sync();
    expect(box.stored.get('/Updates/latest.json')).toEqual(current);
    expect(box.stored.get(`/Archive/${offlinePrevious.name}`)).toEqual(offlinePrevious.bytes);
  });
  it('缺少离线包或跨版本包不能启动镜像事务', async () => {
    const box = fakeBox();
    await expect(
      syncStableRelease({
        box,
        identity: next,
        bytes: next.bytes,
        resolveIdentity: async () => previous,
      }),
    ).rejects.toThrow('缺少');
    await expect(
      syncStableRelease({
        box,
        identity: next,
        bytes: next.bytes,
        resolveIdentity: async () => previous,
        offline: {
          identity: offlinePrevious,
          bytes: offlinePrevious.bytes,
          resolveIdentity: async () => offlinePrevious,
        },
      }),
    ).rejects.toThrow('同源同版');
    expect(box.operations).toEqual([]);
  });
  it('仅接收同标签、精确源码与正式完整构建的唯一 ZIP', () => {
    const manifest = {
      schemaVersion: 1,
      appVersion: '1.0.1',
      gitSha: 'a'.repeat(40),
      archive: offlineNext.name,
      archiveSha256: offlineNext.sha256,
      developmentOnly: false,
      desktopBuildProfile: 'release',
    };
    const asset = {
      name: offlineNext.name,
      size: offlineNext.size,
      digest: `sha256:${offlineNext.sha256}`,
      browser_download_url: `https://github.com/Starfie1d1272/Mizar/releases/download/v1.0.1/${offlineNext.name}`,
    };
    const release = {
      id: 42,
      tag_name: 'v1.0.1',
      draft: false,
      prerelease: false,
      published_at: '2026-10-10T00:00:00Z',
      assets: [asset],
    };
    expect(validateOfflineRelease(release, manifest, 'v1.0.1', manifest.gitSha).sha256).toBe(
      offlineNext.sha256,
    );
    for (const change of [
      { draft: true },
      { prerelease: true },
      { assets: [] },
      { assets: [asset, asset] },
      { assets: [{ ...asset, digest: 'sha256:' + 'b'.repeat(64) }] },
      { assets: [{ ...asset, browser_download_url: 'https://evil.invalid/zip' }] },
    ]) {
      expect(() =>
        validateOfflineRelease({ ...release, ...change }, manifest, 'v1.0.1', manifest.gitSha),
      ).toThrow();
    }
    for (const change of [
      { developmentOnly: true },
      { desktopBuildProfile: 'ci' },
      { schemaVersion: 2 },
      { gitSha: 'b'.repeat(40) },
    ])
      expect(() =>
        validateOfflineRelease(release, { ...manifest, ...change }, 'v1.0.1', manifest.gitSha),
      ).toThrow();
  });
});

it('mirrors immutable resource transport bytes before pointer publication and refuses changed existing bytes', async () => {
  // Transport fixture only: signature verification remains the original producer/SDK.
  const { RESOURCE_ASSET_NAMES } =
    await import('../../packages/resource-pack-contract/catalog.mjs');
  const files = [
    ...Object.values(RESOURCE_ASSET_NAMES),
    'Mizar-official-epl-default-1.0.0.zip',
  ].map((name) => {
    const bytes = Buffer.from('original transport bytes: ' + name);
    return { name, bytes, size: bytes.length, sha256: digest(bytes) };
  });
  const box = fakeBox();
  const readback = vi.spyOn(box, 'hash');
  await syncResourceFiles({ box, version: '1.0.1', files });
  expect(readback).toHaveBeenCalledTimes(files.length);
  for (const file of files)
    expect(box.stored.get('/Resources/v1.0.1/' + file.name)).toEqual(file.bytes);
  box.operations.length = 0;
  readback.mockClear();
  await syncResourceFiles({ box, version: '1.0.1', files });
  expect(readback).toHaveBeenCalledTimes(files.length);
  expect(box.operations).toEqual([]);
  box.stored.set('/Resources/v1.0.1/' + files[0].name, Buffer.from('changed'));
  await expect(syncResourceFiles({ box, version: '1.0.1', files })).rejects.toThrow();
  expect(box.operations).toEqual([]);
});
describe('unchanged official resource bytes across compatible Core releases', () => {
  const bytes = Buffer.from('transport-only original resource ZIP fixture');
  const file = {
    name: 'Mizar-official-epl-default-1.0.0.zip',
    bytes,
    size: bytes.length,
    sha256: digest(bytes),
  };
  const source = '/Resources/v1.0.0/' + file.name;
  const target = '/Resources/v1.0.1/' + file.name;
  const sync = (box) =>
    syncResourceFiles({
      box,
      version: '1.0.1',
      files: [file],
      metadataInRuntime: true,
      reuseVersion: '1.0.0',
    });
  it('copies verified server bytes with zero resource upload and preserves the original client path', async () => {
    const box = fakeBox({ [source]: bytes });
    await sync(box);
    expect(box.operations.filter((operation) => operation === 'upload')).toEqual([]);
    expect(box.operations.filter((operation) => operation === 'copy')).toEqual(['copy']);
    expect(box.stored.get(source)).toEqual(bytes);
    expect(box.stored.get(target)).toEqual(bytes);
    box.operations.length = 0;
    await sync(box);
    expect(box.operations).toEqual([]);
  });
  it('rejects corrupt source and destination bytes without copying or uploading over them', async () => {
    for (const path of [source, target]) {
      const box = fakeBox({ [source]: bytes, [path]: Buffer.from('unrelated bytes') });
      await expect(sync(box)).rejects.toThrow('内容冲突');
      expect(box.operations.filter((operation) => ['copy', 'upload'].includes(operation))).toEqual(
        [],
      );
      expect(box.stored.get(path)).toEqual(Buffer.from('unrelated bytes'));
    }
  });
  it.each([405, 501])(
    'falls back to original upload only for unsupported copy status %s',
    async (httpStatus) => {
      const box = fakeBox({ [source]: bytes });
      box.copy = async () => {
        throw Object.assign(new Error('unsupported'), { httpStatus });
      };
      await sync(box);
      expect(box.operations.filter((operation) => operation === 'upload')).toEqual(['upload']);
      expect(box.stored.get(source)).toEqual(bytes);
      expect(box.stored.get(target)).toEqual(bytes);
    },
  );
  it('does not interpret a missing source or endpoint as permission to upload', async () => {
    const box = fakeBox({ [source]: bytes });
    box.copy = async () => {
      box.stored.delete(source);
      throw Object.assign(new Error('not found'), { httpStatus: 404 });
    };
    await expect(sync(box)).rejects.toThrow('not found');
    expect(box.operations.filter((operation) => operation === 'upload')).toEqual([]);
    expect(box.stored.has(target)).toBe(false);
  });
  it.each([bytes, Buffer.from('unknown destination')])(
    'rechecks a destination created during rejected copy before fallback',
    async (destination) => {
      const box = fakeBox({ [source]: bytes });
      box.copy = async () => {
        box.stored.set(target, destination);
        throw Object.assign(new Error('unsupported'), { httpStatus: 405 });
      };
      if (destination.equals(bytes)) await sync(box);
      else await expect(sync(box)).rejects.toThrow('内容冲突');
      expect(box.operations.filter((operation) => operation === 'upload')).toEqual([]);
      expect(box.stored.get(target)).toEqual(destination);
    },
  );
  it('retains an uncertain completed copy for verified recovery instead of starting another upload', async () => {
    const box = fakeBox({ [source]: bytes });
    const copy = box.copy;
    box.copy = async (...args) => {
      await copy.apply(box, args);
      throw Error('response lost');
    };
    await expect(sync(box)).rejects.toThrow('response lost');
    expect(box.operations.filter((operation) => operation === 'upload')).toEqual([]);
    box.operations.length = 0;
    await sync(box);
    expect(box.operations).toEqual([]);
  });
});

describe('independent mirror transports before one final publication boundary', () => {
  function transports(box) {
    const carrier = makeMachineMetadata(new Map([['release-manifest.json', Buffer.from('{}')]]));
    const file = (name, bytes) => ({ name, bytes, size: bytes.length, sha256: digest(bytes) });
    return {
      box,
      identity: next,
      bytes: next.bytes,
      resolveIdentity: async () => previous,
      offline: {
        identity: offlineNext,
        bytes: offlineNext.bytes,
        resolveIdentity: async () => offlinePrevious,
      },
      runtime: [
        file('machine-metadata.json', carrier),
        file('Mizar-v1.0.1-Windows-x64-Core-Setup.exe', Buffer.from('Core transport fixture')),
      ],
      resources: [
        file('Mizar-official-epl-default-1.0.0.zip', Buffer.from('resource transport fixture')),
      ],
      updateIndex: Buffer.from('already authenticated new pointer fixture'),
    };
  }
  it('archives distinct package kinds safely after concurrent Archive snapshots without creating the shared directory', async () => {
    const oldBootstrap = { ...previous, name: 'Mizar-v1.0.0-Windows-x64-WebInstaller.exe' };
    const bootstrap = { ...next, name: 'Mizar-v1.0.1-Windows-x64-WebInstaller.exe' };
    const backup = Buffer.from('operator archive');
    const box = fakeBox({
      ['/Stable/' + previous.name]: previous.bytes,
      ['/Stable/Downloads/' + oldBootstrap.name]: oldBootstrap.bytes,
      ['/Offline/' + offlinePrevious.name]: offlinePrevious.bytes,
      '/Archive/manual-keep.zip': backup,
    });
    const list = box.list,
      api = box.api;
    let releaseSnapshots;
    const snapshots = new Promise((resolve) => {
      releaseSnapshots = resolve;
    });
    let archiveLists = 0;
    box.list = async (folder) => {
      const entries = await list.call(box, folder);
      if (folder === '/Archive' && ++archiveLists <= 2) {
        if (archiveLists === 2) releaseSnapshots();
        await snapshots;
      }
      return entries;
    };
    box.api = async (endpoint, path, ...args) => {
      if (endpoint === 'dir' && args[0] === 'POST') {
        expect(path).not.toBe('/Archive');
        expect((await list.call(box, path)).length).toBe(0);
      }
      return api.call(box, endpoint, path, ...args);
    };
    await Promise.all([
      syncStable({ box, identity: next, bytes: next.bytes, resolveIdentity: async () => previous }),
      syncBootstrap({
        box,
        identity: bootstrap,
        bytes: bootstrap.bytes,
        resolveIdentity: async () => oldBootstrap,
      }),
      syncOffline({
        box,
        identity: offlineNext,
        bytes: offlineNext.bytes,
        resolveIdentity: async () => offlinePrevious,
      }),
    ]);
    for (const identity of [previous, oldBootstrap, offlinePrevious])
      expect(box.stored.get('/Archive/' + identity.name)).toEqual(identity.bytes);
    expect(box.stored.get('/Archive/manual-keep.zip')).toEqual(backup);
    expect(archiveLists).toBeGreaterThanOrEqual(3);
  });
  it('starts Runtime, Resources and distributions concurrently and performs the final full readbacks', async () => {
    const oldIndex = Buffer.from('old pointer');
    const box = fakeBox({ '/Updates/latest.json': oldIndex });
    const upload = box.upload;
    let unblock, allStarted;
    const blocked = new Promise((resolve) => {
      unblock = resolve;
    });
    const started = new Promise((resolve) => {
      allStarted = resolve;
    });
    const categories = new Set();
    box.upload = async (folder, ...args) => {
      if (folder !== '/Updates') {
        categories.add(folder.split('/')[1]);
        if (['Runtime', 'Resources', 'Offline'].every((category) => categories.has(category)))
          allStarted();
        await blocked;
      }
      return upload.call(box, folder, ...args);
    };
    const readback = vi.spyOn(box, 'hash');
    const options = transports(box);
    const task = syncStableRelease(options);
    await started;
    expect(box.stored.get('/Updates/latest.json')).toEqual(oldIndex);
    unblock();
    await task;
    expect(box.stored.get('/Updates/latest.json')).toEqual(options.updateIndex);
    for (const path of [
      '/Stable/' + next.name,
      '/Offline/' + offlineNext.name,
      '/Runtime/v1.0.1/' + options.runtime[1].name,
      '/Resources/v1.0.1/' + options.resources[0].name,
    ])
      expect(readback.mock.calls.filter((call) => call[0] === path)).toHaveLength(2);
  });
  it('waits for an active sibling writer after failure and keeps the original update pointer', async () => {
    const oldIndex = Buffer.from('old pointer');
    const box = fakeBox({ '/Updates/latest.json': oldIndex });
    const upload = box.upload,
      hash = box.hash;
    let unblock, runtimeStarted, failedReadback;
    const blocked = new Promise((resolve) => {
      unblock = resolve;
    });
    const started = new Promise((resolve) => {
      runtimeStarted = resolve;
    });
    const failed = new Promise((resolve) => {
      failedReadback = resolve;
    });
    box.upload = async (folder, ...args) => {
      if (folder.startsWith('/Runtime/')) {
        runtimeStarted();
        await blocked;
      }
      return upload.call(box, folder, ...args);
    };
    box.hash = async (path) => {
      if (path.startsWith('/Offline/')) {
        failedReadback();
        throw Error('offline readback failed');
      }
      return hash.call(box, path);
    };
    let settled = false;
    const task = syncStableRelease(transports(box));
    task.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await Promise.all([started, failed]);
    await new Promise((resolve) => globalThis.setImmediate(resolve));
    expect(settled).toBe(false);
    expect(box.stored.get('/Updates/latest.json')).toEqual(oldIndex);
    unblock();
    await expect(task).rejects.toThrow('offline readback failed');
    expect(box.stored.get('/Updates/latest.json')).toEqual(oldIndex);
  });
});

it('keeps the legacy machine backend while placing the lightweight EXE in user Downloads', async () => {
  const bootstrap = { ...next, name: 'Mizar-v1.0.1-Windows-x64-WebInstaller.exe' };
  const box = fakeBox({ ['/Stable/' + next.name]: next.bytes });
  await syncBootstrap({
    box,
    identity: bootstrap,
    bytes: bootstrap.bytes,
    resolveIdentity: async () => previous,
  });
  expect(box.stored.get('/Stable/' + next.name)).toEqual(next.bytes);
  expect(box.stored.get('/Stable/Downloads/' + bootstrap.name)).toEqual(bootstrap.bytes);
  expect(box.stored.has('/Stable/' + bootstrap.name)).toBe(false);
});

it('keeps Runtime original carrier/backend immutable across retries and refuses changed readback before uploading', async () => {
  const version = '2.0.0';
  const carrier = makeMachineMetadata(new Map([['release-manifest.json', Buffer.from('{}')]]));
  const backend = Buffer.from('transport-only backend fixture; never executed');
  const files = [
    { name: 'machine-metadata.json', bytes: carrier },
    { name: 'Mizar-v2.0.0-Windows-x64-Core-Setup.exe', bytes: backend },
  ].map((f) => ({ ...f, size: f.bytes.length, sha256: digest(f.bytes) }));
  const box = fakeBox();
  const readback = vi.spyOn(box, 'hash');
  await syncRuntimeFiles({ box, version, files });
  expect(readback).toHaveBeenCalledTimes(files.length);
  expect(box.operations).toEqual(['mkdir', 'mkdir', 'upload', 'upload']);
  box.operations.length = 0;
  readback.mockClear();
  await syncRuntimeFiles({ box, version, files });
  expect(readback).toHaveBeenCalledTimes(files.length);
  expect(box.operations).toEqual([]);
  box.stored.set('/Runtime/v2.0.0/machine-metadata.json', Buffer.from('changed'));
  await expect(syncRuntimeFiles({ box, version, files })).rejects.toThrow();
  expect(box.operations).toEqual([]);
});

describe('the public download pair and legacy compatibility boundary', () => {
  const bootstrapIdentity = { ...next, name: 'Mizar-v1.0.1-Windows-x64-WebInstaller.exe' };
  const bootstrap = {
    identity: bootstrapIdentity,
    bytes: bootstrapIdentity.bytes,
    resolveIdentity: async () => undefined,
  };
  const offlineIdentity = { ...next, name: 'Mizar-v1.0.1-Windows-x64.zip' };
  const offline = {
    identity: offlineIdentity,
    bytes: offlineIdentity.bytes,
    resolveIdentity: async () => undefined,
  };
  const legacy = () =>
    fakeBox({
      ['/Stable/' + next.name]: next.bytes,
      ['/Stable/' + bootstrapIdentity.name]: bootstrapIdentity.bytes,
      ['/Offline/' + offlineIdentity.name]: offlineIdentity.bytes,
      '/Archive/manual-keep.zip': Buffer.from('operator backup'),
    });
  const sync = (box) =>
    syncUserDownloads({
      box,
      bootstrap,
      offline,
      resolveIdentity: async () => undefined,
      accept: async () => 'fixture acceptance',
    });
  it('moves only the verified legacy lightweight entry, leaves the Full path intact and repeats without uploads', async () => {
    const box = legacy();
    await sync(box);
    expect((await box.list('/Stable/Downloads')).map((e) => e.name).sort()).toEqual(
      [bootstrapIdentity.name, offlineIdentity.name].sort(),
    );
    expect(box.stored.get('/Stable/' + next.name)).toEqual(next.bytes);
    expect(box.stored.has('/Stable/' + bootstrapIdentity.name)).toBe(false);
    expect(box.stored.get('/Archive/' + bootstrapIdentity.name)).toEqual(bootstrapIdentity.bytes);
    expect(box.stored.get('/Archive/manual-keep.zip')).toEqual(Buffer.from('operator backup'));
    expect(box.stored.has('/Offline/' + offlineIdentity.name)).toBe(false);
    expect(box.operations.filter((op) => op === 'upload').length).toBe(1); // Only the tiny EXE; the ZIP was moved.
    box.operations.length = 0;
    await sync(box);
    expect(box.operations).toEqual([]);
  });
  it('rejects changed bytes, unknown user files, Archive collisions and newer versions before migration', async () => {
    for (const corrupt of [
      ['/Stable/' + bootstrapIdentity.name, Buffer.from('changed')],
      ['/Archive/' + bootstrapIdentity.name, Buffer.from('changed')],
      ['/Stable/Downloads/' + next.name, next.bytes],
      ['/Stable/Downloads/Mizar-v9.0.0-Windows-x64.zip', Buffer.from('newer')],
    ]) {
      const box = legacy();
      box.stored.set(...corrupt);
      await expect(sync(box)).rejects.toThrow();
      expect(box.operations).toEqual([]);
      expect(box.stored.get('/Stable/' + next.name)).toEqual(next.bytes);
    }
  });
  it('preserves the old root on interrupted archival, then permits same-version retry and non-destructive rollback', async () => {
    const box = legacy();
    const move = box.move;
    box.move = async () => {
      throw Error('migration interrupted');
    };
    await expect(sync(box)).rejects.toThrow('migration interrupted');
    expect(box.stored.get('/Stable/' + bootstrapIdentity.name)).toEqual(bootstrapIdentity.bytes);
    box.move = move;
    await sync(box);
    await rollbackDownloads({ box, identity: next, offline, bootstrap });
    expect(box.stored.get('/Stable/' + bootstrapIdentity.name)).toEqual(bootstrapIdentity.bytes);
    expect(box.stored.get('/Offline/' + offlineIdentity.name)).toEqual(offlineIdentity.bytes);
    expect((await box.list('/Stable/Downloads')).map((e) => e.name)).toEqual([
      bootstrapIdentity.name,
    ]);
    expect(box.stored.get('/Archive/' + bootstrapIdentity.name)).toEqual(bootstrapIdentity.bytes);
    box.operations.length = 0;
    await rollbackDownloads({ box, identity: next, offline, bootstrap });
    expect(box.operations).toEqual([]);
    box.stored.set('/Stable/' + bootstrapIdentity.name, Buffer.from('unknown bytes'));
    await expect(rollbackDownloads({ box, identity: next, offline, bootstrap })).rejects.toThrow(
      '内容冲突',
    );
    expect(box.operations).toEqual([]);
  });
  it('requires anonymous directory identity and exact original bytes without sending credentials', async () => {
    const listing = {
      dir_path: '/Stable/Downloads/',
      dirent_list: [bootstrapIdentity, offlineIdentity].map((f) => ({
        file_name: f.name,
        file_path: '/Downloads/' + f.name,
        size: f.size,
        is_dir: false,
      })),
    };
    const mocked = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, options) => {
      expect(options.headers).toBeUndefined();
      const parsed = new URL(url);
      if (parsed.pathname.includes('dirents')) return new Response(JSON.stringify(listing));
      return new Response(
        parsed.searchParams.get('p').endsWith('.zip') ? offline.bytes : bootstrap.bytes,
      );
    });
    vi.resetModules();
    const { verifyPublicDownloads: publicDownloads } = await import('./box-sync.mjs');
    try {
      await expect(publicDownloads({ offline, bootstrap })).resolves.toContain('匿名验收成功');
      listing.dir_path = '/another-share/Downloads/';
      await expect(publicDownloads({ offline, bootstrap })).rejects.toThrow('未就绪');
      listing.dir_path = '/Stable/Downloads/';
      mocked.mockImplementation(async (url) =>
        new URL(url).pathname.includes('dirents')
          ? new Response(JSON.stringify(listing))
          : new Response(Buffer.from('bad')),
      );
      await expect(publicDownloads({ offline, bootstrap })).rejects.toThrow('原字节');
    } finally {
      mocked.mockRestore();
      vi.resetModules();
    }
  });
});

it('keeps the existing update pointer when the newly migrated user route fails anonymous acceptance', async () => {
  const lightweight = { ...next, name: 'Mizar-v1.0.1-Windows-x64-WebInstaller.exe' };
  const zip = { ...next, name: 'Mizar-v1.0.1-Windows-x64.zip' };
  const oldIndex = Buffer.from('previous signed pointer');
  const box = fakeBox({
    ['/Stable/' + next.name]: next.bytes,
    ['/Stable/' + lightweight.name]: lightweight.bytes,
    ['/Offline/' + zip.name]: zip.bytes,
    '/Updates/latest.json': oldIndex,
  });
  vi.stubGlobal('fetch', async () => new Response('not created or not public', { status: 404 }));
  try {
    vi.resetModules();
    const { syncStableRelease: sync } = await import('./box-sync.mjs');
    await expect(
      sync({
        box,
        identity: next,
        bytes: next.bytes,
        resolveIdentity: async () => previous,
        offline: { identity: zip, bytes: zip.bytes, resolveIdentity: async () => undefined },
        bootstrap: {
          identity: lightweight,
          bytes: lightweight.bytes,
          resolveIdentity: async () => undefined,
        },
        updateIndex: Buffer.from('new signed pointer'),
      }),
    ).rejects.toThrow('HTTP 404');
    expect(box.stored.get('/Updates/latest.json')).toEqual(oldIndex);
    expect(box.stored.get('/Stable/' + next.name)).toEqual(next.bytes);
    expect(box.stored.get('/Stable/' + lightweight.name)).toEqual(lightweight.bytes);
    expect(box.stored.has('/Archive/' + lightweight.name)).toBe(false);
    expect(box.stored.get('/Offline/' + zip.name)).toEqual(zip.bytes);
  } finally {
    vi.unstubAllGlobals();
    vi.resetModules();
  }
});

it('bounds routine anonymous ZIP acceptance to a range probe instead of another full ZIP download', async () => {
  const zip = { ...next, name: 'Mizar-v1.0.1-Windows-x64.zip' };
  const lightweight = { ...next, name: 'Mizar-v1.0.1-Windows-x64-WebInstaller.exe' };
  const transport = vi.fn(async (url, options) => {
    const parsed = new URL(url);
    if (parsed.pathname.includes('dirents'))
      return new Response(
        JSON.stringify({
          dir_path: '/Stable/Downloads/',
          dirent_list: [zip, lightweight].map((f) => ({
            file_name: f.name,
            file_path: '/Downloads/' + f.name,
            size: f.size,
            is_dir: false,
          })),
        }),
      );
    if (parsed.searchParams.get('p').endsWith('.zip')) {
      expect(options.headers).toEqual({ Range: 'bytes=0-0' });
      return new Response(zip.bytes.subarray(0, 1), {
        status: 206,
        headers: { 'content-range': `bytes 0-0/${zip.size}` },
      });
    }
    expect(options.headers).toBeUndefined();
    return new Response(lightweight.bytes);
  });
  vi.stubGlobal('fetch', transport);
  try {
    vi.resetModules();
    const { verifyPublicDownloads: accept } = await import('./box-sync.mjs');
    await expect(
      accept({ offline: { identity: zip }, bootstrap: { identity: lightweight }, full: false }),
    ).resolves.toContain('ZIP 原字节由同步校验');
    expect(transport).toHaveBeenCalledTimes(3);
  } finally {
    vi.unstubAllGlobals();
    vi.resetModules();
  }
});

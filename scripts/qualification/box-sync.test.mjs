import { Buffer } from 'node:buffer';
import { describe, expect, it, vi } from 'vitest';
import { digest, syncStableRelease, syncUserDownloads } from './box-sync.mjs';
import { makeMachineMetadata } from '../../packages/resource-pack-contract/transport.mjs';

const { Response } = globalThis;
const version = '1.6.0';
const identity = (name, bytes = Buffer.from(name)) => ({
  name,
  bytes,
  size: bytes.length,
  sha256: digest(bytes),
  version,
  gitSha: 'a'.repeat(40),
  releaseId: 16,
});
function fixture() {
  const dirs = new Set(['/', '/Stable', '/Stable/Downloads', '/Archive', '/Updates']);
  const files = new Map();
  const writes = [];
  const box = {
    initialize: async () => {},
    list: async (folder) => [
      ...[...dirs]
        .filter(
          (p) => p !== '/' && p.slice(0, p.lastIndexOf('/')) === (folder === '/' ? '' : folder),
        )
        .map((p) => ({ name: p.slice(p.lastIndexOf('/') + 1), type: 'dir' })),
      ...[...files]
        .filter(([p]) => p.slice(0, p.lastIndexOf('/')) === folder)
        .map(([p, b]) => ({ name: p.slice(p.lastIndexOf('/') + 1), type: 'file', size: b.length })),
    ],
    api: async (_kind, path, method, data) => {
      if (method !== 'POST' || data.operation !== 'mkdir') throw Error('unexpected api');
      dirs.add(path);
    },
    hash: async (path) => {
      const b = files.get(path);
      if (!b) throw Error('missing ' + path);
      return { size: b.length, sha256: digest(b) };
    },
    upload: async (folder, name, bytes, replace) => {
      const path = folder + '/' + name;
      if (!replace && files.has(path)) throw Error('overwrite');
      writes.push(path);
      files.set(path, bytes);
    },
    move: async (from, to, name) => {
      if (files.has(to + '/' + name)) throw Error('overwrite archive');
      files.set(to + '/' + name, files.get(from + '/' + name));
      files.delete(from + '/' + name);
    },
    remove: async (path) => {
      files.delete(path);
    },
  };
  const full = identity(`Mizar-v${version}-Windows-x64-Setup.exe`);
  full.offline = identity(`Mizar-v${version}-Windows-x64.zip`);
  full.bootstrap = identity(`Mizar-v${version}-Windows-x64-WebInstaller.exe`);
  const runtime = [
    identity(
      'machine-metadata.json',
      makeMachineMetadata(new Map([['NSIS-LICENSE.txt', Buffer.from('fixture license')]])),
    ),
    identity(`Mizar-v${version}-Windows-x64-Core-Setup.exe`),
  ];
  const resources = [identity('Mizar-official-epl-default-1.6.0.zip')];
  files.set('/Updates/latest.json', Buffer.from('old pointer'));
  const resolveIdentity = async () => full;
  const bootstrap = {
    identity: full.bootstrap,
    bytes: full.bootstrap.bytes,
    resolveIdentity: async () => full.bootstrap,
  };
  const accept = async () => {
    expect((await box.list('/Stable/Downloads')).map((x) => x.name)).toEqual([full.bootstrap.name]);
  };
  return {
    box,
    dirs,
    files,
    writes,
    full,
    bootstrap,
    runtime,
    resources,
    resolveIdentity,
    accept,
    options: {
      box,
      identity: full,
      bootstrap,
      runtime,
      resources,
      resolveIdentity,
      accept,
      updateIndex: Buffer.from('verified new pointer'),
    },
  };
}

function addMusic(f) {
  f.dirs.add('/Stable/Music');
  const music = new Map(
    ['BLAST赏金赛.zip', 'BLAST邀请赛.zip', '上海Major.zip'].map((name) => [
      '/Stable/Music/' + name,
      Buffer.from('independent music: ' + name),
    ]),
  );
  for (const [path, bytes] of music) f.files.set(path, bytes);
  return music;
}

describe('lean Box distribution', () => {
  it('publishes only bootstrap, Core, resources and metadata; reuses the same verified files on retry', async () => {
    const f = fixture();
    await syncStableRelease(f.options);
    expect(f.writes).not.toContain('/Stable/' + f.full.name);
    expect(f.writes).not.toContain('/Stable/Downloads/' + f.full.offline.name);
    expect(f.writes.at(-1)).toBe('/Updates/latest.json');
    const first = [...f.writes];
    await syncStableRelease(f.options);
    expect(f.writes).toEqual(first);
  });
  it('preserves independent Stable/Music without inspecting or trusting its files on same-version retries', async () => {
    const f = fixture();
    const music = addMusic(f);
    const list = vi.spyOn(f.box, 'list');
    const hash = vi.spyOn(f.box, 'hash');
    const move = vi.spyOn(f.box, 'move');
    const remove = vi.spyOn(f.box, 'remove');
    const resolveIdentity = vi.fn(f.resolveIdentity);
    const options = { ...f.options, resolveIdentity };
    await syncStableRelease(options);
    const writes = [...f.writes];
    await syncStableRelease(options);
    expect(f.writes).toEqual(writes);
    expect(f.writes.at(-1)).toBe('/Updates/latest.json');
    expect(f.dirs.has('/Stable/Music')).toBe(true);
    for (const [path, bytes] of music) expect(f.files.get(path)).toEqual(bytes);
    for (const spy of [list, hash, move, remove])
      expect(spy.mock.calls.flat().some((path) => path.startsWith('/Stable/Music'))).toBe(false);
    expect(resolveIdentity).not.toHaveBeenCalled();
  });
  it.each([
    ['/Stable/Downloads/Music', 'dir'],
    ['/Stable/Music', 'file'],
    ['/Stable/Other', 'dir'],
    ['/Stable/notes.txt', 'file'],
    ['/Stable/Downloads/notes.txt', 'file'],
  ])('rejects unknown %s (%s) before changing public files', async (path, type) => {
    const f = fixture();
    if (type === 'dir') f.dirs.add(path);
    else f.files.set(path, Buffer.from('independent content'));
    const before = new Map(f.files);
    const dirs = new Set(f.dirs);
    await expect(syncUserDownloads(f)).rejects.toThrow('分发目录存在未知内容');
    expect(f.files).toEqual(before);
    expect(f.dirs).toEqual(dirs);
    expect(f.writes).toEqual([]);
  });
  it('still rejects duplicate Music entries before the independent-directory exemption', async () => {
    const f = fixture();
    addMusic(f);
    f.files.set('/Stable/Music', Buffer.from('conflicting file'));
    const before = new Map(f.files);
    await expect(syncUserDownloads(f)).rejects.toThrow('分发目录存在重复文件');
    expect(f.files).toEqual(before);
    expect(f.writes).toEqual([]);
  });
  it('archives existing Full and ZIP bytes without reuploading or losing the original', async () => {
    const f = fixture();
    f.files.set('/Stable/' + f.full.name, f.full.bytes);
    f.files.set('/Stable/Downloads/' + f.full.offline.name, f.full.offline.bytes);
    await syncStableRelease(f.options);
    expect(f.files.get('/Archive/' + f.full.name)).toEqual(f.full.bytes);
    expect(f.files.get('/Archive/' + f.full.offline.name)).toEqual(f.full.offline.bytes);
    expect(f.files.has('/Stable/' + f.full.name)).toBe(false);
  });
  it.each(['source', 'archive', 'unknown', 'newer'])(
    'preserves public files on %s conflict',
    async (kind) => {
      const f = fixture();
      addMusic(f);
      f.files.set(
        '/Stable/' + f.full.name,
        kind === 'source' ? Buffer.from('tampered') : f.full.bytes,
      );
      if (kind === 'archive') f.files.set('/Archive/' + f.full.name, Buffer.from('conflict'));
      if (kind === 'unknown') f.files.set('/Stable/notes.txt', Buffer.from('user file'));
      if (kind === 'newer')
        f.files.set('/Stable/Mizar-v9.0.0-Windows-x64-Setup.exe', Buffer.from('future'));
      const before = new Map(f.files);
      await expect(syncUserDownloads(f)).rejects.toThrow();
      expect(f.files).toEqual(before);
      expect(f.writes).toEqual([]);
    },
  );
  it('does not publish a new pointer when public download verification fails', async () => {
    const f = fixture();
    await expect(
      syncStableRelease({
        ...f.options,
        accept: async () => {
          throw Error('anonymous failed');
        },
      }),
    ).rejects.toThrow('anonymous failed');
    expect(f.files.get('/Updates/latest.json').toString()).toBe('old pointer');
    expect(f.writes).not.toContain('/Updates/latest.json');
  });
  it('rejects incomplete or legacy distributions before any upload', async () => {
    const f = fixture();
    await expect(syncStableRelease({ ...f.options, runtime: undefined })).rejects.toThrow(
      '拆分分发',
    );
    await expect(syncStableRelease({ ...f.options, resources: [] })).rejects.toThrow('拆分分发');
    await expect(
      syncStableRelease({ ...f.options, identity: { ...f.full, version: '1.1.0' } }),
    ).rejects.toThrow('1.6.0');
    expect(f.writes).toEqual([]);
  });
});

it('resumes a partially archived migration without uploading any full package', async () => {
  const f = fixture();
  const music = addMusic(f);
  f.files.set('/Stable/' + f.full.name, f.full.bytes);
  f.files.set('/Stable/Downloads/' + f.full.offline.name, f.full.offline.bytes);
  const move = f.box.move;
  f.box.move = vi.fn(async (from, to, name) => {
    if (name === f.full.offline.name) throw Error('move temporarily failed');
    return move(from, to, name);
  });
  await expect(syncStableRelease(f.options)).rejects.toThrow('move temporarily failed');
  expect(f.files.get('/Archive/' + f.full.name)).toEqual(f.full.bytes);
  expect(f.files.get('/Updates/latest.json').toString()).toBe('old pointer');
  f.box.move = move;
  await syncStableRelease(f.options);
  expect(f.files.get('/Archive/' + f.full.offline.name)).toEqual(f.full.offline.bytes);
  for (const [path, bytes] of music) expect(f.files.get(path)).toEqual(bytes);
  expect(f.writes.filter((p) => p.endsWith('-Setup.exe'))).toEqual([
    '/Runtime/v1.6.0/Mizar-v1.6.0-Windows-x64-Core-Setup.exe',
  ]);
});

it('anonymous acceptance needs only the exact bootstrap and checks every byte', async () => {
  const f = fixture();
  const fetcher = vi.fn(async (url) =>
    String(url).includes('/dirents/')
      ? new Response(
          JSON.stringify({
            dir_path: '/Stable/Downloads/',
            dirent_list: [
              {
                is_dir: false,
                file_name: f.full.bootstrap.name,
                file_path: '/Downloads/' + f.full.bootstrap.name,
                size: f.full.bootstrap.size,
              },
            ],
          }),
        )
      : new Response(f.full.bootstrap.bytes),
  );
  vi.stubGlobal('fetch', fetcher);
  vi.resetModules();
  try {
    const { verifyPublicDownloads: verify } = await import('./box-sync.mjs');
    await expect(verify({ bootstrap: f.bootstrap })).resolves.toContain('仅提供轻量 EXE');
    expect(fetcher).toHaveBeenCalledTimes(2);
    fetcher.mockImplementation(async (url) =>
      String(url).includes('/dirents/')
        ? new Response(
            JSON.stringify({
              dir_path: '/Stable/Downloads/',
              dirent_list: [
                {
                  is_dir: false,
                  file_name: f.full.bootstrap.name,
                  file_path: '/Downloads/' + f.full.bootstrap.name,
                  size: f.full.bootstrap.size,
                },
              ],
            }),
          )
        : new Response(Buffer.from('bad bytes')),
    );
    await expect(verify({ bootstrap: f.bootstrap })).rejects.toThrow('原字节不一致');
  } finally {
    vi.unstubAllGlobals();
    vi.resetModules();
  }
});

it('lists only the fixed public Downloads without a token or privileged directory request', async () => {
  const f = fixture();
  const fetcher = vi.fn(async (_url, options) => {
    expect(options.headers).toBeUndefined();
    expect(options.redirect).toBe('error');
    return new Response(
      JSON.stringify({
        dir_path: '/Stable/Downloads/',
        dirent_list: [
          {
            is_dir: false,
            file_name: f.full.bootstrap.name,
            file_path: '/Downloads/' + f.full.bootstrap.name,
            size: f.full.bootstrap.size,
          },
        ],
      }),
    );
  });
  vi.stubGlobal('fetch', fetcher);
  vi.resetModules();
  try {
    const { BoxClient } = await import('./box-sync.mjs');
    const privateTransport = vi.fn(() => {
      throw Error('private API must not be called');
    });
    const box = new BoxClient('fixture-private-token', undefined, privateTransport);
    await expect(box.list('/Stable/Downloads')).resolves.toEqual([
      { name: f.full.bootstrap.name, size: f.full.bootstrap.size, type: 'file' },
    ]);
    expect(privateTransport).not.toHaveBeenCalled();
    expect(String(fetcher.mock.calls[0][0])).toBe(
      'https://box.nju.edu.cn/api/v2.1/share-links/91dec4c27e5d47f38fcf/dirents/?path=%2FDownloads%2F',
    );
  } finally {
    vi.unstubAllGlobals();
    vi.resetModules();
  }
});

it.each(['wrong directory', 'duplicate name', 'path escape'])(
  'rejects public listing %s before migration',
  async (kind) => {
    const entry = {
      is_dir: false,
      file_name: 'file.exe',
      file_path: '/Downloads/file.exe',
      size: 2,
    };
    const listing = { dir_path: '/Stable/Downloads/', dirent_list: [entry] };
    if (kind === 'wrong directory') listing.dir_path = '/Other/';
    if (kind === 'duplicate name') listing.dirent_list.push({ ...entry });
    if (kind === 'path escape') entry.file_name = '../file.exe';
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(listing))),
    );
    vi.resetModules();
    try {
      const { readPublicDownloadDirectory } = await import('./box-sync.mjs');
      await expect(readPublicDownloadDirectory()).rejects.toThrow();
    } finally {
      vi.unstubAllGlobals();
      vi.resetModules();
    }
  },
);

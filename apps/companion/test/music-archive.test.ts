import { mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import Fastify from 'fastify';
import { MusicStore } from '../src/music/store.js';
import { readMusicPack } from '../src/music/archive.js';
import { registerMusicRoutes } from '../src/music/routes.js';
import { MusicDirector } from '../src/music/director.js';
import { musicManifest, musicWav, musicZip } from './music-fixtures.js';
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});
async function store() {
  const dir = await mkdtemp(join(tmpdir(), 'mizar-music-pack-'));
  dirs.push(dir);
  const store = new MusicStore(dir);
  await store.load();
  return store;
}
function files() {
  return {
    'music.json': Buffer.from(JSON.stringify(musicManifest())),
    'audio/等待.wav': musicWav(),
  };
}
it('loads the bundled pack only for a new music store and preserves existing choices', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mizar-builtin-music-'));
  dirs.push(dir);
  const pack = join(process.cwd(), 'apps/companion/builtin-music.zip');
  const initial = new MusicStore(dir, undefined, pack);
  await initial.load();
  expect(initial.state.config.groups.waiting.tracks[0]?.name).toBe('before_match.mp3');
  expect(initial.state.config.groups.opening.tracks[0]?.name).toBe('opening.mp3');
  await initial.configure({
    ...initial.state.config,
    groups: {
      ...initial.state.config.groups,
      waiting: { ...initial.state.config.groups.waiting, tracks: [] },
    },
  });
  const restored = new MusicStore(dir, undefined, pack);
  await restored.load();
  expect(restored.state.config.groups.waiting.tracks).toEqual([]);
});
it('imports an ordinary ZIP atomically, reloads it, and preserves the previous config for every rejected package', async () => {
  const s = await store();
  await s.update((state) => {
    state.master = 0.4;
    state.muted = true;
  });
  await s.import(musicZip(files()));
  expect(s.state.master).toBe(0.4);
  expect(s.state.muted).toBe(true);
  expect(s.state.config.groups.waiting.tracks[0]?.name).toBe('等待.wav');
  const before = await readFile(join(s.directory, 'state.json'));
  const bad = [
    musicZip({ ...files(), '../escape.wav': musicWav() }),
    musicZip({ ...files(), '/absolute.wav': musicWav() }),
    musicZip({ ...files(), 'C:/absolute.wav': musicWav() }),
    musicZip({ ...files(), 'audio\\escape.wav': musicWav() }),
    musicZip({ ...files(), 'audio/run.exe': musicWav() }),
    musicZip({ ...files(), 'audio/test.js': musicWav() }),
    musicZip(files(), { 'audio/等待.wav': 0xa1ff0000 }),
    musicZip({ ...files(), 'audio/等待.WAV': musicWav() }),
    musicZip({ ...files(), 'audio/bomb.wav': Buffer.alloc(2 * 1024 * 1024) }),
    musicZip({ ...files(), 'audio/con.wav': musicWav() }),
    musicZip({ ...files(), 'audio/fake.wav': Buffer.from('not audio') }),
    Buffer.alloc(128 * 1024 * 1024 + 1),
  ];
  const missing = musicManifest();
  missing.groups.waiting.tracks[0]!.path = 'audio/missing.wav';
  bad.push(musicZip({ ...files(), 'music.json': Buffer.from(JSON.stringify(missing)) }));
  const broken = musicZip(files());
  broken[45] = broken[45]! ^ 1;
  bad.push(broken);
  for (const zip of bad) {
    await expect(s.import(zip)).rejects.toThrow();
    expect(await readFile(join(s.directory, 'state.json'))).toEqual(before);
  }
  const loaded = new MusicStore(s.directory);
  await loaded.load();
  expect(loaded.state.config).toEqual(s.state.config);
  expect(await readFile(join(s.directory, 'state.json'), 'utf8')).not.toContain(s.directory);
});
it('rejects ZIP metadata sizes before inflate and symbolic links in the content store', async () => {
  const zip = musicZip(files());
  const end = zip.length - 22,
    cd = zip.readUInt32LE(end + 16);
  zip.writeUInt32LE(0xffffffff, cd + 24);
  await expect(readMusicPack(zip)).rejects.toThrow();
  const s = await store(),
    track = await s.add('test.wav', musicWav());
  const path = join(s.directory, 'tracks', track.id);
  await rm(path);
  await symlink(join(s.directory, 'state.json'), path);
  await expect(s.trackPath(track.id)).rejects.toThrow();
});
it('reuses verified identical audio without replacing it and rejects corrupted existing content', async () => {
  const s = await store();
  const first = await s.add('first.wav', musicWav());
  const path = join(s.directory, 'tracks', first.id);
  const before = await stat(path);
  const second = await s.add('second.wav', musicWav());
  expect(second.id).toBe(first.id);
  expect(second.name).toBe('second.wav');
  expect((await stat(path)).mtimeMs).toBe(before.mtimeMs);
  await writeFile(path, Buffer.from('corrupted'));
  await expect(s.add('first.wav', musicWav())).rejects.toThrow();
});
it('requires a loopback Origin for mutations and never returns a local absolute path or uploaded media', async () => {
  const s = await store(),
    app = Fastify();
  const director = new MusicDirector(
    s,
    {
      session: () => Promise.reject(new Error('must not access OBS')),
      close: () => Promise.resolve(),
    },
    () => {
      throw new Error('no production');
    },
  );
  registerMusicRoutes(app, s, director, {
    mode: 'loopback',
    bindHost: '127.0.0.1',
    allowedOrigins: [],
  });
  try {
    for (const origin of [undefined, 'https://evil.example']) {
      const result = await app.inject({
        method: 'POST',
        url: '/operator/music/import',
        headers: { 'content-type': 'application/zip', ...(origin ? { origin } : {}) },
        payload: musicZip(files()),
      });
      expect(result.statusCode).toBe(403);
    }
    for (const origin of [undefined, 'https://evil.example']) {
      const result = await app.inject({
        method: 'POST',
        url: '/operator/music/preview',
        headers: { ...(origin ? { origin } : {}) },
        payload: { action: 'start' },
      });
      expect(result.statusCode).toBe(403);
    }
    const invalidPreview = await app.inject({
      method: 'POST',
      url: '/operator/music/preview',
      headers: { origin: 'http://127.0.0.1:4173' },
      payload: { action: 'start', volume: 2, track: { id: '../private.wav' } },
    });
    expect(invalidPreview.statusCode).toBe(400);
    expect(invalidPreview.body).not.toContain(s.directory);
    const imported = await app.inject({
      method: 'POST',
      url: '/operator/music/import',
      headers: { origin: 'http://127.0.0.1:4173', 'content-type': 'application/zip' },
      payload: musicZip(files()),
    });
    expect(imported.statusCode).toBe(200);
    expect(imported.body).not.toContain(s.directory);
    const get = await app.inject({ url: '/local/v1/music' });
    expect(get.statusCode).toBe(200);
    expect(get.body).not.toContain(s.directory);
    expect(
      (await app.inject({ url: '/local/v1/music', headers: { host: 'evil.example' } })).statusCode,
    ).toBe(403);
    expect(
      (await app.inject({ url: '/local/v1/music', headers: { 'sec-fetch-site': 'cross-site' } }))
        .statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          url: `/local/v1/music/tracks/${s.state.config.groups.waiting.tracks[0]!.id}`,
        })
      ).statusCode,
    ).toBe(404);
  } finally {
    await app.close();
  }
});

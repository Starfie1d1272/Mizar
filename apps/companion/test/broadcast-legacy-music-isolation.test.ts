import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, chmod, link, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import Fastify from 'fastify';
import { createBroadcastRuntime } from '../src/broadcast-config/runtime.js';
import { createProductionBroadcastDependencies } from '../src/broadcast-config/production.js';
import { registerBroadcastConfigRoutes } from '../src/broadcast-config/routes.js';
import { HudConfigStore } from '../src/hud-config/store.js';
import type { MusicDirector } from '../src/music/director.js';
import { registerMusicRoutes } from '../src/music/routes.js';
import { MusicStore } from '../src/music/store.js';
import { OrchestrationStore } from '../src/orchestration/store.js';
import { musicWav } from './music-fixtures.js';

const policy = {
  mode: 'loopback' as const,
  bindHost: '127.0.0.1',
  allowedOrigins: ['http://localhost'],
};
const headers = { host: 'localhost', origin: 'http://localhost' };

async function start(root: string) {
  const hud = new HudConfigStore();
  const music = new MusicStore(join(root, 'music'));
  const camera = new OrchestrationStore(join(root, 'camera'));
  await hud.load();
  await music.load();
  await camera.load();
  const runtime = createBroadcastRuntime({
    hud,
    music,
    camera,
    dependencies: createProductionBroadcastDependencies(root, music, () =>
      Promise.reject(new Error('unexpected_asset')),
    ),
    withApplyGuard: (operation) => operation(() => true),
    diagnostic: () => undefined,
  });
  const app = Fastify();
  registerBroadcastConfigRoutes(app, runtime.store, policy, () => runtime.ready);
  // No playback operation is invoked: these tests exercise the actual binary upload route.
  registerMusicRoutes(app, music, {} as MusicDirector, policy);
  app.addHook('onReady', () => runtime.initialize());
  await app.ready();
  return { app, runtime, music };
}

for (const damage of ['missing', 'corrupt'] as const)
  test(`legacy ${damage} inactive audio preserves music and does not block unrelated resources`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'mizar-music-migration-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const bytes = musicWav();
    const id = `${createHash('sha256').update(bytes).digest('hex')}.wav`;
    const seed = new MusicStore(join(root, 'music'));
    await seed.load();
    seed.state.config.groups.technical.tracks.push({
      id,
      entryId: randomUUID(),
      name: 'Preserved technical cue',
      startMs: 20,
      endMs: 100,
      gain: 0.7,
    });
    const original = structuredClone(seed.state.config);
    await writeFile(join(root, 'music', 'state.json'), JSON.stringify(seed.state));
    const trackPath = join(root, 'music', 'tracks', id);
    if (damage === 'corrupt') await writeFile(trackPath, 'damaged');
    let current = await start(root);
    t.after(() => current.app.close());
    const assertAvailable = async () => {
      assert.equal(current.runtime.ready, true);
      for (const url of [
        '/local/v1/broadcast-presets',
        '/local/v1/broadcast-modules',
        '/local/v1/broadcast-display-config',
      ])
        assert.equal((await current.app.inject({ url, headers })).statusCode, 200);
      for (const kind of ['hud', 'program', 'camera'] as const)
        assert.equal(current.runtime.store.consumerStatus[kind]?.error, null);
    };
    await assertAvailable();
    assert.equal(current.runtime.store.appliedSnapshot('music'), null);
    assert.equal(current.runtime.store.consumerStatus.music?.error, 'dependency_unavailable');
    assert.deepEqual(current.music.state.config, original);
    assert.equal(current.music.state.bgm, null);
    assert.equal(current.music.state.stinger, null);
    const music = current.runtime.store.snapshot.modules.find((item) => item.kind === 'music')!;
    assert.equal(music.kind, 'music');
    if (music.kind !== 'music') throw new Error('missing music');
    assert.equal(music.value.groups.technical.tracks[0]?.asset.fileId, id);
    assert.equal(music.value.groups.technical.tracks[0]?.gain, 0.7);
    assert.deepEqual(
      JSON.parse(await readFile(join(root, 'music', 'state.json'), 'utf8')).config,
      original,
    );
    assert(
      current.runtime.store.referencedResources().some((ref) => ref.id === `local:music:${id}`),
    );

    // A second launch while the asset is still unavailable must retain the desired module.
    await current.app.close();
    current = await start(root);
    await assertAvailable();
    assert.equal(current.runtime.store.consumerStatus.music?.error, 'dependency_unavailable');
    assert.deepEqual(
      current.runtime.store.snapshot.modules.find((item) => item.id === music.id),
      music,
    );

    const hud = current.runtime.store.snapshot.modules.find((item) => item.kind === 'hud')!;
    const copy = await current.app.inject({
      method: 'POST',
      url: '/operator/broadcast-modules/clone',
      headers,
      payload: { moduleId: hud.id, expectedRevision: hud.revision, name: 'Independent HUD draft' },
    });
    assert.equal(copy.statusCode, 200, copy.body);
    const savedHud = copy.json<{ id: string; revision: string }>();
    const useHud = await current.app.inject({
      method: 'POST',
      url: '/operator/broadcast-modules/apply',
      headers,
      payload: {
        moduleId: savedHud.id,
        expectedRevision: savedHud.revision,
        expectedActiveRevision: current.runtime.store.snapshot.active.revision,
        requestId: randomUUID(),
      },
    });
    assert.equal(useHud.statusCode, 200, useHud.body);

    const upload = (payload: Buffer, origin = headers.origin, repair = true) =>
      current.app.inject({
        method: 'POST',
        url: repair ? '/operator/music/track/repair' : '/operator/music/track',
        headers: {
          ...headers,
          origin,
          'content-type': 'application/x-mizar-audio',
          'x-mizar-filename': 'cue.wav',
        },
        payload,
      });
    assert.equal((await upload(bytes, 'http://untrusted.invalid')).statusCode, 403);
    assert.equal((await upload(Buffer.from('not audio'))).statusCode, 400);
    if (damage === 'corrupt') {
      // Ordinary upload cannot overwrite damaged bytes; only explicit asset repair can.
      assert.equal((await upload(bytes, headers.origin, false)).statusCode, 400);
      assert.equal(await readFile(trackPath, 'utf8'), 'damaged');
      await writeFile(`${trackPath}.damaged-interrupted`, 'partial backup');
    }
    const restored = await upload(bytes);
    assert.equal(restored.statusCode, 200, restored.body);
    assert.equal(restored.json<{ id: string }>().id, id);
    assert.deepEqual(await readFile(trackPath), bytes);
    if (damage === 'corrupt') {
      const backups = (await readdir(join(root, 'music', 'tracks'))).filter(
        (name) => name.startsWith(`${id}.damaged-`) && !name.endsWith('interrupted'),
      );
      assert.equal(backups.length, 1);
      assert.equal(await readFile(`${trackPath}.damaged-interrupted`, 'utf8'), 'partial backup');
      assert.equal(await readFile(join(root, 'music', 'tracks', backups[0]!), 'utf8'), 'damaged');
      assert.equal((await upload(bytes)).statusCode, 200);
    }
    assert.equal(current.runtime.store.consumerStatus.music?.error, 'dependency_unavailable');
    assert.equal(current.runtime.store.appliedSnapshot('music'), null);
    const synchronize = t.mock.method(current.music, 'synchronizeFromPersistence');
    const payload = {
      moduleId: music.id,
      expectedRevision: music.revision,
      expectedActiveRevision: current.runtime.store.snapshot.active.revision,
      requestId: randomUUID(),
    };
    const applied = await Promise.all(
      [0, 1].map(() =>
        current.app.inject({
          method: 'POST',
          url: '/operator/broadcast-modules/apply',
          headers,
          payload,
        }),
      ),
    );
    for (const response of applied) assert.equal(response.statusCode, 200, response.body);
    assert.equal(synchronize.mock.callCount(), 1);
    assert.equal(current.runtime.store.consumerStatus.music?.error, null);
    assert.equal(current.music.failure, false);
    assert.deepEqual(current.music.state.config, original);
    assert.equal(current.runtime.store.snapshot.active.sourceModuleIds?.hud, savedHud.id);
    await current.app.close();
    current = await start(root);
    await assertAvailable();
    assert.equal(current.runtime.store.consumerStatus.music?.error, null);
    assert.deepEqual(current.music.state.config, original);
    assert.equal(current.runtime.store.snapshot.active.sourceModuleIds?.hud, savedHud.id);
  });

test('explicit audio repair preserves bytes when backup, identity or ownership is unsafe', async (t) => {
  for (const failure of ['backup', 'changed', 'hardlink'] as const) {
    await t.test(failure, async () => {
      const root = await mkdtemp(join(tmpdir(), 'mizar-music-repair-'));
      try {
        const bytes = musicWav();
        const id = `${createHash('sha256').update(bytes).digest('hex')}.wav`;
        const target = join(root, 'tracks', id);
        const store = new MusicStore(root, (stage, evidence) => {
          if (
            failure === 'changed' &&
            stage === 'music_commit_track' &&
            (evidence as { result: string }).result === 'begin'
          )
            writeFileSync(target, 'newer external bytes');
        });
        await store.load();
        await writeFile(target, 'damaged');
        if (failure === 'backup') await chmod(join(root, 'tracks'), 0o500);
        if (failure === 'hardlink') await link(target, join(root, 'other-owner'));
        await assert.rejects(store.installTrackAsset('original.wav', bytes, true));
        assert.equal(
          await readFile(target, 'utf8'),
          failure === 'changed' ? 'newer external bytes' : 'damaged',
        );
        if (failure === 'changed') {
          const backup = (await readdir(join(root, 'tracks'))).find((name) =>
            name.startsWith(`${id}.damaged-`),
          )!;
          assert.equal(await readFile(join(root, 'tracks', backup), 'utf8'), 'damaged');
        }
        if (failure === 'hardlink')
          assert.equal(await readFile(join(root, 'other-owner'), 'utf8'), 'damaged');
      } finally {
        await chmod(join(root, 'tracks'), 0o700).catch(() => undefined);
        await rm(root, { recursive: true, force: true });
      }
    });
  }
});

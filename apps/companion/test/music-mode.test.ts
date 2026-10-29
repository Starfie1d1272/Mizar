import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { MusicDirector } from '../src/music/director.js';
import { MusicStore } from '../src/music/store.js';
import {
  AudioMigration,
  type MigrationEvent,
  type MigrationObserver,
} from '../src/obs/audio-migration.js';
import { OBS_COLLECTION, obsDesiredScenes } from '../src/obs/desired-state.js';
import type { ObsRpc } from '../src/obs/reconcile.js';

test('music preference and external monitor changes take precedence over old mode backup', async () => {
  for (const action of ['user-off', 'external'] as const) {
    const dir = await mkdtemp(join(tmpdir(), 'mizar-music-mode-'));
    try {
      const store = new MusicStore(join(dir, 'music'));
      await store.load();
      await store.update((state) => {
        state.sources = { bgm: 'bgm', stinger: 'stinger' };
        state.monitorPreference = true;
      });
      const listeners = new Set<(event: MigrationEvent) => void>();
      const observer: MigrationObserver = {
        subscribe(listener) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      };
      const modes: Record<string, string> = {
        bgm: 'OBS_MONITORING_TYPE_MONITOR_AND_OUTPUT',
        stinger: 'OBS_MONITORING_TYPE_MONITOR_AND_OUTPUT',
      };
      const inputs = [
        { inputUuid: 'bgm', inputName: '音乐', inputKind: 'ffmpeg_source' },
        { inputUuid: 'stinger', inputName: '音效', inputKind: 'ffmpeg_source' },
      ];
      const scenes = obsDesiredScenes('http://127.0.0.1');
      const obs: ObsRpc = {
        async call(type, data) {
          if (type === 'GetStreamStatus' || type === 'GetRecordStatus')
            return { outputActive: true };
          if (type === 'GetSceneCollectionList')
            return { currentSceneCollectionName: OBS_COLLECTION };
          if (type === 'GetInputList') return { inputs };
          if (type === 'GetSceneList')
            return { scenes: scenes.map(({ sceneName }) => ({ sceneName })) };
          if (type === 'GetSceneItemList')
            return {
              sceneItems: inputs.map((input, index) => ({
                sourceUuid: input.inputUuid,
                sourceName: input.inputName,
                sceneItemId: index + 1,
                sceneItemEnabled: true,
              })),
            };
          if (type === 'SetSceneItemTransform') return {};
          if (type === 'GetInputAudioMonitorType')
            return { monitorType: modes[data?.inputUuid as string] };
          if (type === 'SetInputAudioMonitorType') {
            const uuid = data?.inputUuid as string;
            modes[uuid] = data?.monitorType as string;
            for (const listener of listeners)
              listener({ type: 'monitor', inputUuid: uuid, monitorType: modes[uuid]! });
            return {};
          }
          throw new Error(`Unexpected request ${type}`);
        },
      };
      const provider = {
        session: <T>(run: (obs: ObsRpc, epoch: number) => Promise<T>) => run(obs, 1),
      };
      const director = new MusicDirector(
        store,
        provider as never,
        () => {
          throw new Error('unexpected truth');
        },
        Date.now,
        Math.random,
        async () => true,
        async () => 'same',
      );
      const migration = new AudioMigration(join(dir, 'migration'));
      const backup = join(dir, 'backup');
      const firstId = randomUUID();
      await director.prepareDesktopMix(obs, 'same', async (plan) => {
        await migration.migrate(
          obs,
          'endpoint',
          {
            endpoint: 'endpoint',
            collection: OBS_COLLECTION,
            desktop: [],
            independent: [],
            monitor: plan.changes,
          },
          observer,
          undefined,
          firstId,
        );
        await migration.saveModeBackup(backup, firstId);
        await director.commitDesktopMonitorOriginals(plan.musicBefore, plan.musicAfter, 'after');
        await migration.clearMode(firstId);
      });
      assert.deepEqual(modes, {
        bgm: 'OBS_MONITORING_TYPE_MONITOR_ONLY',
        stinger: 'OBS_MONITORING_TYPE_MONITOR_ONLY',
      });
      if (action === 'user-off') await director.monitor(false);
      else modes.bgm = 'OBS_MONITORING_TYPE_NONE';
      const reverseId = randomUUID();
      await director.prepareDesktopMix(
        obs,
        'independent',
        async (plan) => {
          assert.deepEqual(plan.managedMusicUuids.sort(), ['bgm', 'stinger']);
          assert.equal(
            await migration.restoreCompleted(
              obs,
              'endpoint',
              observer,
              backup,
              plan.changes,
              reverseId,
              [],
              plan.managedMusicUuids,
            ),
            true,
          );
          await director.commitDesktopMonitorOriginals(plan.musicBefore, plan.musicAfter, 'after');
        },
        await migration.completedMonitorApplied(backup),
      );
      assert.equal(modes.bgm, 'OBS_MONITORING_TYPE_NONE');
      assert.equal(
        modes.stinger,
        action === 'user-off'
          ? 'OBS_MONITORING_TYPE_NONE'
          : 'OBS_MONITORING_TYPE_MONITOR_AND_OUTPUT',
      );
      assert.equal(store.state.monitorPreference, action !== 'user-off');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

test('existing music recheck follows device relationship without replacing its original value', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mizar-music-rel-'));
  try {
    const store = new MusicStore(dir);
    await store.load();
    await store.update((state) => {
      state.sources.bgm = 'bgm';
      state.monitorConfigured.bgm = 'bgm';
      state.monitorPreference = true;
      state.desktopMonitorOriginal.bgm = {
        uuid: 'bgm',
        mode: 'OBS_MONITORING_TYPE_MONITOR_AND_OUTPUT',
        applied: 'OBS_MONITORING_TYPE_MONITOR_ONLY',
      };
    });
    let relation: 'same' | 'different' | 'unknown' = 'unknown';
    let mode = 'OBS_MONITORING_TYPE_MONITOR_ONLY';
    let writes = 0;
    const obs: ObsRpc = {
      async call(type, data) {
        if (type === 'GetSceneCollectionList')
          return { currentSceneCollectionName: OBS_COLLECTION };
        if (type === 'GetInputList')
          return { inputs: [{ inputUuid: 'bgm', inputName: '音乐', inputKind: 'ffmpeg_source' }] };
        if (type === 'GetInputAudioMonitorType') return { monitorType: mode };
        if (type === 'SetInputAudioMonitorType') {
          mode = data?.monitorType as string;
          writes++;
          return {};
        }
        throw new Error(`Unexpected request ${type}`);
      },
    };
    const director = new MusicDirector(
      store,
      {} as never,
      () => {
        throw new Error('unexpected truth');
      },
      Date.now,
      Math.random,
      async () => true,
      async () => relation,
    );
    const recheck = (
      director as unknown as {
        configureDefaultMonitor(obs: ObsRpc, valid: () => boolean, recheck: boolean): Promise<void>;
      }
    ).configureDefaultMonitor.bind(director);
    await recheck(obs, () => true, true);
    assert.equal(mode, 'OBS_MONITORING_TYPE_NONE');
    relation = 'different';
    await recheck(obs, () => true, true);
    assert.equal(mode, 'OBS_MONITORING_TYPE_MONITOR_AND_OUTPUT');
    assert.equal(
      store.state.desktopMonitorOriginal.bgm?.mode,
      'OBS_MONITORING_TYPE_MONITOR_AND_OUTPUT',
    );
    await recheck(obs, () => true, true);
    assert.equal(writes, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('unknown device keeps music direct while explicit monitor preference can be changed', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mizar-music-unknown-'));
  try {
    const store = new MusicStore(dir);
    await store.load();
    await store.update((state) => {
      state.sources = { bgm: 'bgm', stinger: 'stinger' };
    });
    const inputs = [
      { inputUuid: 'bgm', inputName: '音乐', inputKind: 'ffmpeg_source' },
      { inputUuid: 'stinger', inputName: '音效', inputKind: 'ffmpeg_source' },
    ];
    const scenes = obsDesiredScenes('http://127.0.0.1');
    const modes: Record<string, string> = {
      bgm: 'OBS_MONITORING_TYPE_MONITOR_AND_OUTPUT',
      stinger: 'OBS_MONITORING_TYPE_MONITOR_AND_OUTPUT',
    };
    const obs: ObsRpc = {
      async call(type, data) {
        if (type === 'GetSceneCollectionList')
          return { currentSceneCollectionName: OBS_COLLECTION };
        if (type === 'GetInputList') return { inputs };
        if (type === 'GetSceneList')
          return { scenes: scenes.map(({ sceneName }) => ({ sceneName })) };
        if (type === 'GetSceneItemList')
          return {
            sceneItems: inputs.map((input, index) => ({
              sourceUuid: input.inputUuid,
              sourceName: input.inputName,
              sceneItemId: index + 1,
            })),
          };
        if (type === 'SetSceneItemTransform') return {};
        if (type === 'GetInputAudioMonitorType')
          return { monitorType: modes[data?.inputUuid as string] };
        if (type === 'SetInputAudioMonitorType') {
          modes[data?.inputUuid as string] = data?.monitorType as string;
          return {};
        }
        throw new Error(`Unexpected request ${type}`);
      },
    };
    const provider = {
      session: <T>(run: (obs: ObsRpc, epoch: number) => Promise<T>) => run(obs, 1),
    };
    const director = new MusicDirector(
      store,
      provider as never,
      () => {
        throw new Error('unexpected truth');
      },
      Date.now,
      Math.random,
      async () => true,
      async () => 'unknown',
    );
    await director.monitor(true);
    assert.deepEqual(modes, {
      bgm: 'OBS_MONITORING_TYPE_NONE',
      stinger: 'OBS_MONITORING_TYPE_NONE',
    });
    assert.equal(store.state.monitorPreference, true);
    assert.equal(director.get().monitorPending, true);
    await director.monitor(false);
    assert.equal(store.state.monitorPreference, false);
    assert.equal(director.get().monitorPending, false);
    assert.deepEqual(modes, {
      bgm: 'OBS_MONITORING_TYPE_NONE',
      stinger: 'OBS_MONITORING_TYPE_NONE',
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

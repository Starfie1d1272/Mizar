import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  AudioMigration,
  type MigrationEvent,
  type MigrationObserver,
} from '../src/obs/audio-migration.js';
import { ObsAdapter } from '../src/obs/adapter.js';
import { OBS_COLLECTION, obsDesiredScenes } from '../src/obs/desired-state.js';
import { reconcileManagedAudio } from '../src/obs/managed-audio.js';
import type { ObsConfigStore } from '../src/obs/config.js';
import { ObsAudioRouting } from '../src/obs/audio-routing.js';
import { MusicDirector } from '../src/music/director.js';
import { MusicStore } from '../src/music/store.js';
import type { RemoteCommentary } from '../src/obs/remote-commentary.js';
import type { ObsRpc } from '../src/obs/reconcile.js';

function fixture(active = false) {
  const items = [
    { sceneItemId: 1, sourceUuid: 'old', sceneItemEnabled: true },
    { sceneItemId: 2, sourceUuid: 'new', sceneItemEnabled: false },
  ];
  const listeners = new Set<(event: MigrationEvent) => void>();
  let failAfterWrite = false;
  const settings = { capture_audio: true, window: 'unchanged' };
  const monitor = { mode: 'OBS_MONITORING_TYPE_MONITOR_AND_OUTPUT' };
  const observer: MigrationObserver = {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const obs: ObsRpc = {
    async call(type, data) {
      if (type === 'GetStreamStatus' || type === 'GetRecordStatus') return { outputActive: active };
      if (type === 'GetSceneCollectionList') return { currentSceneCollectionName: 'collection' };
      if (type === 'GetInputAudioMonitorType') return { monitorType: monitor.mode };
      if (type === 'SetInputAudioMonitorType') {
        monitor.mode = data?.monitorType as string;
        for (const listener of listeners)
          listener({ type: 'monitor', inputUuid: 'music', monitorType: monitor.mode });
        if (failAfterWrite) {
          failAfterWrite = false;
          throw new Error('receipt lost');
        }
        return {};
      }
      if (type === 'GetInputSettings')
        return { inputKind: 'game_capture', inputSettings: { ...settings } };
      if (type === 'SetInputSettings') {
        assert.equal(data?.overlay, true);
        Object.assign(settings, data?.inputSettings);
        for (const listener of listeners)
          listener({ type: 'inputSettings', inputUuid: 'video', settings: { ...settings } });
        if (failAfterWrite) {
          failAfterWrite = false;
          throw new Error('receipt lost');
        }
        return {};
      }
      if (type === 'GetSceneItemList') return { sceneItems: items.map((item) => ({ ...item })) };
      if (type === 'SetSceneItemEnabled') {
        const item = items.find((value) => value.sceneItemId === data?.sceneItemId)!;
        item.sceneItemEnabled = data?.sceneItemEnabled as boolean;
        for (const listener of listeners)
          listener({
            type: 'item',
            sceneName: 'scene',
            sceneItemId: item.sceneItemId,
            enabled: item.sceneItemEnabled,
          });
        if (failAfterWrite) {
          failAfterWrite = false;
          throw new Error('receipt lost');
        }
        return {};
      }
      throw new Error(`Unexpected request ${type}`);
    },
  };
  const plan = {
    endpoint: 'endpoint',
    collection: 'collection',
    desktop: [{ sceneName: 'scene', sceneItemId: 1, sourceUuid: 'old' }],
    independent: [{ sceneName: 'scene', sceneItemId: 2, sourceUuid: 'new' }],
  };
  return {
    items,
    settings,
    monitor,
    obs,
    observer,
    plan,
    failNextWrite: () => {
      failAfterWrite = true;
    },
    programChanged: () => {
      for (const listener of listeners) listener({ type: 'programChanged' });
    },
  };
}

async function withJournal(run: (path: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'mizar-audio-migration-'));
  try {
    await run(join(dir, 'journal.json'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('completed migration retains a reversible record', async () =>
  withJournal(async (path) => {
    const { items, obs, observer, plan } = fixture();
    const migration = new AudioMigration(path);
    await migration.migrate(obs, 'endpoint', plan, observer, `${path}.completed`);
    assert.deepEqual(
      items.map((item) => item.sceneItemEnabled),
      [false, true],
    );
    assert.equal(
      await migration.restoreCompleted(obs, 'endpoint', observer, `${path}.completed`),
      true,
    );
    assert.deepEqual(
      items.map((item) => item.sceneItemEnabled),
      [true, false],
    );
  }));

test('lost write receipt is read back and restored after restart', async () =>
  withJournal(async (path) => {
    const { items, obs, observer, plan, failNextWrite } = fixture();
    failNextWrite();
    await assert.rejects(
      new AudioMigration(path).migrate(obs, 'endpoint', plan, observer),
      /write_uncertain/,
    );
    assert.deepEqual(
      items.map((item) => item.sceneItemEnabled),
      [false, false],
    );
    await new AudioMigration(path).recover(obs, 'endpoint', observer);
    assert.deepEqual(
      items.map((item) => item.sceneItemEnabled),
      [true, false],
    );
    assert.equal(await new AudioMigration(path).pending(), null);
  }));

test('completed restore does not overwrite an externally changed field', async () =>
  withJournal(async (path) => {
    const { items, obs, observer, plan } = fixture();
    const migration = new AudioMigration(path);
    await migration.migrate(obs, 'endpoint', plan, observer, `${path}.completed`);
    items[0]!.sceneItemEnabled = true;
    await assert.rejects(
      migration.restoreCompleted(obs, 'endpoint', observer, `${path}.completed`),
      /external_change/,
    );
    assert.deepEqual(
      items.map((item) => item.sceneItemEnabled),
      [true, true],
    );
  }));

test('mode switch disables exclusive video audio and restores it without changing picture settings', async () =>
  withJournal(async (path) => {
    const listeners = new Set<(event: MigrationEvent) => void>();
    const observer: MigrationObserver = {
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };
    const scenes = obsDesiredScenes('http://127.0.0.1:1234');
    const inputs = [
      { inputUuid: 'game', inputName: 'game', inputKind: 'wasapi_process_output_capture' },
      { inputUuid: 'voice', inputName: 'voice', inputKind: 'wasapi_process_output_capture' },
      { inputUuid: 'mic', inputName: 'mic', inputKind: 'wasapi_input_capture' },
      { inputUuid: 'desktop', inputName: 'desktop', inputKind: 'wasapi_output_capture' },
      { inputUuid: 'video', inputName: 'video', inputKind: 'game_capture' },
    ];
    const items = new Map(
      scenes.map((scene) => [
        scene.sceneName,
        inputs.map((input, index) => ({
          sourceUuid: input.inputUuid,
          sourceName: input.inputName,
          sceneItemId: index + 1,
          sceneItemEnabled: input.inputUuid !== 'desktop',
        })),
      ]),
    );
    const settings: Record<string, unknown> = { capture_audio: true, window: 'keep-picture' };
    const music = { mode: 'OBS_MONITORING_TYPE_MONITOR_AND_OUTPUT' };
    const mic = { mode: 'OBS_MONITORING_TYPE_MONITOR_AND_OUTPUT' };
    const obs: ObsRpc = {
      async call(type, data) {
        if (type === 'GetStreamStatus' || type === 'GetRecordStatus') return { outputActive: true };
        if (type === 'GetSceneCollectionList')
          return { currentSceneCollectionName: OBS_COLLECTION };
        if (type === 'GetInputList') return { inputs };
        if (type === 'GetSpecialInputs') return {};
        if (type === 'GetSceneList')
          return { scenes: scenes.map(({ sceneName }) => ({ sceneName })) };
        if (type === 'GetSceneItemList')
          return { sceneItems: items.get(data?.sceneName as string)!.map((item) => ({ ...item })) };
        if (type === 'GetInputAudioMonitorType')
          return { monitorType: data?.inputUuid === 'mic' ? mic.mode : music.mode };
        if (type === 'SetInputAudioMonitorType') {
          const target = data?.inputUuid === 'mic' ? mic : music;
          target.mode = data?.monitorType as string;
          for (const listener of listeners)
            listener({
              type: 'monitor',
              inputUuid: data?.inputUuid as string,
              monitorType: target.mode,
            });
          return {};
        }
        if (type === 'GetInputSettings')
          return data?.inputUuid === 'video'
            ? { inputKind: 'game_capture', inputSettings: { ...settings } }
            : { inputSettings: { device_id: 'device' } };
        if (type === 'GetInputDefaultSettings')
          return { defaultInputSettings: { device_id: 'device' } };
        if (type === 'GetProfileParameter') return { parameterValue: 'device' };
        if (type === 'SetInputSettings') {
          assert.equal(data?.overlay, true);
          Object.assign(settings, data?.inputSettings);
          for (const listener of listeners)
            listener({ type: 'inputSettings', inputUuid: 'video', settings: { ...settings } });
          return {};
        }
        if (type === 'SetSceneItemEnabled') {
          const item = items
            .get(data?.sceneName as string)!
            .find((value) => value.sceneItemId === data?.sceneItemId)!;
          item.sceneItemEnabled = data?.sceneItemEnabled as boolean;
          for (const listener of listeners)
            listener({
              type: 'item',
              sceneName: data?.sceneName as string,
              sceneItemId: item.sceneItemId,
              enabled: item.sceneItemEnabled,
            });
          return {};
        }
        throw new Error(`Unexpected request ${type}`);
      },
    };
    const routing = {
      async modeRecoveryState() {
        return { revision: 'revision', desktop: null, transition: null, bindings: {} };
      },
      async switchMode(
        _obs: ObsRpc,
        _endpoint: string,
        _revision: string,
        mode: 'desktop' | 'independent',
        _selection: string | undefined,
        apply: (
          ids: Record<string, string>,
          desktop: string | undefined,
          verify: () => Promise<boolean>,
          begin: (
            before: { bgm: null; stinger: null },
            after: { bgm: null; stinger: null },
          ) => Promise<string>,
          commit: (id: string) => Promise<void>,
        ) => Promise<void>,
      ) {
        await apply(
          { game: 'game', remoteCommentary: 'voice', microphone: 'mic' },
          mode === 'desktop' ? 'desktop' : undefined,
          async () => true,
          async () => randomUUID(),
          async () => {},
        );
      },
    } as unknown as ObsAudioRouting;
    const adapter = new ObsAdapter(
      {} as ObsConfigStore,
      'http://127.0.0.1:1234',
      undefined,
      routing,
      { owner: {} as RemoteCommentary, journal: path },
    );
    Object.assign(adapter, {
      audioConfiguration: {
        run: (
          operation: (
            obs: ObsRpc,
            endpoint: string,
            observer: MigrationObserver,
          ) => Promise<unknown>,
        ) => operation(obs, 'endpoint', observer),
      },
    });
    const musicApi = {
      async prepareDesktopMix(
        _obs: ObsRpc,
        _same: boolean,
        apply: (plan: unknown) => Promise<void>,
      ) {
        const changes =
          music.mode === 'OBS_MONITORING_TYPE_MONITOR_AND_OUTPUT'
            ? [
                {
                  kind: 'monitor',
                  inputUuid: 'music',
                  before: 'OBS_MONITORING_TYPE_MONITOR_AND_OUTPUT',
                  applied: 'OBS_MONITORING_TYPE_MONITOR_ONLY',
                },
              ]
            : [];
        await apply({
          changes,
          musicBefore: { bgm: null, stinger: null },
          musicAfter: { bgm: null, stinger: null },
        });
      },
      async withAudioModeRecovery(run: () => Promise<void>) {
        await run();
      },
      async commitDesktopMonitorOriginals() {},
    } as unknown as MusicDirector;
    await adapter.switchAudioMode('revision', 'desktop', 'desktop-selection', musicApi);
    assert.equal(music.mode, 'OBS_MONITORING_TYPE_MONITOR_ONLY');
    assert.equal(mic.mode, 'OBS_MONITORING_TYPE_NONE');
    assert.deepEqual(settings, { capture_audio: false, window: 'keep-picture' });
    assert.ok(
      [...items.values()].every(
        (scene) => scene.find((item) => item.sourceUuid === 'video')!.sceneItemEnabled,
      ),
    );
    await adapter.switchAudioMode('revision', 'independent', undefined, musicApi);
    assert.deepEqual(settings, { capture_audio: true, window: 'keep-picture' });
    assert.equal(music.mode, 'OBS_MONITORING_TYPE_MONITOR_AND_OUTPUT');
    assert.equal(mic.mode, 'OBS_MONITORING_TYPE_MONITOR_AND_OUTPUT');
    assert.ok(
      [...items.values()].every(
        (scene) => scene.find((item) => item.sourceUuid === 'video')!.sceneItemEnabled,
      ),
    );
  }));

test('uncertain capture audio write is restored after restart', async () =>
  withJournal(async (path) => {
    const { items, settings, obs, observer, plan, failNextWrite } = fixture();
    failNextWrite();
    await assert.rejects(
      new AudioMigration(path).migrate(
        obs,
        'endpoint',
        {
          ...plan,
          captureAudio: [
            { inputUuid: 'video', inputKind: 'game_capture', before: true, applied: false },
          ],
        },
        observer,
      ),
      /write_uncertain/,
    );
    assert.equal(settings.capture_audio, false);
    await new AudioMigration(path).recover(obs, 'endpoint', observer);
    assert.deepEqual(settings, { capture_audio: true, window: 'unchanged' });
    assert.deepEqual(
      items.map((item) => item.sceneItemEnabled),
      [true, false],
    );
  }));

test('restore refuses externally changed capture audio', async () =>
  withJournal(async (path) => {
    const { settings, obs, observer, plan } = fixture();
    const migration = new AudioMigration(path);
    await migration.migrate(
      obs,
      'endpoint',
      {
        ...plan,
        captureAudio: [
          { inputUuid: 'video', inputKind: 'game_capture', before: true, applied: false },
        ],
      },
      observer,
      `${path}.completed`,
    );
    settings.capture_audio = true;
    await assert.rejects(
      migration.restoreCompleted(obs, 'endpoint', observer, `${path}.completed`),
      /external_change/,
    );
    assert.equal(settings.capture_audio, true);
  }));

test('music monitor is journalled with scene paths and restored on switch back', async () =>
  withJournal(async (path) => {
    const { monitor, obs, observer, plan } = fixture();
    const migration = new AudioMigration(path);
    await migration.migrate(
      obs,
      'endpoint',
      {
        ...plan,
        monitor: [
          {
            kind: 'monitor',
            inputUuid: 'music',
            before: 'OBS_MONITORING_TYPE_MONITOR_AND_OUTPUT',
            applied: 'OBS_MONITORING_TYPE_MONITOR_ONLY',
          },
        ],
      },
      observer,
      `${path}.completed`,
    );
    assert.equal(monitor.mode, 'OBS_MONITORING_TYPE_MONITOR_ONLY');
    await migration.restoreCompleted(obs, 'endpoint', observer, `${path}.completed`);
    assert.equal(monitor.mode, 'OBS_MONITORING_TYPE_MONITOR_AND_OUTPUT');
  }));

test('uncertain music monitor write is restored after restart', async () =>
  withJournal(async (path) => {
    const { monitor, obs, observer, plan, failNextWrite } = fixture();
    failNextWrite();
    await assert.rejects(
      new AudioMigration(path).migrate(
        obs,
        'endpoint',
        {
          ...plan,
          monitor: [
            {
              kind: 'monitor',
              inputUuid: 'music',
              before: 'OBS_MONITORING_TYPE_MONITOR_AND_OUTPUT',
              applied: 'OBS_MONITORING_TYPE_MONITOR_ONLY',
            },
          ],
        },
        observer,
      ),
      /write_uncertain/,
    );
    assert.equal(monitor.mode, 'OBS_MONITORING_TYPE_MONITOR_ONLY');
    await new AudioMigration(path).recover(obs, 'endpoint', observer);
    assert.equal(monitor.mode, 'OBS_MONITORING_TYPE_MONITOR_AND_OUTPUT');
  }));

test('restore refuses externally changed music monitor', async () =>
  withJournal(async (path) => {
    const { monitor, obs, observer, plan } = fixture();
    const migration = new AudioMigration(path);
    await migration.migrate(
      obs,
      'endpoint',
      {
        ...plan,
        monitor: [
          {
            kind: 'monitor',
            inputUuid: 'music',
            before: 'OBS_MONITORING_TYPE_MONITOR_AND_OUTPUT',
            applied: 'OBS_MONITORING_TYPE_MONITOR_ONLY',
          },
        ],
      },
      observer,
      `${path}.completed`,
    );
    monitor.mode = 'OBS_MONITORING_TYPE_NONE';
    await assert.rejects(
      migration.restoreCompleted(obs, 'endpoint', observer, `${path}.completed`),
      /external_change/,
    );
    assert.equal(monitor.mode, 'OBS_MONITORING_TYPE_NONE');
  }));

test('restart recovery refuses a third externally selected monitor mode', async () =>
  withJournal(async (path) => {
    const { monitor, obs, observer, plan, failNextWrite } = fixture();
    failNextWrite();
    await assert.rejects(
      new AudioMigration(path).migrate(
        obs,
        'endpoint',
        {
          ...plan,
          monitor: [
            {
              kind: 'monitor',
              inputUuid: 'music',
              before: 'OBS_MONITORING_TYPE_MONITOR_AND_OUTPUT',
              applied: 'OBS_MONITORING_TYPE_MONITOR_ONLY',
            },
          ],
        },
        observer,
      ),
      /write_uncertain/,
    );
    monitor.mode = 'OBS_MONITORING_TYPE_NONE';
    await assert.rejects(
      new AudioMigration(path).recover(obs, 'endpoint', observer),
      /external_change/,
    );
    assert.equal(monitor.mode, 'OBS_MONITORING_TYPE_NONE');
  }));

test('automatic desktop selection creates a disabled default source without commentary binding', async () =>
  withJournal(async (path) => {
    const revision = randomUUID();
    await writeFile(
      path,
      JSON.stringify({
        revision,
        desktop: null,
        transition: false,
        bindings: {
          game: null,
          remoteCommentary: null,
          microphone: {
            inputUuid: 'mic',
            inputKind: 'wasapi_input_capture',
            endpoint: 'endpoint',
            collection: OBS_COLLECTION,
          },
        },
      }),
    );
    const scenes = obsDesiredScenes('http://127.0.0.1');
    const inputs = [{ inputUuid: 'mic', inputName: 'mic', inputKind: 'wasapi_input_capture' }];
    const lists = new Map(
      scenes.map((scene) => [
        scene.sceneName,
        [{ sceneItemId: 1, sourceUuid: 'mic', sourceName: 'mic', sceneItemEnabled: true }],
      ]),
    );
    lists.get(scenes[0]!.sceneName)![0]!.sceneItemEnabled = false;
    let created = 0;
    const listeners = new Set<(event: MigrationEvent) => void>();
    const observer: MigrationObserver = {
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };
    const obs: ObsRpc = {
      async call(type, data) {
        if (type === 'GetStreamStatus' || type === 'GetRecordStatus')
          return { outputActive: false };
        if (type === 'GetSceneCollectionList')
          return { currentSceneCollectionName: OBS_COLLECTION };
        if (type === 'GetSpecialInputs') return {};
        if (type === 'GetVersion')
          return {
            availableRequests: [
              'GetInputList',
              'GetInputSettings',
              'GetSceneCollectionList',
              'GetSpecialInputs',
              'GetSceneList',
              'GetSceneItemList',
              'GetGroupSceneItemList',
            ],
          };
        if (type === 'GetInputList') return { inputs };
        if (type === 'GetSceneList')
          return { scenes: scenes.map(({ sceneName }) => ({ sceneName })) };
        if (type === 'GetSceneItemList')
          return { sceneItems: lists.get(data?.sceneName as string) };
        if (type === 'CreateSceneItem') {
          const list = lists.get(data?.sceneName as string)!;
          const input = inputs.find((value) => value.inputName === data?.sourceName)!;
          list.push({
            sceneItemId: 2,
            sourceUuid: input.inputUuid,
            sourceName: input.inputName,
            sceneItemEnabled: false,
          });
          return { sceneItemId: 2 };
        }
        if (type === 'SetSceneItemEnabled') {
          const item = lists
            .get(data?.sceneName as string)!
            .find((value) => value.sceneItemId === data?.sceneItemId)!;
          item.sceneItemEnabled = data?.sceneItemEnabled as boolean;
          for (const listener of listeners)
            listener({
              type: 'item',
              sceneName: data?.sceneName as string,
              sceneItemId: item.sceneItemId,
              enabled: item.sceneItemEnabled,
            });
          return {};
        }
        if (type === 'CreateInput') {
          assert.equal(data?.sceneItemEnabled, false);
          assert.deepEqual(data?.inputSettings, { device_id: 'default' });
          const input = {
            inputUuid: 'new-desktop',
            inputName: data?.inputName as string,
            inputKind: 'wasapi_output_capture',
          };
          inputs.push(input);
          lists.get(data?.sceneName as string)!.push({
            sceneItemId: 2,
            sourceUuid: input.inputUuid,
            sourceName: input.inputName,
            sceneItemEnabled: false,
          });
          created++;
          return { inputUuid: input.inputUuid };
        }
        throw new Error(`Unexpected request ${type}`);
      },
    };
    const routing = new ObsAudioRouting(path);
    await routing.switchMode(
      obs,
      'endpoint',
      revision,
      'desktop',
      undefined,
      async (ids, desktop, _verify, begin, commit) => {
        assert.equal(desktop, 'new-desktop');
        assert.equal(ids.microphone, 'mic');
        assert.equal(ids.remoteCommentary, undefined);
        const modeId = await begin({ bgm: null, stinger: null }, { bgm: null, stinger: null });
        await reconcileManagedAudio(
          obs,
          'endpoint',
          observer,
          `${path}.probe`,
          'http://127.0.0.1',
          ids,
          async () => true,
          desktop,
          undefined,
          [],
          modeId,
        );
        await commit(modeId);
      },
    );
    assert.ok(
      [...lists.values()].every(
        (list) => list.find((item) => item.sourceUuid === 'new-desktop')?.sceneItemEnabled,
      ),
    );
    assert.equal(lists.get(scenes[0]!.sceneName)![0]!.sceneItemEnabled, false);
    assert.ok(scenes.slice(1).every((scene) => lists.get(scene.sceneName)![0]!.sceneItemEnabled));
    assert.equal(created, 1);
    assert.equal((await routing.desktopBinding())?.inputUuid, 'new-desktop');
  }));

test('different managed desktop devices require selection before any write', async () =>
  withJournal(async (path) => {
    const revision = randomUUID();
    await writeFile(
      path,
      JSON.stringify({
        revision,
        desktop: null,
        transition: false,
        bindings: { game: null, remoteCommentary: null, microphone: null },
      }),
    );
    const scenes = obsDesiredScenes('http://127.0.0.1');
    const inputs = ['one', 'two'].map((name) => ({
      inputUuid: name,
      inputName: name,
      inputKind: 'wasapi_output_capture',
    }));
    const obs: ObsRpc = {
      async call(type, data) {
        if (type === 'GetStreamStatus' || type === 'GetRecordStatus')
          return { outputActive: false };
        if (type === 'GetSceneCollectionList')
          return { currentSceneCollectionName: OBS_COLLECTION };
        if (type === 'GetSpecialInputs') return {};
        if (type === 'GetVersion')
          return {
            availableRequests: [
              'GetInputList',
              'GetInputSettings',
              'GetSceneCollectionList',
              'GetSpecialInputs',
              'GetSceneList',
              'GetSceneItemList',
              'GetGroupSceneItemList',
            ],
          };
        if (type === 'GetInputList') return { inputs };
        if (type === 'GetInputSettings') return { inputSettings: { device_id: data?.inputUuid } };
        if (type === 'GetSceneList')
          return { scenes: scenes.map(({ sceneName }) => ({ sceneName })) };
        if (type === 'GetSceneItemList')
          return {
            sceneItems: inputs.map((input, index) => ({
              sceneItemId: index + 1,
              sourceUuid: input.inputUuid,
              sourceName: input.inputName,
              sceneItemEnabled: true,
            })),
          };
        throw new Error(`Unexpected write: ${type}`);
      },
    };
    const routing = new ObsAudioRouting(path);
    await assert.rejects(
      routing.switchMode(obs, 'endpoint', revision, 'desktop', undefined, async () => {
        throw new Error('unexpected apply');
      }),
      /audio_desktop_choice_required/,
    );
    assert.equal(await routing.modePending(), false);
  }));

test('mode recovery resolves persisted intent and completed journal without replaying writes', async () => {
  for (const stage of ['intent', 'applied', 'backup', 'music', 'committed', 'external'] as const) {
    await withJournal(async (path) => {
      const routingPath = `${path}.routing`;
      const revision = randomUUID();
      const scenes = obsDesiredScenes('http://127.0.0.1');
      const inputs = [
        { inputUuid: 'game', inputName: 'game', inputKind: 'wasapi_process_output_capture' },
        { inputUuid: 'voice', inputName: 'voice', inputKind: 'wasapi_process_output_capture' },
        { inputUuid: 'mic', inputName: 'mic', inputKind: 'wasapi_input_capture' },
        { inputUuid: 'desktop', inputName: 'desktop', inputKind: 'wasapi_output_capture' },
      ];
      const binding = (uuid: string) => ({
        ...inputs.find((input) => input.inputUuid === uuid)!,
        endpoint: 'endpoint',
        collection: OBS_COLLECTION,
      });
      const asBinding = (uuid: string) => {
        const value = binding(uuid);
        return {
          inputUuid: value.inputUuid,
          inputKind: value.inputKind,
          endpoint: value.endpoint,
          collection: value.collection,
        };
      };
      await writeFile(
        routingPath,
        JSON.stringify({
          revision,
          desktop: null,
          transition: false,
          bindings: {
            game: asBinding('game'),
            remoteCommentary: asBinding('voice'),
            microphone: asBinding('mic'),
          },
        }),
      );
      const lists = new Map(
        scenes.map((scene) => [
          scene.sceneName,
          inputs.map((input, index) => ({
            sourceUuid: input.inputUuid,
            sourceName: input.inputName,
            sceneItemId: index + 1,
            sceneItemEnabled: input.inputUuid !== 'desktop',
          })),
        ]),
      );
      const listeners = new Set<(event: MigrationEvent) => void>();
      const observer: MigrationObserver = {
        subscribe(listener) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      };
      let writes = 0;
      const obs: ObsRpc = {
        async call(type, data) {
          if (type === 'GetStreamStatus' || type === 'GetRecordStatus')
            return { outputActive: false };
          if (type === 'GetSceneCollectionList')
            return { currentSceneCollectionName: OBS_COLLECTION };
          if (type === 'GetSpecialInputs') return {};
          if (type === 'GetVersion')
            return {
              availableRequests: [
                'GetInputList',
                'GetInputSettings',
                'GetSceneCollectionList',
                'GetSpecialInputs',
                'GetSceneList',
                'GetSceneItemList',
                'GetGroupSceneItemList',
              ],
            };
          if (type === 'GetInputList') return { inputs };
          if (type === 'GetSceneList')
            return { scenes: scenes.map(({ sceneName }) => ({ sceneName })) };
          if (type === 'GetSceneItemList')
            return {
              sceneItems: lists.get(data?.sceneName as string)!.map((item) => ({ ...item })),
            };
          if (type === 'SetSceneItemEnabled') {
            const item = lists
              .get(data?.sceneName as string)!
              .find((entry) => entry.sceneItemId === data?.sceneItemId)!;
            item.sceneItemEnabled = data?.sceneItemEnabled as boolean;
            writes++;
            for (const listener of listeners)
              listener({
                type: 'item',
                sceneName: data?.sceneName as string,
                sceneItemId: item.sceneItemId,
                enabled: item.sceneItemEnabled,
              });
            return {};
          }
          throw new Error(`Unexpected request ${type}`);
        },
      };
      const before = { bgm: null, stinger: null };
      const after = {
        bgm: { uuid: 'music', mode: 'OBS_MONITORING_TYPE_MONITOR_AND_OUTPUT' as const },
        stinger: null,
      };
      let stored = structuredClone(before) as typeof before | typeof after;
      const routing = new ObsAudioRouting(routingPath);
      await assert.rejects(
        routing.switchMode(
          obs,
          'endpoint',
          revision,
          'desktop',
          undefined,
          async (_ids, _desktop, _verify, begin, commit) => {
            const modeId = await begin(before, after);
            if (stage !== 'intent') {
              const migration = new AudioMigration(`${path}.migration`);
              await migration.migrate(
                obs,
                'endpoint',
                {
                  endpoint: 'endpoint',
                  collection: OBS_COLLECTION,
                  desktop: scenes.flatMap(({ sceneName }) =>
                    [1, 2].map((sceneItemId) => ({
                      sceneName,
                      sceneItemId,
                      sourceUuid: sceneItemId === 1 ? 'game' : 'voice',
                    })),
                  ),
                  independent: scenes.map(({ sceneName }) => ({
                    sceneName,
                    sceneItemId: 4,
                    sourceUuid: 'desktop',
                  })),
                },
                observer,
                undefined,
                modeId,
              );
              if (stage === 'backup' || stage === 'music' || stage === 'committed')
                await migration.saveModeBackup(`${path}.migration-mode`, modeId);
              if (stage === 'music' || stage === 'committed') stored = structuredClone(after);
              if (stage === 'committed') await commit(modeId);
            }
            throw new Error('simulated process exit');
          },
        ),
        /simulated process exit/,
      );
      if (stage === 'external') lists.get(scenes[0]!.sceneName)![0]!.sceneItemEnabled = true;
      const writesBeforeRecovery = writes;
      const restarted = new ObsAudioRouting(routingPath);
      const adapter = new ObsAdapter(
        {} as ObsConfigStore,
        'http://127.0.0.1',
        undefined,
        restarted,
        { owner: {} as RemoteCommentary, journal: path },
      );
      Object.assign(adapter, {
        audioConfiguration: {
          run: (
            operation: (
              obs: ObsRpc,
              endpoint: string,
              observer: MigrationObserver,
            ) => Promise<unknown>,
          ) => operation(obs, 'endpoint', observer),
        },
      });
      const music = {
        async withAudioModeRecovery(run: () => Promise<void>) {
          await run();
        },
        async commitDesktopMonitorOriginals(
          _before: typeof before,
          _after: typeof after,
          side: 'before' | 'after',
        ) {
          stored = structuredClone(side === 'before' ? before : after);
        },
      } as unknown as MusicDirector;
      if (stage === 'external') {
        await assert.rejects(adapter.recoverAudioMode(music), /audio_migration_external_change/);
        assert.equal(await restarted.modePending(), true);
        assert.equal(writes, writesBeforeRecovery);
        return;
      }
      await adapter.recoverAudioMode(music);
      assert.equal(await restarted.modePending(), false, stage);
      assert.equal(Boolean(await restarted.desktopBinding()), stage !== 'intent', stage);
      assert.deepEqual(stored, stage === 'intent' ? before : after, stage);
      assert.equal(writes, writesBeforeRecovery, stage);
      assert.equal(await new AudioMigration(`${path}.migration`).pending(), null, stage);
    });
  }
});

test('interrupted switch back either restores desktop or commits independent mode', async () => {
  for (const stage of ['partial', 'complete'] as const)
    await withJournal(async (path) => {
      const routingPath = `${path}.routing`;
      const scenes = obsDesiredScenes('http://127.0.0.1');
      const inputs = [
        { inputUuid: 'game', inputName: 'game', inputKind: 'wasapi_process_output_capture' },
        { inputUuid: 'voice', inputName: 'voice', inputKind: 'wasapi_process_output_capture' },
        { inputUuid: 'mic', inputName: 'mic', inputKind: 'wasapi_input_capture' },
        { inputUuid: 'desktop', inputName: 'desktop', inputKind: 'wasapi_output_capture' },
      ];
      const binding = (uuid: string) => ({
        inputUuid: uuid,
        inputKind: inputs.find((input) => input.inputUuid === uuid)!.inputKind,
        endpoint: 'endpoint',
        collection: OBS_COLLECTION,
      });
      const lists = new Map(
        scenes.map((scene) => [
          scene.sceneName,
          inputs.map((input, index) => ({
            sourceUuid: input.inputUuid,
            sourceName: input.inputName,
            sceneItemId: index + 1,
            sceneItemEnabled: input.inputUuid !== 'desktop',
          })),
        ]),
      );
      const listeners = new Set<(event: MigrationEvent) => void>();
      const observer: MigrationObserver = {
        subscribe(listener) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      };
      let failAfter = 0;
      const obs: ObsRpc = {
        async call(type, data) {
          if (type === 'GetStreamStatus' || type === 'GetRecordStatus')
            return { outputActive: false };
          if (type === 'GetSceneCollectionList')
            return { currentSceneCollectionName: OBS_COLLECTION };
          if (type === 'GetVersion')
            return {
              availableRequests: [
                'GetInputList',
                'GetInputSettings',
                'GetSceneCollectionList',
                'GetSpecialInputs',
                'GetSceneList',
                'GetSceneItemList',
                'GetGroupSceneItemList',
              ],
            };
          if (type === 'GetSpecialInputs') return {};
          if (type === 'GetInputList') return { inputs };
          if (type === 'GetSceneList')
            return { scenes: scenes.map(({ sceneName }) => ({ sceneName })) };
          if (type === 'GetSceneItemList')
            return {
              sceneItems: lists.get(data?.sceneName as string)!.map((item) => ({ ...item })),
            };
          if (type === 'SetSceneItemEnabled') {
            const item = lists
              .get(data?.sceneName as string)!
              .find((entry) => entry.sceneItemId === data?.sceneItemId)!;
            item.sceneItemEnabled = data?.sceneItemEnabled as boolean;
            for (const listener of listeners)
              listener({
                type: 'item',
                sceneName: data?.sceneName as string,
                sceneItemId: item.sceneItemId,
                enabled: item.sceneItemEnabled,
              });
            if (failAfter && --failAfter === 0) throw new Error('receipt lost');
            return {};
          }
          throw new Error(`Unexpected request ${type}`);
        },
      };
      const migration = new AudioMigration(`${path}.migration`);
      const originalId = randomUUID();
      await migration.migrate(
        obs,
        'endpoint',
        {
          endpoint: 'endpoint',
          collection: OBS_COLLECTION,
          desktop: scenes.flatMap(({ sceneName }) =>
            [1, 2].map((sceneItemId) => ({
              sceneName,
              sceneItemId,
              sourceUuid: sceneItemId === 1 ? 'game' : 'voice',
            })),
          ),
          independent: scenes.map(({ sceneName }) => ({
            sceneName,
            sceneItemId: 4,
            sourceUuid: 'desktop',
          })),
        },
        observer,
        undefined,
        originalId,
      );
      await migration.saveModeBackup(`${path}.migration-mode`, originalId);
      await migration.clearMode(originalId);
      const revision = randomUUID();
      await writeFile(
        routingPath,
        JSON.stringify({
          revision,
          desktop: binding('desktop'),
          transition: false,
          bindings: {
            game: binding('game'),
            remoteCommentary: binding('voice'),
            microphone: binding('mic'),
          },
        }),
      );
      const before = {
        bgm: { uuid: 'music', mode: 'OBS_MONITORING_TYPE_MONITOR_AND_OUTPUT' as const },
        stinger: null,
      };
      const after = { bgm: null, stinger: null };
      let stored: typeof before | typeof after = structuredClone(before);
      const routing = new ObsAudioRouting(routingPath);
      await assert.rejects(
        routing.switchMode(
          obs,
          'endpoint',
          revision,
          'independent',
          undefined,
          async (_ids, _desktop, _verify, begin) => {
            const modeId = await begin(before, after);
            if (stage === 'partial') failAfter = 2;
            await migration.restoreCompleted(
              obs,
              'endpoint',
              observer,
              `${path}.migration-mode`,
              [],
              modeId,
            );
            throw new Error('simulated process exit');
          },
        ),
      );
      const restarted = new ObsAudioRouting(routingPath);
      const adapter = new ObsAdapter(
        {} as ObsConfigStore,
        'http://127.0.0.1',
        undefined,
        restarted,
        { owner: {} as RemoteCommentary, journal: path },
      );
      Object.assign(adapter, {
        audioConfiguration: {
          run: (
            operation: (
              obs: ObsRpc,
              endpoint: string,
              observer: MigrationObserver,
            ) => Promise<unknown>,
          ) => operation(obs, 'endpoint', observer),
        },
      });
      const music = {
        async withAudioModeRecovery(run: () => Promise<void>) {
          await run();
        },
        async commitDesktopMonitorOriginals(
          _before: typeof before,
          _after: typeof after,
          side: 'before' | 'after',
        ) {
          stored = structuredClone(side === 'before' ? before : after);
        },
      } as unknown as MusicDirector;
      await adapter.recoverAudioMode(music);
      assert.equal(await restarted.modePending(), false);
      assert.equal(Boolean(await restarted.desktopBinding()), stage === 'partial');
      assert.deepEqual(stored, stage === 'partial' ? before : after);
      for (const list of lists.values()) {
        assert.equal(
          list.find((entry) => entry.sourceUuid === 'desktop')!.sceneItemEnabled,
          stage === 'partial',
        );
        assert.equal(
          list.find((entry) => entry.sourceUuid === 'game')!.sceneItemEnabled,
          stage === 'complete',
        );
        assert.equal(
          list.find((entry) => entry.sourceUuid === 'voice')!.sceneItemEnabled,
          stage === 'complete',
        );
      }
      const { readFile } = await import('node:fs/promises');
      if (stage === 'partial') assert.ok(await readFile(`${path}.migration-mode`, 'utf8'));
      else await assert.rejects(readFile(`${path}.migration-mode`, 'utf8'), { code: 'ENOENT' });
    });
});

test('music metadata commits idempotently and refuses an external source change', async () =>
  withJournal(async (path) => {
    const store = new MusicStore(`${path}.music`);
    await store.load();
    await store.update((state) => {
      state.sources.bgm = 'music';
    });
    const director = new MusicDirector(store, {} as never, () => {
      throw new Error('unexpected truth');
    });
    const before = { bgm: null, stinger: null };
    const after = {
      bgm: { uuid: 'music', mode: 'OBS_MONITORING_TYPE_MONITOR_AND_OUTPUT' as const },
      stinger: null,
    };
    await director.commitDesktopMonitorOriginals(before, after, 'after');
    await director.commitDesktopMonitorOriginals(before, after, 'after');
    const restartedStore = new MusicStore(`${path}.music`);
    await restartedStore.load();
    assert.deepEqual(restartedStore.state.desktopMonitorOriginal, after);
    await store.update((state) => {
      state.sources.bgm = 'replacement';
    });
    await assert.rejects(
      director.commitDesktopMonitorOriginals(before, after, 'before'),
      /music_monitor_source_changed/,
    );
    assert.deepEqual(store.state.desktopMonitorOriginal, after);
  }));

test('exclusive nested audio is restored and a group shared with another scene is left untouched', async () => {
  for (const shared of [false, true])
    await withJournal(async (path) => {
      const scenes = obsDesiredScenes('http://127.0.0.1');
      const inputs = [
        { inputUuid: 'game', inputName: 'game', inputKind: 'wasapi_process_output_capture' },
        { inputUuid: 'voice', inputName: 'voice', inputKind: 'wasapi_process_output_capture' },
        { inputUuid: 'mic', inputName: 'mic', inputKind: 'wasapi_input_capture' },
        { inputUuid: 'desktop', inputName: 'desktop', inputKind: 'wasapi_output_capture' },
      ];
      const group = [
        { sourceUuid: 'game', sourceName: 'game', sceneItemId: 1, sceneItemEnabled: true },
      ];
      const roots = new Map(
        scenes.map(({ sceneName }) => [
          sceneName,
          [
            {
              sourceUuid: 'group',
              sourceName: 'group',
              sceneItemId: 10,
              sceneItemEnabled: true,
              isGroup: true,
            },
            ...inputs.slice(1).map((input, index) => ({
              sourceUuid: input.inputUuid,
              sourceName: input.inputName,
              sceneItemId: index + 2,
              sceneItemEnabled: input.inputUuid !== 'desktop',
              isGroup: false,
            })),
          ],
        ]),
      );
      if (shared)
        roots.set('other', [
          {
            sourceUuid: 'group',
            sourceName: 'group',
            sceneItemId: 10,
            sceneItemEnabled: true,
            isGroup: true,
          },
        ]);
      const listeners = new Set<(event: MigrationEvent) => void>();
      const observer: MigrationObserver = {
        subscribe(listener) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      };
      let writes = 0;
      const obs: ObsRpc = {
        async call(type, data) {
          if (type === 'GetStreamStatus' || type === 'GetRecordStatus')
            return { outputActive: false };
          if (type === 'GetSceneCollectionList')
            return { currentSceneCollectionName: OBS_COLLECTION };
          if (type === 'GetSpecialInputs') return {};
          if (type === 'GetInputList') return { inputs };
          if (type === 'GetSceneList')
            return { scenes: [...roots.keys()].map((sceneName) => ({ sceneName })) };
          if (type === 'GetSceneItemList')
            return {
              sceneItems: roots.get(data?.sceneName as string)!.map((item) => ({ ...item })),
            };
          if (type === 'GetGroupSceneItemList')
            return { sceneItems: group.map((item) => ({ ...item })) };
          if (type === 'SetSceneItemEnabled') {
            const items =
              data?.sceneName === 'group' ? group : roots.get(data?.sceneName as string)!;
            const item = items.find((entry) => entry.sceneItemId === data?.sceneItemId)!;
            item.sceneItemEnabled = data?.sceneItemEnabled as boolean;
            writes++;
            for (const listener of listeners)
              listener({
                type: 'item',
                sceneName: data?.sceneName as string,
                sceneItemId: item.sceneItemId,
                enabled: item.sceneItemEnabled,
              });
            return {};
          }
          throw new Error(`Unexpected request ${type}`);
        },
      };
      const run = () =>
        reconcileManagedAudio(
          obs,
          'endpoint',
          observer,
          path,
          'http://127.0.0.1',
          { game: 'game', remoteCommentary: 'voice', microphone: 'mic' },
          async () => true,
          'desktop',
          `${path}.completed`,
        );
      if (shared) {
        await assert.rejects(run(), /audio_nested_shared_path/);
        assert.equal(writes, 0);
        assert.equal(group[0]!.sceneItemEnabled, true);
      } else {
        await run();
        assert.equal(group[0]!.sceneItemEnabled, false);
        await new AudioMigration(`${path}.migration`).restoreCompleted(
          obs,
          'endpoint',
          observer,
          `${path}.completed`,
        );
        assert.equal(group[0]!.sceneItemEnabled, true);
      }
    });
});

test('matching global desktop is reused and extra global audio blocks before writes', async () => {
  for (const conflict of [false, true])
    await withJournal(async (path) => {
      const revision = randomUUID();
      await writeFile(
        path,
        JSON.stringify({
          revision,
          desktop: null,
          transition: false,
          bindings: {
            game: null,
            remoteCommentary: null,
            microphone: {
              inputUuid: 'mic',
              inputKind: 'wasapi_input_capture',
              endpoint: 'endpoint',
              collection: OBS_COLLECTION,
            },
          },
        }),
      );
      const scenes = obsDesiredScenes('http://127.0.0.1');
      const inputs = [
        { inputUuid: 'desk', inputName: 'global desktop', inputKind: 'wasapi_output_capture' },
        { inputUuid: 'mic', inputName: 'global mic', inputKind: 'wasapi_input_capture' },
        { inputUuid: 'game', inputName: 'game', inputKind: 'wasapi_process_output_capture' },
        { inputUuid: 'extra', inputName: 'extra', inputKind: 'wasapi_input_capture' },
      ];
      const lists = new Map(
        scenes.map(({ sceneName }) => [
          sceneName,
          [{ sourceUuid: 'game', sourceName: 'game', sceneItemId: 1, sceneItemEnabled: true }],
        ]),
      );
      const listeners = new Set<(event: MigrationEvent) => void>();
      const observer: MigrationObserver = {
        subscribe(listener) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      };
      let writes = 0;
      const obs: ObsRpc = {
        async call(type, data) {
          if (type === 'GetStreamStatus' || type === 'GetRecordStatus')
            return { outputActive: false };
          if (type === 'GetSceneCollectionList')
            return { currentSceneCollectionName: OBS_COLLECTION };
          if (type === 'GetSpecialInputs')
            return {
              desktop1: 'global desktop',
              mic1: 'global mic',
              ...(conflict ? { mic2: 'extra' } : {}),
            };
          if (type === 'GetVersion')
            return {
              availableRequests: [
                'GetInputList',
                'GetInputSettings',
                'GetSceneCollectionList',
                'GetSpecialInputs',
                'GetSceneList',
                'GetSceneItemList',
                'GetGroupSceneItemList',
              ],
            };
          if (type === 'GetInputList') return { inputs };
          if (type === 'GetSceneList')
            return { scenes: scenes.map(({ sceneName }) => ({ sceneName })) };
          if (type === 'GetSceneItemList')
            return {
              sceneItems: lists.get(data?.sceneName as string)!.map((item) => ({ ...item })),
            };
          if (type === 'SetSceneItemEnabled') {
            const item = lists.get(data?.sceneName as string)![0]!;
            item.sceneItemEnabled = data?.sceneItemEnabled as boolean;
            writes++;
            for (const listener of listeners)
              listener({
                type: 'item',
                sceneName: data?.sceneName as string,
                sceneItemId: item.sceneItemId,
                enabled: item.sceneItemEnabled,
              });
            return {};
          }
          throw new Error(`Unexpected request ${type}`);
        },
      };
      const routing = new ObsAudioRouting(path);
      const run = () =>
        routing.switchMode(
          obs,
          'endpoint',
          revision,
          'desktop',
          undefined,
          async (ids, desktop, verify, begin, commit) => {
            assert.equal(desktop, 'desk');
            assert.equal(ids.microphone, 'mic');
            const id = await begin({ bgm: null, stinger: null }, { bgm: null, stinger: null });
            await reconcileManagedAudio(
              obs,
              'endpoint',
              observer,
              `${path}.probe`,
              'http://127.0.0.1',
              ids,
              verify,
              desktop,
              undefined,
              [],
              id,
            );
            await commit(id);
          },
        );
      if (conflict) {
        await assert.rejects(run(), /audio_global_path_unresolved:extra/);
        assert.equal(writes, 0);
      } else {
        await run();
        assert.equal((await routing.desktopBinding())?.inputUuid, 'desk');
        assert.ok(
          [...lists.values()].every((list) => list.length === 1 && !list[0]!.sceneItemEnabled),
        );
      }
    });
});

test('unknown monitor device plans direct music output while retaining monitor preference', async () =>
  withJournal(async (path) => {
    const store = new MusicStore(`${path}.music`);
    await store.load();
    await store.update((state) => {
      state.sources.bgm = 'bgm';
      state.sources.stinger = 'stinger';
      state.monitorPreference = true;
    });
    const modes: Record<string, string> = {
      bgm: 'OBS_MONITORING_TYPE_MONITOR_AND_OUTPUT',
      stinger: 'OBS_MONITORING_TYPE_MONITOR_ONLY',
    };
    const obs: ObsRpc = {
      async call(type, data) {
        if (type === 'GetSceneCollectionList')
          return { currentSceneCollectionName: OBS_COLLECTION };
        if (type === 'GetInputList')
          return {
            inputs: [
              { inputUuid: 'bgm', inputName: '音乐', inputKind: 'ffmpeg_source' },
              { inputUuid: 'stinger', inputName: '音效', inputKind: 'ffmpeg_source' },
            ],
          };
        if (type === 'GetInputAudioMonitorType')
          return { monitorType: modes[data?.inputUuid as string] };
        throw new Error(`Unexpected write: ${type}`);
      },
    };
    const director = new MusicDirector(store, {} as never, () => {
      throw new Error('unexpected truth');
    });
    await director.prepareDesktopMix(obs, 'unknown', async (plan) => {
      assert.deepEqual(
        plan.changes.map((change) => change.applied),
        ['OBS_MONITORING_TYPE_NONE', 'OBS_MONITORING_TYPE_NONE'],
      );
      assert.equal(plan.musicAfter.bgm?.mode, 'OBS_MONITORING_TYPE_MONITOR_AND_OUTPUT');
      assert.equal(plan.musicAfter.stinger?.mode, 'OBS_MONITORING_TYPE_MONITOR_ONLY');
      await director.commitDesktopMonitorOriginals(plan.musicBefore, plan.musicAfter, 'after');
    });
    assert.equal(store.state.monitorPreference, true);
    modes.bgm = modes.stinger = 'OBS_MONITORING_TYPE_NONE';
    await director.prepareDesktopMix(obs, 'independent', async (plan) => {
      assert.deepEqual(
        plan.changes.map((change) => change.applied),
        ['OBS_MONITORING_TYPE_MONITOR_AND_OUTPUT', 'OBS_MONITORING_TYPE_MONITOR_ONLY'],
      );
      await director.commitDesktopMonitorOriginals(plan.musicBefore, plan.musicAfter, 'after');
    });
    assert.deepEqual(store.state.desktopMonitorOriginal, { bgm: null, stinger: null });
  }));

test('mode migration works during output while initialization remains protected', async () =>
  withJournal(async (path) => {
    const { items, obs, observer, plan } = fixture(true);
    await assert.rejects(
      new AudioMigration(path).migrate(obs, 'endpoint', plan, observer),
      /output_active/,
    );
    const modeId = randomUUID();
    const migration = new AudioMigration(path);
    await migration.migrate(obs, 'endpoint', plan, observer, undefined, modeId);
    assert.deepEqual(
      items.map((item) => item.sceneItemEnabled),
      [false, true],
    );
    assert.equal(await migration.inspectMode(obs, 'endpoint', observer, modeId), 'applied');
    await migration.recover(obs, 'endpoint', observer, true);
    assert.deepEqual(
      items.map((item) => item.sceneItemEnabled),
      [true, false],
    );
  }));

test('program scene change interrupts a mode migration and retains recovery', async () =>
  withJournal(async (path) => {
    const { items, obs, observer, plan, programChanged } = fixture(true);
    let switched = false;
    const changing: ObsRpc = {
      async call(type, data) {
        const result = await obs.call(type, data);
        if (type === 'SetSceneItemEnabled' && !switched) {
          switched = true;
          programChanged();
        }
        return result;
      },
    };
    const migration = new AudioMigration(path);
    await assert.rejects(
      migration.migrate(changing, 'endpoint', plan, observer, undefined, randomUUID()),
      /observation_lost|write_uncertain/,
    );
    assert.ok(await migration.pending());
    await new AudioMigration(path).recover(obs, 'endpoint', observer, true);
    assert.deepEqual(
      items.map((item) => item.sceneItemEnabled),
      [true, false],
    );
  }));

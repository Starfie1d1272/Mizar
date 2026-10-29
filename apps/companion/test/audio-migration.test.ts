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
import type { RemoteCommentary } from '../src/obs/remote-commentary.js';
import type { ObsRpc } from '../src/obs/reconcile.js';

function fixture() {
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
      if (type === 'GetStreamStatus' || type === 'GetRecordStatus') return { outputActive: false };
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
    const obs: ObsRpc = {
      async call(type, data) {
        if (type === 'GetStreamStatus' || type === 'GetRecordStatus')
          return { outputActive: false };
        if (type === 'GetSceneCollectionList')
          return { currentSceneCollectionName: OBS_COLLECTION };
        if (type === 'GetInputList') return { inputs };
        if (type === 'GetSpecialInputs') return {};
        if (type === 'GetSceneList')
          return { scenes: scenes.map(({ sceneName }) => ({ sceneName })) };
        if (type === 'GetSceneItemList')
          return { sceneItems: items.get(data?.sceneName as string)!.map((item) => ({ ...item })) };
        if (type === 'GetInputAudioMonitorType') return { monitorType: music.mode };
        if (type === 'SetInputAudioMonitorType') {
          music.mode = data?.monitorType as string;
          for (const listener of listeners)
            listener({ type: 'monitor', inputUuid: 'music', monitorType: music.mode });
          return {};
        }
        if (type === 'GetInputSettings')
          return data?.inputUuid === 'video'
            ? { inputKind: 'game_capture', inputSettings: { ...settings } }
            : { inputSettings: { device_id: 'device' } };
        if (type === 'GetInputDefaultSettings')
          return { defaultInputSettings: { device_id: 'device' } };
        if (type === 'GetProfileParameter') return { parameterValue: 'another-device' };
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
        ) => Promise<void>,
      ) {
        await apply(
          { game: 'game', remoteCommentary: 'voice', microphone: 'mic' },
          mode === 'desktop' ? 'desktop' : undefined,
          async () => true,
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
    await adapter.switchAudioMode(
      'revision',
      'desktop',
      'desktop-selection',
      async (_obs, _same, apply) =>
        apply([
          {
            kind: 'monitor',
            inputUuid: 'music',
            before: 'OBS_MONITORING_TYPE_MONITOR_AND_OUTPUT',
            applied: 'OBS_MONITORING_TYPE_MONITOR_ONLY',
          },
        ]),
    );
    assert.equal(music.mode, 'OBS_MONITORING_TYPE_MONITOR_ONLY');
    assert.deepEqual(settings, { capture_audio: false, window: 'keep-picture' });
    assert.ok(
      [...items.values()].every(
        (scene) => scene.find((item) => item.sourceUuid === 'video')!.sceneItemEnabled,
      ),
    );
    await adapter.switchAudioMode(
      'revision',
      'independent',
      undefined,
      async (_obs, _same, apply) => apply([]),
    );
    assert.deepEqual(settings, { capture_audio: true, window: 'keep-picture' });
    assert.equal(music.mode, 'OBS_MONITORING_TYPE_MONITOR_AND_OUTPUT');
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
      async (ids, desktop) => {
        assert.equal(desktop, 'new-desktop');
        assert.equal(ids.microphone, 'mic');
        assert.equal(ids.remoteCommentary, undefined);
        await reconcileManagedAudio(
          obs,
          'endpoint',
          observer,
          `${path}.probe`,
          'http://127.0.0.1',
          ids,
          async () => true,
          desktop,
          `${path}.completed`,
        );
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

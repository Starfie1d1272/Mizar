import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ObsAdapter } from '../src/obs/adapter.js';
import {
  AudioMigration,
  type MigrationEvent,
  type MigrationObserver,
} from '../src/obs/audio-migration.js';
import { ObsAudioRouting } from '../src/obs/audio-routing.js';
import type { ObsConfigStore } from '../src/obs/config.js';
import { OBS_COLLECTION, obsDesiredScenes } from '../src/obs/desired-state.js';
import type { GameAudioController } from '../src/obs/audio-policy-controller.js';
import type { ObsRpc } from '../src/obs/reconcile.js';
import { RemoteCommentary } from '../src/obs/remote-commentary.js';
import type { MusicDirector } from '../src/music/director.js';

test('missing commentary waits without changing the live mix, then resumes or cancels', async () => {
  for (const action of ['resume', 'resume-no-mic', 'cancel', 'changed', 'disabled'] as const) {
    const dir = await mkdtemp(join(tmpdir(), 'mizar-wait-'));
    try {
      const path = join(dir, 'probe');
      const routingPath = join(dir, 'routing');
      const revision = randomUUID();
      const hasMic = action !== 'resume-no-mic';
      const scenes = obsDesiredScenes('http://127.0.0.1');
      const inputs = [
        { inputUuid: 'desktop', inputName: 'desktop', inputKind: 'wasapi_output_capture' },
        ...(hasMic
          ? [{ inputUuid: 'mic', inputName: 'mic', inputKind: 'wasapi_input_capture' }]
          : []),
      ];
      const lists = new Map(
        scenes.map(({ sceneName }) => [
          sceneName,
          [
            {
              sourceUuid: 'desktop',
              sourceName: 'desktop',
              sceneItemId: 1,
              sceneItemEnabled: false,
            },
            ...(hasMic
              ? [{ sourceUuid: 'mic', sourceName: 'mic', sceneItemId: 2, sceneItemEnabled: true }]
              : []),
          ],
        ]),
      );
      const settings = new Map<string, Record<string, unknown>>([
        ['desktop', { device_id: 'default' }],
        ['mic', { device_id: 'default' }],
      ]);
      const listeners = new Set<(event: MigrationEvent) => void>();
      const observer: MigrationObserver = {
        subscribe(listener) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      };
      let teamspeak = false;
      const obs: ObsRpc = {
        async call(type, data) {
          if (type === 'GetStreamStatus' || type === 'GetRecordStatus')
            return { outputActive: true };
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
                'CreateInput',
                'GetInputKindList',
                'GetInputPropertiesListPropertyItems',
              ],
            };
          if (type === 'GetInputKindList')
            return { inputKinds: ['wasapi_process_output_capture', 'wasapi_input_capture'] };
          if (type === 'GetInputList') return { inputs: inputs.map((input) => ({ ...input })) };
          if (type === 'GetSceneList')
            return { scenes: scenes.map(({ sceneName }) => ({ sceneName })) };
          if (type === 'GetSceneItemList')
            return {
              sceneItems: lists.get(data?.sceneName as string)!.map((item) => ({ ...item })),
            };
          if (type === 'GetInputSettings')
            return { inputSettings: { ...settings.get(data?.inputUuid as string) } };
          if (type === 'GetInputPropertiesListPropertyItems')
            return {
              propertyItems: teamspeak
                ? [
                    {
                      itemValue: 'TeamSpeak:Qt:teamspeak.exe',
                      itemName: 'TeamSpeak',
                      itemEnabled: true,
                    },
                  ]
                : [],
            };
          if (type === 'CreateInput') {
            const input = {
              inputUuid: randomUUID(),
              inputName: data?.inputName as string,
              inputKind: data?.inputKind as string,
            };
            inputs.push(input);
            settings.set(input.inputUuid, { ...(data?.inputSettings as object) });
            const list = lists.get(data?.sceneName as string)!;
            list.push({
              sourceUuid: input.inputUuid,
              sourceName: input.inputName,
              sceneItemId: list.length + 1,
              sceneItemEnabled: data?.sceneItemEnabled as boolean,
            });
            return { inputUuid: input.inputUuid };
          }
          if (type === 'CreateSceneItem') {
            const input = inputs.find((value) => value.inputName === data?.sourceName)!;
            const list = lists.get(data?.sceneName as string)!;
            list.push({
              sourceUuid: input.inputUuid,
              sourceName: input.inputName,
              sceneItemId: list.length + 1,
              sceneItemEnabled: data?.sceneItemEnabled as boolean,
            });
            return { sceneItemId: list.length };
          }
          if (type === 'SetInputSettings') {
            const uuid = data?.inputUuid as string;
            Object.assign(settings.get(uuid)!, data?.inputSettings);
            for (const listener of listeners)
              listener({
                type: 'inputSettings',
                inputUuid: uuid,
                settings: { ...settings.get(uuid)! },
              });
            return {};
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
          throw new Error(`Unexpected request ${type}`);
        },
      };
      const migration = new AudioMigration(`${path}.migration`);
      const modeId = randomUUID();
      await migration.migrate(
        obs,
        'endpoint',
        {
          endpoint: 'endpoint',
          collection: OBS_COLLECTION,
          desktop: [],
          independent: scenes.map(({ sceneName }) => ({
            sceneName,
            sceneItemId: 1,
            sourceUuid: 'desktop',
          })),
        },
        observer,
        undefined,
        modeId,
      );
      await migration.saveModeBackup(`${path}.migration-mode`, modeId);
      await migration.clearMode(modeId);
      const desktop = {
        inputUuid: 'desktop',
        inputKind: 'wasapi_output_capture',
        endpoint: 'endpoint',
        collection: OBS_COLLECTION,
      };
      const mic = {
        inputUuid: 'mic',
        inputKind: 'wasapi_input_capture',
        endpoint: 'endpoint',
        collection: OBS_COLLECTION,
      };
      await writeFile(
        routingPath,
        JSON.stringify({
          revision,
          desktop,
          desktopMicrophone: hasMic ? mic : null,
          transition: false,
          bindings: { game: null, remoteCommentary: null, microphone: hasMic ? mic : null },
        }),
      );
      const routing = new ObsAudioRouting(routingPath);
      const owner = new RemoteCommentary(join(dir, 'commentary'));
      const adapter = new ObsAdapter({} as ObsConfigStore, 'http://127.0.0.1', undefined, routing, {
        owner,
        journal: path,
      });
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
        store: { state: { monitorPreference: true } },
        async withAudioModeRecovery(run: () => Promise<void>) {
          await run();
        },
        monitorPlanCompatible() {
          return true;
        },
        async prepareDesktopMix(
          _obs: ObsRpc,
          _relation: string,
          apply: (plan: unknown) => Promise<void>,
        ) {
          await apply({
            changes: [],
            managedMusicUuids: [],
            musicBefore: { bgm: null, stinger: null },
            musicAfter: { bgm: null, stinger: null },
          });
        },
        async commitDesktopMonitorOriginals() {},
      } as unknown as MusicDirector;
      if (action === 'disabled')
        await owner.set({ mode: 'disabled' }, (await owner.get()).revision);
      const result = await adapter.requestIndependentMode(revision, music);
      if (action === 'disabled') {
        assert.equal(result.waiting, false);
        assert.equal(await routing.desktopBinding(), null);
        assert.equal((await routing.modeRecoveryState()).waitingIndependent, null);
        for (const list of lists.values())
          assert.equal(
            list.filter(
              (item) =>
                inputs.find((input) => input.inputUuid === item.sourceUuid)?.inputKind ===
                  'wasapi_process_output_capture' && item.sceneItemEnabled,
            ).length,
            1,
          );
        await adapter.close();
        continue;
      }
      assert.equal(result.waiting, true);
      assert.ok(
        [...lists.values()].every(
          (items) => items.find((item) => item.sourceUuid === 'desktop')!.sceneItemEnabled,
        ),
      );
      const pending = await routing.modeRecoveryState();
      assert.ok(pending.waitingIndependent);
      if (action === 'cancel')
        await adapter.switchAudioMode(pending.revision, 'desktop', undefined, music);
      if (action === 'changed') await owner.set({ mode: 'disabled' }, (await owner.get()).revision);
      teamspeak = true;
      const gameAudio = {
        async switchMode<T>(run: () => Promise<T>) {
          return run();
        },
      } as unknown as GameAudioController;
      adapter.startAudioModeRecovery(music, gameAudio);
      const deadline = Date.now() + 3000;
      while (
        action.startsWith('resume') &&
        (await routing.desktopBinding()) &&
        Date.now() < deadline
      )
        await new Promise((resolve) => setTimeout(resolve, 10));
      if (!action.startsWith('resume')) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        assert.ok(await routing.desktopBinding());
        assert.equal((await routing.modeRecoveryState()).waitingIndependent, null);
      } else {
        assert.equal(await routing.desktopBinding(), null);
        assert.equal((await routing.modeRecoveryState()).waitingIndependent, null);
        for (const items of lists.values()) {
          assert.equal(
            items.find((item) => item.sourceUuid === 'desktop')!.sceneItemEnabled,
            false,
          );
          assert.equal(
            items.find(
              (item) =>
                inputs.find((input) => input.inputUuid === item.sourceUuid)?.inputKind ===
                'wasapi_input_capture',
            )!.sceneItemEnabled,
            true,
          );
          assert.equal(
            items.filter(
              (item) =>
                inputs.find((input) => input.inputUuid === item.sourceUuid)?.inputKind ===
                  'wasapi_process_output_capture' && item.sceneItemEnabled,
            ).length,
            2,
          );
        }
      }
      await adapter.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { obsDesiredScenes } from '../src/obs/desired-state.js';
import { RemoteCommentary } from '../src/obs/remote-commentary.js';
import { prepareRemoteCommentary } from '../src/obs/remote-commentary-setup.js';
import type { ObsRpc } from '../src/obs/reconcile.js';

it('prepares a unique TS target once with disabled references in all scenes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'commentary-setup-'));
  try {
    const scenes = obsDesiredScenes('http://127.0.0.1:3000');
    const items = new Map(scenes.map((s) => [s.sceneName, [] as Record<string, unknown>[]]));
    const inputs: Record<string, unknown>[] = [];
    const settings: Record<string, unknown> = {};
    let running = false;
    const writes: { type: string; data: Record<string, unknown> | undefined }[] = [];
    const obs: ObsRpc = {
      call: async (type, data) => {
        await Promise.resolve();
        if (type === 'GetSceneCollectionList') return { currentSceneCollectionName: 'Mizar' };
        if (type === 'GetStreamStatus' || type === 'GetRecordStatus')
          return { outputActive: false };
        if (type === 'GetVersion')
          return {
            availableRequests: [
              'CreateInput',
              'GetInputKindList',
              'GetInputList',
              'GetInputSettings',
              'GetInputPropertiesListPropertyItems',
            ],
          };
        if (type === 'GetInputKindList') return { inputKinds: ['wasapi_process_output_capture'] };
        if (type === 'GetInputList') return { inputs };
        if (type === 'GetInputSettings') return { inputSettings: settings };
        if (type === 'GetInputPropertiesListPropertyItems')
          return {
            propertyItems: running
              ? [{ itemName: 'TS', itemValue: 'TeamSpeak:Qt:teamspeak.exe' }]
              : [],
          };
        if (type === 'GetSceneItemList')
          return { sceneItems: items.get(String(data?.sceneName)) ?? [] };
        if (type === 'CreateInput') {
          writes.push({ type, data });
          inputs.push({
            inputName: data?.inputName,
            inputUuid: 'owned',
            inputKind: 'wasapi_process_output_capture',
          });
          items
            .get(String(data?.sceneName))!
            .push({ sourceUuid: 'owned', sourceName: data?.inputName, sceneItemEnabled: false });
          return { inputUuid: 'owned' };
        }
        if (type === 'SetInputSettings') {
          writes.push({ type, data });
          Object.assign(settings, data?.inputSettings);
          return {};
        }
        if (type === 'CreateSceneItem') {
          writes.push({ type, data });
          items
            .get(String(data?.sceneName))!
            .push({ sourceUuid: 'owned', sceneItemEnabled: data?.sceneItemEnabled });
          return {};
        }
        throw new Error(type);
      },
    };
    const owner = new RemoteCommentary(join(dir, 'intent'));
    const run = () =>
      prepareRemoteCommentary(obs, owner, join(dir, 'journal'), 'local', 'http://127.0.0.1:3000');
    expect((await run())[0]?.message).toContain('等待 TeamSpeak');
    expect(
      [...items.values()].every((list) => list.length === 1 && list[0]?.sceneItemEnabled === false),
    ).toBe(true);
    running = true;
    expect((await run())[0]?.code).toBe('commentary_pending');
    expect((await run())[0]?.code).toBe('commentary_pending');
    expect(writes.filter((w) => w.type === 'CreateInput')).toHaveLength(1);
    expect(writes.filter((w) => w.type === 'SetInputSettings')).toHaveLength(1);
    expect(writes.filter((w) => w.type === 'CreateSceneItem')).toHaveLength(scenes.length - 1);
    expect(
      [...items.values()].every((list) => list.length === 1 && list[0]?.sceneItemEnabled === false),
    ).toBe(true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it('reuses a manually selected input and honors an enabled nested path without changing its settings', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'commentary-setup-'));
  try {
    const owner = new RemoteCommentary(join(dir, 'intent'));
    await owner.set(
      {
        mode: 'existingInput',
        binding: { endpoint: 'local', collection: 'Mizar', inputUuid: 'selected' },
      },
      (await owner.get()).revision,
    );
    const scenes = obsDesiredScenes('http://127.0.0.1:3000');
    const writes: string[] = [];
    const obs: ObsRpc = {
      call: async (type, data) => {
        await Promise.resolve();
        if (type === 'GetSceneCollectionList') return { currentSceneCollectionName: 'Mizar' };
        if (type === 'GetStreamStatus' || type === 'GetRecordStatus')
          return { outputActive: false };
        if (type === 'GetInputList')
          return {
            inputs: [
              { inputUuid: 'selected', inputName: 'Custom', inputKind: 'wasapi_output_capture' },
            ],
          };
        if (type === 'GetSceneItemList')
          return {
            sceneItems:
              data?.sceneName === scenes[0]!.sceneName
                ? [
                    {
                      sourceName: 'Nested',
                      sourceType: 'OBS_SOURCE_TYPE_SCENE',
                      sceneItemEnabled: true,
                    },
                  ]
                : data?.sceneName === 'Nested'
                  ? [{ sourceUuid: 'selected', sceneItemEnabled: true }]
                  : [],
          };
        if (type === 'CreateSceneItem') {
          writes.push(type);
          expect(data?.sceneItemEnabled).toBe(false);
          return {};
        }
        throw new Error(`unexpected ${type}`);
      },
    };
    await prepareRemoteCommentary(
      obs,
      owner,
      join(dir, 'journal'),
      'local',
      'http://127.0.0.1:3000',
    );
    expect(writes).toHaveLength(scenes.length - 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

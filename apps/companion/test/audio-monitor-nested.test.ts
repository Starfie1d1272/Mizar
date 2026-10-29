import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ObsAudioRouting } from '../src/obs/audio-routing.js';
import { OBS_COLLECTION, obsDesiredScenes } from '../src/obs/desired-state.js';
import type { ObsRpc } from '../src/obs/reconcile.js';

test('music monitoring checks enabled nested scene and group paths', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mizar-monitor-nested-'));
  try {
    const endpoint = 'ws://localhost:4455';
    const binding = (inputUuid: string, inputKind: string) => ({
      inputUuid,
      inputKind,
      endpoint,
      collection: OBS_COLLECTION,
    });
    const path = join(directory, 'routing.json');
    await writeFile(
      path,
      JSON.stringify({
        revision: randomUUID(),
        independentCommentaryDisabled: true,
        bindings: {
          game: binding('game', 'wasapi_process_output_capture'),
          microphone: binding('mic', 'wasapi_input_capture'),
          remoteCommentary: null,
        },
      }),
    );
    const scenes = obsDesiredScenes('http://127.0.0.1:3000');
    const item = (sourceUuid: string, sourceName: string, extra = {}) => ({
      sourceUuid,
      sourceName,
      sceneItemId: 1,
      sceneItemEnabled: true,
      ...extra,
    });
    const group = [item('picture', 'picture')];
    const nested = [item('group', 'group', { isGroup: true })];
    const roots = scenes.map(
      ({ sceneName }) =>
        [
          sceneName,
          [
            item('game', 'game'),
            item('mic', 'mic'),
            item('nested', 'nested', { sourceType: 'OBS_SOURCE_TYPE_SCENE' }),
          ],
        ] as const,
    );
    const inputs = [
      { inputUuid: 'game', inputName: 'game', inputKind: 'wasapi_process_output_capture' },
      { inputUuid: 'mic', inputName: 'mic', inputKind: 'wasapi_input_capture' },
      { inputUuid: 'picture', inputName: 'picture', inputKind: 'image_source' },
      { inputUuid: 'extra', inputName: 'extra', inputKind: 'wasapi_output_capture' },
    ];
    const obs = {
      call: async (type: string, data?: Record<string, unknown>) => {
        if (type === 'GetSceneCollectionList')
          return { currentSceneCollectionName: OBS_COLLECTION };
        if (type === 'GetSpecialInputs') return {};
        if (type === 'GetInputList') return { inputs };
        if (type === 'GetSceneList')
          return {
            scenes: [...scenes.map(({ sceneName }) => ({ sceneName })), { sceneName: 'nested' }],
          };
        if (type === 'GetSceneItemList')
          return {
            sceneItems:
              data?.sceneName === 'nested' ? nested : new Map(roots).get(String(data?.sceneName)),
          };
        if (type === 'GetGroupSceneItemList') return { sceneItems: group };
        throw new Error(type);
      },
    } as ObsRpc;
    const routing = new ObsAudioRouting(path);
    assert.equal(await routing.musicMonitorSafe(obs, endpoint), true);
    group.push(item('extra', 'extra'));
    assert.equal(await routing.musicMonitorSafe(obs, endpoint), false);
    group.pop();
    group.push(item('game', 'game'));
    assert.equal(await routing.musicMonitorSafe(obs, endpoint), true);
    group.pop();
    group.push(item('extra', 'extra', { sceneItemEnabled: false }));
    assert.equal(await routing.musicMonitorSafe(obs, endpoint), true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

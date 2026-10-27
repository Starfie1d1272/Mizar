import { expect, it } from 'vitest';
import { obsDesiredScenes } from '../src/obs/desired-state.js';
import { inspectLegacyAudioTemplate } from '../src/obs/audio-template.js';
import type { ObsRpc } from '../src/obs/reconcile.js';

it('accepts only the complete default template and rejects user changes', async () => {
  const scenes = obsDesiredScenes('http://127.0.0.1:3000');
  let custom = false;
  let global = false;
  let filter = false;
  let extraPath = false;
  const inputs = [
    {
      inputName: 'Mizar · Desktop Audio',
      inputKind: 'wasapi_output_capture',
      inputUuid: 'desktop',
    },
    { inputName: 'Mizar · Microphone', inputKind: 'wasapi_input_capture', inputUuid: 'mic' },
    { inputName: 'Mizar · CS2 Game Capture', inputKind: 'game_capture', inputUuid: 'game' },
    { inputName: 'voice', inputKind: 'wasapi_process_output_capture', inputUuid: 'voice' },
    ...scenes.map((scene) => ({
      inputName: scene.browserInput,
      inputKind: 'browser_source',
      inputUuid: scene.id,
    })),
  ];
  const obs: ObsRpc = {
    call: async (type, data) => {
      await Promise.resolve();
      if (type === 'GetSceneCollectionList') return { currentSceneCollectionName: 'Mizar' };
      if (type === 'GetSpecialInputs') return global ? { desktop1: 'global' } : {};
      if (type === 'GetInputList')
        return {
          inputs: custom
            ? [...inputs, { inputName: 'Custom', inputUuid: 'x', inputKind: 'ffmpeg_source' }]
            : inputs,
        };
      if (type === 'GetInputSettings') {
        const scene = scenes.find((x) => x.id === data?.inputUuid);
        return {
          inputSettings: scene
            ? { url: scene.browserUrl }
            : data?.inputUuid === 'game'
              ? { capture_audio: false }
              : { device_id: 'default' },
        };
      }
      if (type === 'GetInputMute') return { inputMuted: false };
      if (type === 'GetInputVolume') return { inputVolumeMul: 1 };
      if (type === 'GetInputAudioMonitorType') return { monitorType: 'OBS_MONITORING_TYPE_NONE' };
      if (type === 'GetInputAudioTracks')
        return {
          inputAudioTracks: Object.fromEntries([1, 2, 3, 4, 5, 6].map((x) => [String(x), true])),
        };
      if (type === 'GetSourceFilterList')
        return { filters: filter ? [{ filterName: 'custom' }] : [] };
      if (type === 'GetSceneList')
        return { scenes: scenes.map((scene) => ({ sceneName: scene.sceneName })) };
      if (type === 'GetSceneItemList')
        return {
          sceneItems: [
            ...scenes
              .find((scene) => scene.sceneName === data?.sceneName)!
              .sources.map((name) => ({
                sourceName: name,
                sourceUuid: inputs.find((input) => input.inputName === name)!.inputUuid,
                sceneItemEnabled: true,
              })),
            {
              sourceName: 'Mizar · Desktop Audio',
              sourceUuid: 'desktop',
              sceneItemId: 1,
              sceneItemEnabled: true,
            },
            {
              sourceName: 'Mizar · Microphone',
              sourceUuid: 'mic',
              sceneItemId: 2,
              sceneItemEnabled: true,
            },
            ...(extraPath
              ? [
                  {
                    sourceName: 'User',
                    sourceType: 'OBS_SOURCE_TYPE_SCENE',
                    sceneItemEnabled: true,
                  },
                ]
              : []),
          ],
        };
      throw new Error(type);
    },
  };
  expect(
    (await inspectLegacyAudioTemplate(obs, 'http://127.0.0.1:3000', 'voice'))?.desktop,
  ).toHaveLength(scenes.length);
  custom = true;
  expect(await inspectLegacyAudioTemplate(obs, 'http://127.0.0.1:3000', 'voice')).toBeNull();
  custom = false;
  global = true;
  expect(await inspectLegacyAudioTemplate(obs, 'http://127.0.0.1:3000', 'voice')).toBeNull();
  global = false;
  filter = true;
  expect(await inspectLegacyAudioTemplate(obs, 'http://127.0.0.1:3000', 'voice')).toBeNull();
  filter = false;
  extraPath = true;
  expect(await inspectLegacyAudioTemplate(obs, 'http://127.0.0.1:3000', 'voice')).toBeNull();
});

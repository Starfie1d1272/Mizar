import { expect, it } from 'vitest';
import {
  checkObsAudio,
  ensureManagedAudioSources,
  syncManagedMicrophoneAcrossScenes,
} from '../src/obs/audio.js';
import { OBS_COLLECTION, obsDesiredScenes } from '../src/obs/desired-state.js';
import type { ObsRpc } from '../src/obs/reconcile.js';

function createManagedSceneRig(initial: {
  collection?: string;
  activeScene?: string;
  micEnabledByScene?: Record<string, boolean>;
  includePersonalScene?: boolean;
}) {
  const desired = obsDesiredScenes('http://127.0.0.1:3000');
  const micUuid = 'mic-uuid-1';
  const desktopUuid = 'desktop-uuid-1';
  const state = {
    collection: initial.collection ?? OBS_COLLECTION,
    activeScene: initial.activeScene ?? '比赛中',
    sceneItems: new Map<
      string,
      { sceneItemId: number; sourceUuid: string; sourceName: string; sceneItemEnabled: boolean }[]
    >(),
  };
  for (const scene of desired) {
    state.sceneItems.set(scene.sceneName, [
      { sceneItemId: 1, sourceUuid: desktopUuid, sourceName: '桌面声音', sceneItemEnabled: true },
      {
        sceneItemId: 6,
        sourceUuid: micUuid,
        sourceName: '麦克风',
        sceneItemEnabled: initial.micEnabledByScene?.[scene.sceneName] ?? false,
      },
      {
        sceneItemId: 7,
        sourceUuid: 'game-capture-uuid',
        sourceName: '游戏画面',
        sceneItemEnabled: true,
      },
    ]);
  }
  if (initial.includePersonalScene) {
    state.sceneItems.set('个人场景', [
      {
        sceneItemId: 10,
        sourceUuid: 'personal-mic-uuid',
        sourceName: '个人麦',
        sceneItemEnabled: false,
      },
    ]);
  }
  const setCalls: { sceneName: string; sceneItemId: number; sceneItemEnabled: boolean }[] = [];
  const otherWrites: string[] = [];
  const rpc: ObsRpc = {
    managedInputIdentity: async (name) =>
      name === '麦克风' ? { uuid: micUuid, kind: 'wasapi_input_capture' } : null,
    call: async (type, data) => {
      if (type === 'GetSceneCollectionList')
        return {
          currentSceneCollectionName: state.collection,
          sceneCollections: [OBS_COLLECTION, '个人'],
        };
      if (type === 'GetCurrentProgramScene') return { currentProgramSceneName: state.activeScene };
      if (type === 'GetInputList')
        return {
          inputs: [
            { inputName: '桌面声音', inputKind: 'wasapi_output_capture', inputUuid: desktopUuid },
            { inputName: '麦克风', inputKind: 'wasapi_input_capture', inputUuid: micUuid },
          ],
        };
      if (type === 'GetSceneItemList')
        return { sceneItems: state.sceneItems.get(String(data?.sceneName)) ?? [] };
      if (type === 'SetSceneItemEnabled') {
        const sceneName = String(data?.sceneName);
        const sceneItemId = Number(data?.sceneItemId);
        const sceneItemEnabled = Boolean(data?.sceneItemEnabled);
        setCalls.push({ sceneName, sceneItemId, sceneItemEnabled });
        const found = state.sceneItems.get(sceneName)?.find((i) => i.sceneItemId === sceneItemId);
        if (found) found.sceneItemEnabled = sceneItemEnabled;
        return {};
      }
      if (/^(Set|Create|Remove)/.test(type)) otherWrites.push(type);
      return {};
    },
  };
  return { desired, micUuid, state, setCalls, otherWrites, rpc };
}

it('propagates microphone enable/disable across all managed scenes without touching non-managed targets', async () => {
  const rig = createManagedSceneRig({
    activeScene: '比赛中',
    micEnabledByScene: { 比赛中: true },
    includePersonalScene: true,
  });
  await syncManagedMicrophoneAcrossScenes(rig.rpc, 'http://127.0.0.1:3000', {
    sceneName: '比赛中',
    sceneItemId: 6,
    enabled: true,
  });
  for (const scene of rig.desired) {
    expect(
      rig.state.sceneItems.get(scene.sceneName)!.find((i) => i.sourceUuid === rig.micUuid)!
        .sceneItemEnabled,
    ).toBe(true);
  }
  expect(rig.state.sceneItems.get('个人场景')![0]!.sceneItemEnabled).toBe(false);
  expect(rig.otherWrites).toEqual([]);

  // Echo event matching already-converged state performs zero writes.
  const writesAfterConverge = rig.setCalls.length;
  await syncManagedMicrophoneAcrossScenes(rig.rpc, 'http://127.0.0.1:3000', {
    sceneName: '赛前等待',
    sceneItemId: 6,
    enabled: true,
  });
  expect(rig.setCalls.length).toBe(writesAfterConverge);

  rig.state.sceneItems.get('图间')!.find((i) => i.sourceUuid === rig.micUuid)!.sceneItemEnabled =
    false;
  await syncManagedMicrophoneAcrossScenes(rig.rpc, 'http://127.0.0.1:3000', {
    sceneName: '图间',
    sceneItemId: 6,
    enabled: false,
  });
  for (const scene of rig.desired) {
    expect(
      rig.state.sceneItems.get(scene.sceneName)!.find((i) => i.sourceUuid === rig.micUuid)!
        .sceneItemEnabled,
    ).toBe(false);
  }

  const callsBefore = rig.setCalls.length;
  await syncManagedMicrophoneAcrossScenes(rig.rpc, 'http://127.0.0.1:3000', {
    sceneName: '比赛中',
    sceneItemId: 7,
    enabled: false,
  });
  expect(rig.setCalls.length).toBe(callsBefore);

  rig.state.collection = '个人';
  await expect(
    syncManagedMicrophoneAcrossScenes(rig.rpc, 'http://127.0.0.1:3000', {
      sceneName: '比赛中',
      sceneItemId: 6,
      enabled: true,
    }),
  ).resolves.toBeNull();
  expect(rig.setCalls.length).toBe(callsBefore);
});

it('reconciles mismatched scenes toward active scene and preserves active scene choice in ensureManagedAudioSources', async () => {
  const rig = createManagedSceneRig({
    activeScene: '比赛中',
    micEnabledByScene: { 赛前等待: true, 比赛中: false },
  });
  await ensureManagedAudioSources(rig.rpc, 'http://127.0.0.1:3000', false);
  for (const scene of rig.desired) {
    expect(
      rig.state.sceneItems.get(scene.sceneName)!.find((i) => i.sourceUuid === rig.micUuid)!
        .sceneItemEnabled,
    ).toBe(false);
  }

  rig.state.activeScene = '对阵';
  rig.state.sceneItems.get('对阵')!.find((i) => i.sourceUuid === rig.micUuid)!.sceneItemEnabled =
    true;
  await syncManagedMicrophoneAcrossScenes(rig.rpc, 'http://127.0.0.1:3000');
  for (const scene of rig.desired) {
    expect(
      rig.state.sceneItems.get(scene.sceneName)!.find((i) => i.sourceUuid === rig.micUuid)!
        .sceneItemEnabled,
    ).toBe(true);
  }
});

it('returns structured scene_missing finding in checkObsAudio without probing missing scenes', async () => {
  const calls: string[] = [];
  const obs: ObsRpc = {
    call: async (type) => {
      calls.push(type);
      if (type === 'GetSpecialInputs') return {};
      if (type === 'GetSceneCollectionList') return { currentSceneCollectionName: OBS_COLLECTION };
      if (type === 'GetSceneList') return { scenes: [{ sceneName: '比赛中' }] };
      if (type === 'GetInputList') return { inputs: [] };
      if (type === 'GetSceneItemList') throw new Error('600 missing scene');
      return {};
    },
  };
  const findings = await checkObsAudio(obs);
  expect(findings.some((f) => f.code === 'scene_missing' && f.scene === '赛前等待')).toBe(true);
  expect(calls).not.toContain('GetSceneItemList');
});

it('rejects unreadable scene item responses instead of creating duplicate sources', async () => {
  const created: string[] = [];
  const rpc: ObsRpc = {
    call: async (type) => {
      if (type === 'GetSceneCollectionList') return { currentSceneCollectionName: OBS_COLLECTION };
      if (type === 'GetInputList')
        return {
          inputs: [
            {
              inputName: '桌面声音',
              inputKind: 'wasapi_output_capture',
              inputUuid: 'desktop-uuid',
            },
            { inputName: '麦克风', inputKind: 'wasapi_input_capture', inputUuid: 'mic-uuid' },
          ],
        };
      if (type === 'GetSceneItemList') return {};
      if (type === 'CreateSceneItem') {
        created.push('CreateSceneItem');
        return {};
      }
      return {};
    },
  };
  await expect(ensureManagedAudioSources(rpc, 'http://127.0.0.1:3000', false)).rejects.toThrow(
    'audio_response_unknown',
  );
  expect(created).toEqual([]);
});

import { ObsActionError } from './action-error.js';
import { OBS_COLLECTION, obsDesiredScenes } from './desired-state.js';
import type { ObsFinding, ObsRpc } from './reconcile.js';

type Input = { inputName: string; inputKind: string };
const AUDIO_KINDS = new Set([
  'wasapi_output_capture',
  'wasapi_input_capture',
  'wasapi_process_output_capture',
]);
const VIDEO_AUDIO_KINDS = new Set(['game_capture', 'window_capture']);
const MANAGED = [
  { name: '桌面声音', kind: 'wasapi_output_capture' },
  { name: '麦克风', kind: 'wasapi_input_capture' },
] as const;

async function activeManagedInputs(obs: ObsRpc, inputs: Input[]): Promise<Input[]> {
  const names = new Set<string>();
  for (const scene of obsDesiredScenes('http://127.0.0.1')) {
    const items = (await obs.call('GetSceneItemList', { sceneName: scene.sceneName }))
      .sceneItems as { sourceName: string; sceneItemEnabled: boolean }[];
    for (const item of items) if (item.sceneItemEnabled !== false) names.add(item.sourceName);
  }
  return inputs.filter((input) => names.has(input.inputName));
}

/** OBS global channels cannot be removed through WebSocket; muted, unmonitored ones are inert. */
export async function assertManagedGlobalAudioSilent(obs: ObsRpc): Promise<void> {
  const specials = await obs.call('GetSpecialInputs');
  const names = Object.values(specials).filter(
    (value): value is string => typeof value === 'string' && Boolean(value),
  );
  if (!names.length) return;
  const inputs = (await obs.call('GetInputList')).inputs as (Input & { inputUuid: string })[];
  for (const name of names) {
    const input = inputs.find((candidate) => candidate.inputName === name);
    if (!input?.inputUuid) throw new Error('audio_global_path_unresolved');
    const [mute, monitor] = await Promise.all([
      obs.call('GetInputMute', { inputUuid: input.inputUuid }),
      obs.call('GetInputAudioMonitorType', { inputUuid: input.inputUuid }),
    ]);
    if (mute.inputMuted !== true || monitor.monitorType !== 'OBS_MONITORING_TYPE_NONE')
      throw new Error('audio_global_path_unresolved');
  }
}

/** Structural readiness only. Audible content still needs an OBS/stream listening check. */
export async function checkObsAudio(obs: ObsRpc): Promise<ObsFinding[]> {
  await assertManagedGlobalAudioSilent(obs);
  const inputs = (await obs.call('GetInputList')).inputs as Input[];
  const active = await activeManagedInputs(obs, inputs);
  const candidates = active.filter((input) => AUDIO_KINDS.has(input.inputKind));
  for (const input of active.filter((item) => VIDEO_AUDIO_KINDS.has(item.inputKind))) {
    const settings = (await obs.call('GetInputSettings', { inputName: input.inputName }))
      .inputSettings as Record<string, unknown>;
    if (settings.capture_audio === true) candidates.push(input);
  }
  if (candidates.length === 0)
    return [
      {
        code: 'audio_missing',
        message:
          '当前 OBS 场景集合没有音频来源。停止输出后可配置默认桌面音频与麦克风，实际设备与音轨请在 OBS 中核对。',
      },
    ];
  const findings: ObsFinding[] = [];
  if (candidates.every((input) => input.inputKind === 'wasapi_input_capture'))
    findings.push({
      code: 'game_audio_missing',
      message: '仅检测到麦克风输入，未检测到系统或游戏音频来源，请在 OBS 中核对游戏声音。',
    });
  const scenes = obsDesiredScenes('http://127.0.0.1');
  for (const input of candidates) {
    const data = { inputName: input.inputName };
    const [mute, volume, tracks] = await Promise.all([
      obs.call('GetInputMute', data),
      obs.call('GetInputVolume', data),
      obs.call('GetInputAudioTracks', data),
    ]);
    if (mute.inputMuted === true || Number(volume.inputVolumeMul) === 0)
      findings.push({
        code: `audio_muted:${input.inputName}`,
        message: `${input.inputName} 已静音或音量为零，请检查 OBS 混音器。`,
      });
    if (
      !Object.values((tracks.inputAudioTracks ?? {}) as Record<string, unknown>).some(
        (enabled) => enabled === true,
      )
    )
      findings.push({
        code: `audio_tracks:${input.inputName}`,
        message: `${input.inputName} 未分配输出音轨。`,
      });
  }
  for (const scene of scenes) {
    const items = (await obs.call('GetSceneItemList', { sceneName: scene.sceneName }))
      .sceneItems as { sourceName: string; sceneItemEnabled: boolean }[];
    if (
      !candidates.some((input) =>
        items.some(
          (item) => item.sourceName === input.inputName && item.sceneItemEnabled !== false,
        ),
      )
    )
      findings.push({
        code: `audio_scene:${scene.id}`,
        scene: scene.sceneName,
        message: `${scene.sceneName} 没有启用的直接音频来源，请重新自动准备并检查 OBS 输出音轨。`,
      });
  }
  return findings;
}

/** Ensure the two default sources inside the dedicated, already normalized collection.
 * Existing source settings, filters and mixer choices are preserved.
 */
export async function ensureManagedAudioSources(
  obs: ObsRpc,
  baseUrl: string,
): Promise<{ desktop: string; microphone: string }> {
  if ((await obs.call('GetSceneCollectionList')).currentSceneCollectionName !== OBS_COLLECTION)
    throw new ObsActionError('collection_inactive');
  const ids: string[] = [];
  const scenes = obsDesiredScenes(baseUrl);
  for (const managed of MANAGED) {
    const inputs = (await obs.call('GetInputList')).inputs as (Input & { inputUuid: string })[];
    const existing = inputs.find((input) => input.inputName === managed.name);
    if (
      existing &&
      (managed.name === '桌面声音'
        ? existing.inputKind !== managed.kind
        : !AUDIO_KINDS.has(existing.inputKind))
    )
      throw new ObsActionError('audio_name_conflict');
    let uuid = existing?.inputUuid;
    if (!uuid) {
      const created = await obs.call('CreateInput', {
        sceneName: scenes[0]!.sceneName,
        inputName: managed.name,
        inputKind: managed.kind,
        inputSettings: { device_id: 'default' },
        sceneItemEnabled: false,
      });
      if (typeof created.inputUuid !== 'string') throw new Error('audio_source_creation_unknown');
      uuid = created.inputUuid;
    }
    ids.push(uuid);
    const sceneItems = await Promise.all(
      scenes.map(async (scene) => ({
        scene,
        items: (await obs.call('GetSceneItemList', { sceneName: scene.sceneName })).sceneItems as {
          sourceUuid: string;
          sceneItemEnabled: boolean;
        }[],
      })),
    );
    const microphoneEnabled =
      managed.name === '麦克风' &&
      sceneItems.some(({ items }) =>
        items.some((item) => item.sourceUuid === uuid && item.sceneItemEnabled),
      );
    for (const { scene, items } of sceneItems) {
      if (!items.some((item) => item.sourceUuid === uuid))
        await obs.call('CreateSceneItem', {
          sceneName: scene.sceneName,
          sourceName: managed.name,
          sceneItemEnabled: microphoneEnabled,
        });
    }
  }
  return { desktop: ids[0]!, microphone: ids[1]! };
}

/** Configure the default desktop/microphone paths in the dedicated collection. */
export async function setupObsAudio(obs: ObsRpc, baseUrl: string): Promise<void> {
  const [stream, record, collection] = await Promise.all([
    obs.call('GetStreamStatus'),
    obs.call('GetRecordStatus'),
    obs.call('GetSceneCollectionList'),
  ]);
  if (stream.outputActive !== false || record.outputActive !== false)
    throw new ObsActionError('output_active_audio');
  if (collection.currentSceneCollectionName !== OBS_COLLECTION)
    throw new ObsActionError('collection_inactive');
  const before = (await obs.call('GetInputList')).inputs as (Input & { inputUuid: string })[];
  const microphoneExisted = before.some(
    (input) => input.inputName === '麦克风' && input.inputKind === 'wasapi_input_capture',
  );
  const ids = await ensureManagedAudioSources(obs, baseUrl);
  for (const scene of obsDesiredScenes(baseUrl)) {
    const items = (await obs.call('GetSceneItemList', { sceneName: scene.sceneName }))
      .sceneItems as { sourceUuid: string; sceneItemId: number; sceneItemEnabled: boolean }[];
    for (const item of items)
      if (
        (item.sourceUuid === ids.desktop ||
          (item.sourceUuid === ids.microphone && !microphoneExisted)) &&
        !item.sceneItemEnabled
      )
        await obs.call('SetSceneItemEnabled', {
          sceneName: scene.sceneName,
          sceneItemId: item.sceneItemId,
          sceneItemEnabled: true,
        });
  }
}

export async function ensureObsAudio(obs: ObsRpc, baseUrl: string): Promise<ObsFinding[]> {
  const inputs = (await obs.call('GetInputList')).inputs as Input[];
  if (
    MANAGED.every((managed) =>
      inputs.some((input) => input.inputName === managed.name && input.inputKind === managed.kind),
    )
  ) {
    const complete = await Promise.all(
      obsDesiredScenes(baseUrl).map(async (scene) => {
        const items = (await obs.call('GetSceneItemList', { sceneName: scene.sceneName }))
          .sceneItems as { sourceName: string; sceneItemEnabled: boolean }[];
        return MANAGED.every((managed) =>
          items.some(
            (item) =>
              item.sourceName === managed.name &&
              (managed.name === '麦克风' || item.sceneItemEnabled),
          ),
        );
      }),
    );
    if (complete.every(Boolean)) return checkObsAudio(obs);
  }
  await setupObsAudio(obs, baseUrl);
  return checkObsAudio(obs);
}

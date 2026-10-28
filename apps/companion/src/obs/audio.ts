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
  { name: 'Mizar · Desktop Audio', kind: 'wasapi_output_capture' },
  { name: 'Mizar · Microphone', kind: 'wasapi_input_capture' },
] as const;

async function activeManagedInputs(obs: ObsRpc, inputs: Input[]): Promise<Input[]> {
  const names = new Set<string>();
  const specials = await obs.call('GetSpecialInputs');
  for (const value of Object.values(specials)) if (typeof value === 'string') names.add(value);
  for (const scene of obsDesiredScenes('http://127.0.0.1')) {
    const items = (await obs.call('GetSceneItemList', { sceneName: scene.sceneName }))
      .sceneItems as { sourceName: string; sceneItemEnabled: boolean }[];
    for (const item of items) if (item.sceneItemEnabled !== false) names.add(item.sourceName);
  }
  return inputs.filter((input) => names.has(input.inputName));
}

/** Structural readiness only. Audible content still needs an OBS/stream listening check. */
export async function checkObsAudio(obs: ObsRpc): Promise<ObsFinding[]> {
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
          '当前 OBS 场景集合没有音频来源。停止输出后会自动添加默认桌面音频与麦克风；未完成时可重试自动配置，实际设备与音轨请在 OBS 中核对。',
      },
    ];
  const findings: ObsFinding[] = [];
  if (candidates.every((input) => input.inputKind === 'wasapi_input_capture'))
    findings.push({
      code: 'game_audio_missing',
      message: '仅检测到麦克风输入，未检测到系统或游戏音频来源，请在 OBS 中核对游戏声音。',
    });
  const specials = await obs.call('GetSpecialInputs');
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
      !candidates.some(
        (input) =>
          Object.values(specials).includes(input.inputName) ||
          items.some(
            (item) => item.sourceName === input.inputName && item.sceneItemEnabled !== false,
          ),
      )
    )
      findings.push({
        code: `audio_scene:${scene.id}`,
        scene: scene.sceneName,
        message: `${scene.sceneName} 没有启用的直接音频来源；若使用嵌套场景，请在 OBS 检查混音器和输出音轨。`,
      });
  }
  return findings;
}

/** Stage defaults in Mizar scenes; custom paths stay audible until the migration commits. */
export async function setupObsAudio(obs: ObsRpc, baseUrl: string): Promise<void> {
  const [stream, record, collection] = await Promise.all([
    obs.call('GetStreamStatus'),
    obs.call('GetRecordStatus'),
    obs.call('GetSceneCollectionList'),
  ]);
  if (stream.outputActive || record.outputActive) throw new ObsActionError('output_active_audio');
  if (collection.currentSceneCollectionName !== OBS_COLLECTION)
    throw new ObsActionError('collection_inactive');
  const inputs = (await obs.call('GetInputList')).inputs as Input[];
  const active = await activeManagedInputs(obs, inputs);
  if (
    Object.values(await obs.call('GetSpecialInputs')).some(
      (value) => typeof value === 'string' && value,
    )
  )
    throw new ObsActionError('custom_audio');
  for (const input of active.filter((item) => VIDEO_AUDIO_KINDS.has(item.inputKind))) {
    const settings = (await obs.call('GetInputSettings', { inputName: input.inputName }))
      .inputSettings as Record<string, unknown>;
    if (settings.capture_audio === true) throw new ObsActionError('video_audio_active');
  }
  const custom = active.some(
    (input) =>
      AUDIO_KINDS.has(input.inputKind) && !MANAGED.some((item) => item.name === input.inputName),
  );
  for (const managed of MANAGED) {
    const existing = inputs.find((input) => input.inputName === managed.name);
    if (existing && existing.inputKind !== managed.kind)
      throw new ObsActionError('audio_name_conflict');
    let created = Boolean(existing);
    for (const scene of obsDesiredScenes(baseUrl)) {
      if (!created) {
        await obs.call('CreateInput', {
          sceneName: scene.sceneName,
          inputName: managed.name,
          inputKind: managed.kind,
          inputSettings: { device_id: 'default' },
          sceneItemEnabled: !custom,
        });
        created = true;
      } else {
        const items = (await obs.call('GetSceneItemList', { sceneName: scene.sceneName }))
          .sceneItems as { sourceName: string }[];
        if (!items.some((item) => item.sourceName === managed.name))
          await obs.call('CreateSceneItem', {
            sceneName: scene.sceneName,
            sourceName: managed.name,
            sceneItemEnabled: !custom,
          });
      }
    }
  }
}

/** Automatic preparation scopes changes to Mizar scenes and preserves shared source settings. */
export async function ensureObsAudio(obs: ObsRpc, baseUrl: string): Promise<ObsFinding[]> {
  const inputs = (await obs.call('GetInputList')).inputs as Input[];
  const active = await activeManagedInputs(obs, inputs);
  let gameAudio = false;
  for (const input of active.filter((item) => VIDEO_AUDIO_KINDS.has(item.inputKind))) {
    const settings = (await obs.call('GetInputSettings', { inputName: input.inputName }))
      .inputSettings as Record<string, unknown>;
    if (settings.capture_audio === true) gameAudio = true;
  }
  if (
    gameAudio ||
    Object.values(await obs.call('GetSpecialInputs')).some(
      (value) => typeof value === 'string' && value,
    )
  )
    return checkObsAudio(obs);
  if (
    MANAGED.some((managed) =>
      inputs.some((input) => input.inputName === managed.name && input.inputKind !== managed.kind),
    )
  )
    return [
      {
        code: 'audio_source_conflict',
        message: 'Mizar 默认音频来源名称已被其他类型占用，请在 OBS 重命名冲突来源后重试自动配置。',
      },
    ];
  await setupObsAudio(obs, baseUrl);
  return checkObsAudio(obs);
}

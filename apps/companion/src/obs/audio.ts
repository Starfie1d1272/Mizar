import { OBS_COLLECTION, obsDesiredScenes } from './desired-state.js';
import type { ObsFinding, ObsRpc } from './reconcile.js';

type Input = { inputName: string; inputKind: string };
const AUDIO_KINDS = new Set([
  'wasapi_output_capture',
  'wasapi_input_capture',
  'wasapi_process_output_capture',
]);
const MANAGED = [
  { name: 'Mizar · Desktop Audio', kind: 'wasapi_output_capture' },
  { name: 'Mizar · Microphone', kind: 'wasapi_input_capture' },
] as const;

/** Structural readiness only. Audible content still needs an OBS/stream listening check. */
export async function checkObsAudio(obs: ObsRpc): Promise<ObsFinding[]> {
  const inputs = (await obs.call('GetInputList')).inputs as Input[];
  const candidates = inputs.filter((input) => AUDIO_KINDS.has(input.inputKind));
  for (const input of inputs.filter((item) => item.inputKind === 'game_capture')) {
    const settings = (await obs.call('GetInputSettings', { inputName: input.inputName }))
      .inputSettings as Record<string, unknown>;
    if (settings.capture_audio === true) candidates.push(input);
  }
  if (candidates.length === 0)
    return [
      {
        code: 'audio_missing',
        message:
          '当前 OBS 场景集合没有游戏或麦克风音频来源。可点击“添加默认桌面音频与麦克风”，再检查混音器与直播音轨；使用自定义设备时请在 OBS 中添加音频来源。',
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

/** Explicit operator action; never enables capture as a side effect of scene repair. */
export async function setupObsAudio(obs: ObsRpc, baseUrl: string): Promise<void> {
  const [stream, record, collection] = await Promise.all([
    obs.call('GetStreamStatus'),
    obs.call('GetRecordStatus'),
    obs.call('GetSceneCollectionList'),
  ]);
  if (stream.outputActive || record.outputActive)
    throw new Error('OBS 正在输出；停止推流和录制后配置音频。');
  if (collection.currentSceneCollectionName !== OBS_COLLECTION)
    throw new Error('请先修复并切换到 Mizar 场景集合。');
  const inputs = (await obs.call('GetInputList')).inputs as Input[];
  for (const input of inputs.filter((item) => item.inputKind === 'game_capture')) {
    const settings = (await obs.call('GetInputSettings', { inputName: input.inputName }))
      .inputSettings as Record<string, unknown>;
    if (settings.capture_audio === true)
      throw new Error('游戏捕获已开启音频，请在 OBS 中配置麦克风，以免重复采集游戏声音。');
  }
  if (
    inputs.some(
      (input) =>
        AUDIO_KINDS.has(input.inputKind) && !MANAGED.some((item) => item.name === input.inputName),
    )
  )
    throw new Error('已有自定义音频来源，请在 OBS 中配置，以免重复采集。');
  for (const managed of MANAGED) {
    const existing = inputs.find((input) => input.inputName === managed.name);
    if (existing && existing.inputKind !== managed.kind)
      throw new Error('Mizar 音频来源名称冲突，请在 OBS 中核对。');
    let created = Boolean(existing);
    for (const scene of obsDesiredScenes(baseUrl)) {
      if (!created) {
        await obs.call('CreateInput', {
          sceneName: scene.sceneName,
          inputName: managed.name,
          inputKind: managed.kind,
          inputSettings: { device_id: 'default' },
          sceneItemEnabled: true,
        });
        created = true;
      } else {
        const items = (await obs.call('GetSceneItemList', { sceneName: scene.sceneName }))
          .sceneItems as { sourceName: string }[];
        if (!items.some((item) => item.sourceName === managed.name))
          await obs.call('CreateSceneItem', {
            sceneName: scene.sceneName,
            sourceName: managed.name,
            sceneItemEnabled: true,
          });
      }
    }
  }
}

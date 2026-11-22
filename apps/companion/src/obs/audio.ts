import { desktopMonitorRelationship } from './audio-monitor-device.js';
import { configuredStreamTracks } from './audio-stream-tracks.js';
import { ObsActionError } from './action-error.js';
import { OBS_COLLECTION, obsDesiredScenes } from './desired-state.js';
import type { ObsFinding, ObsRpc } from './reconcile.js';

export type ObsInputRow = { inputName: string; inputKind: string; inputUuid?: string };
export type SceneItemRow = {
  sourceName?: string;
  sourceUuid: string;
  sceneItemId: number;
  sceneItemEnabled: boolean;
};

export const AUDIO_KINDS = new Set([
  'wasapi_output_capture',
  'wasapi_input_capture',
  'wasapi_process_output_capture',
]);
const VIDEO_AUDIO_KINDS = new Set(['game_capture', 'window_capture']);
const MANAGED = [
  { name: '桌面声音', kind: 'wasapi_output_capture' },
  { name: '麦克风', kind: 'wasapi_input_capture' },
] as const;

export async function readDesiredSceneItems(
  obs: ObsRpc,
  baseUrl: string,
): Promise<{ scene: ReturnType<typeof obsDesiredScenes>[number]; items: SceneItemRow[] }[]> {
  return Promise.all(
    obsDesiredScenes(baseUrl).map(async (scene) => {
      const raw = (await obs.call('GetSceneItemList', { sceneName: scene.sceneName })).sceneItems;
      if (
        !Array.isArray(raw) ||
        raw.some((item) => !item || typeof item !== 'object' || Array.isArray(item))
      )
        throw new Error('audio_response_unknown');
      return { scene, items: raw as SceneItemRow[] };
    }),
  );
}

/** OBS global channels cannot be removed through WebSocket; muted, unmonitored ones are inert. */
export async function assertManagedGlobalAudioSilent(
  obs: ObsRpc,
  preloadedInputs?: ObsInputRow[],
): Promise<void> {
  const specials = await obs.call('GetSpecialInputs');
  const names = Object.values(specials).filter(
    (value): value is string => typeof value === 'string' && Boolean(value),
  );
  if (!names.length) return;
  const inputs = preloadedInputs ?? ((await obs.call('GetInputList')).inputs as ObsInputRow[]);
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
  const [collection, sceneList, inputList] = await Promise.all([
    obs.call('GetSceneCollectionList'),
    obs.call('GetSceneList'),
    obs.call('GetInputList'),
  ]);
  const inputs = inputList.inputs as ObsInputRow[];
  await assertManagedGlobalAudioSilent(obs, inputs);
  if (collection.currentSceneCollectionName !== OBS_COLLECTION)
    return [
      {
        code: 'collection_inactive',
        message: 'OBS 当前未使用「Mizar 制播」场景集合，停止直播和录像后选择「修复场景与音频」。',
      },
    ];
  const existingScenes = new Set(
    ((sceneList.scenes as { sceneName?: unknown }[] | undefined) ?? [])
      .map((item) => item.sceneName)
      .filter((name): name is string => typeof name === 'string'),
  );
  const missingScenes = obsDesiredScenes('http://127.0.0.1').filter(
    (scene) => !existingScenes.has(scene.sceneName),
  );
  if (missingScenes.length > 0)
    return missingScenes.map((scene) => ({
      code: 'scene_missing',
      scene: scene.sceneName,
      message: `OBS 缺少「${scene.sceneName}」场景，停止直播和录像后选择「修复场景与音频」。`,
    }));

  const perScene = await readDesiredSceneItems(obs, 'http://127.0.0.1');
  const activeNames = new Set<string>();
  for (const { items } of perScene)
    for (const item of items)
      if (item.sceneItemEnabled !== false && item.sourceName) activeNames.add(item.sourceName);
  const active = inputs.filter((input) => activeNames.has(input.inputName));
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
          'OBS 尚无节目音源。停止直播和录像后，选择「修复场景与音频」，再在 OBS 中核对设备和音轨。',
      },
    ];
  const findings: ObsFinding[] = [];
  const streamTracks = await configuredStreamTracks(obs).catch(() => null);
  if (streamTracks === null)
    findings.push({
      code: 'audio_stream_tracks_unknown',
      message: '无法确认 OBS 当前配置的直播音轨，请在 OBS 输出设置核对；未更改音轨。',
    });
  if (candidates.every((input) => input.inputKind === 'wasapi_input_capture'))
    findings.push({
      code: 'game_audio_missing',
      message: '仅检测到麦克风输入，未检测到系统或游戏音频来源，请在 OBS 中核对游戏声音。',
    });
  const music = active.filter(
    (input) => input.inputKind === 'ffmpeg_source' && ['音乐', '音效'].includes(input.inputName),
  );
  for (const input of [...candidates, ...music]) {
    const data = { inputName: input.inputName };
    const isMusic = input.inputKind === 'ffmpeg_source';
    const [mute, volume, tracks] = await Promise.all([
      isMusic ? Promise.resolve({ inputMuted: false }) : obs.call('GetInputMute', data),
      isMusic ? Promise.resolve({ inputVolumeMul: 1 }) : obs.call('GetInputVolume', data),
      obs.call('GetInputAudioTracks', data),
    ]);
    // Idle music is deliberately silent; only its eventual output path is checked.
    if (!isMusic && (mute.inputMuted === true || Number(volume.inputVolumeMul) === 0))
      findings.push({
        code: `audio_muted:${input.inputName}`,
        message: `${input.inputName} 已静音或音量为零，请检查 OBS 混音器。`,
      });
    if (isMusic) {
      const monitor = await obs.call('GetInputAudioMonitorType', data);
      if (monitor.monitorType === 'OBS_MONITORING_TYPE_MONITOR_ONLY') {
        // OBS <=32 reaches the program through desktop recapture, checked above.
        const desktop = candidates.find(
          (source) =>
            source.inputKind === 'wasapi_output_capture' && source.inputName === '桌面声音',
        );
        if (
          !desktop?.inputUuid ||
          (await desktopMonitorRelationship(obs, desktop.inputUuid).catch(() => 'unknown')) !==
            'same'
        )
          findings.push({
            code: `audio_monitor_path:${input.inputName}`,
            message: `${input.inputName} 仅监听但无法确认同设备桌面回采路径，请核对 OBS 监听与输出。`,
          });
        continue;
      }
    }
    const assigned = (tracks.inputAudioTracks ?? {}) as Record<string, unknown>;
    if (!Object.values(assigned).some((enabled) => enabled === true))
      findings.push({
        code: `audio_tracks:${input.inputName}`,
        message: `${input.inputName} 未分配输出音轨。`,
      });
    else if (
      streamTracks !== null &&
      !streamTracks.some((track) => assigned[String(track)] === true)
    )
      findings.push({
        code: `audio_stream_track_mismatch:${input.inputName}`,
        message: `${input.inputName} 未进入 OBS 配置的直播音轨，请在 OBS 高级音频属性与输出设置中核对。`,
      });
  }
  for (const { scene, items } of perScene) {
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
  initializeSources = false,
): Promise<{ desktop: string; microphone: string }> {
  if ((await obs.call('GetSceneCollectionList')).currentSceneCollectionName !== OBS_COLLECTION)
    throw new ObsActionError('collection_inactive');
  const inputs = (await obs.call('GetInputList')).inputs as (ObsInputRow & { inputUuid: string })[];
  const firstScene = obsDesiredScenes(baseUrl)[0]!.sceneName;
  const ids: Record<string, string> = {};
  let createdAny = false;
  for (const managed of MANAGED) {
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
        sceneName: firstScene,
        inputName: managed.name,
        inputKind: managed.kind,
        inputSettings: { device_id: 'default' },
        sceneItemEnabled: false,
      });
      if (typeof created.inputUuid !== 'string') throw new Error('audio_source_creation_unknown');
      uuid = created.inputUuid;
      createdAny = true;
    }
    ids[managed.name] = uuid;
  }
  const perScene = await readDesiredSceneItems(obs, baseUrl);
  const micUuid = ids['麦克风']!;
  const desktopUuid = ids['桌面声音']!;
  const microphoneEnabled =
    initializeSources ||
    (await resolveActiveMicrophoneEnabled(
      obs,
      micUuid,
      perScene.map(({ scene, items }) => ({ sceneName: scene.sceneName, items })),
    ));
  for (const { scene, items } of perScene) {
    for (const managed of MANAGED) {
      const uuid = ids[managed.name]!;
      const desiredEnabled = managed.name === '麦克风' ? microphoneEnabled : initializeSources;
      const existing = items.filter((item) => item.sourceUuid === uuid);
      if (existing.length === 0) {
        await obs.call('CreateSceneItem', {
          sceneName: scene.sceneName,
          sourceName: managed.name,
          sceneItemEnabled: desiredEnabled,
        });
      } else if (managed.name === '麦克风' || initializeSources) {
        for (const item of existing) {
          if (
            item.sceneItemEnabled !== desiredEnabled &&
            (managed.name === '麦克风' || !item.sceneItemEnabled)
          ) {
            await obs.call('SetSceneItemEnabled', {
              sceneName: scene.sceneName,
              sceneItemId: item.sceneItemId,
              sceneItemEnabled: desiredEnabled,
            });
          }
        }
      }
      if (
        managed.name === '麦克风' &&
        (createdAny ||
          existing.length !== 1 ||
          existing.some((item) => item.sceneItemEnabled !== microphoneEnabled))
      ) {
        const confirmed = (await obs.call('GetSceneItemList', { sceneName: scene.sceneName }))
          .sceneItems as SceneItemRow[];
        const refs = confirmed.filter((item) => item.sourceUuid === micUuid);
        if (refs.length !== 1 || refs[0]!.sceneItemEnabled !== microphoneEnabled)
          throw new Error('audio_microphone_enable_unconfirmed');
      }
    }
  }
  return { desktop: desktopUuid, microphone: micUuid };
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
  await ensureManagedAudioSources(obs, baseUrl, true);
}

async function resolveActiveMicrophoneEnabled(
  obs: ObsRpc,
  micUuid: string,
  perScene: readonly { sceneName: string; items: readonly SceneItemRow[] }[],
): Promise<boolean> {
  const activeScene = await obs
    .call('GetCurrentProgramScene')
    .then((result) =>
      typeof result.currentProgramSceneName === 'string'
        ? result.currentProgramSceneName
        : undefined,
    )
    .catch(() => undefined);
  const activeMatches = activeScene
    ? (perScene
        .find((entry) => entry.sceneName === activeScene)
        ?.items.filter((item) => item.sourceUuid === micUuid) ?? [])
    : [];
  return activeMatches.length
    ? activeMatches.some((item) => item.sceneItemEnabled !== false)
    : perScene.some(({ items }) =>
        items.some((item) => item.sourceUuid === micUuid && item.sceneItemEnabled !== false),
      );
}

/**
 * Keep the managed microphone's scene-item enabled intent consistent across all
 * managed program scenes inside the owned dedicated collection.
 */
export async function syncManagedMicrophoneAcrossScenes(
  obs: ObsRpc,
  baseUrl: string,
  target?: { sceneName: string; sceneItemId: number; enabled: boolean },
): Promise<boolean | null> {
  if ((await obs.call('GetSceneCollectionList')).currentSceneCollectionName !== OBS_COLLECTION)
    return null;
  const managedIdentity = obs.managedInputIdentity
    ? await obs.managedInputIdentity('麦克风')
    : undefined;
  const micUuid =
    managedIdentity !== undefined
      ? managedIdentity && AUDIO_KINDS.has(managedIdentity.kind)
        ? managedIdentity.uuid
        : undefined
      : ((await obs.call('GetInputList')).inputs as ObsInputRow[]).find(
          (candidate) => candidate.inputName === '麦克风' && AUDIO_KINDS.has(candidate.inputKind),
        )?.inputUuid;
  if (!micUuid) return null;

  const perScene = await readDesiredSceneItems(obs, baseUrl);
  let desiredEnabled: boolean;
  if (target) {
    const entry = perScene.find(({ scene }) => scene.sceneName === target.sceneName);
    const toggled = entry?.items.find((item) => item.sceneItemId === target.sceneItemId);
    if (!toggled || toggled.sourceUuid !== micUuid) return null;
    if ((toggled.sceneItemEnabled !== false) !== target.enabled) return null;
    desiredEnabled = target.enabled;
  } else {
    const states = new Set(
      perScene.flatMap(({ items }) =>
        items
          .filter((item) => item.sourceUuid === micUuid)
          .map((item) => item.sceneItemEnabled !== false),
      ),
    );
    if (states.size === 0) return null;
    if (states.size === 1) return [...states][0]!;
    desiredEnabled = await resolveActiveMicrophoneEnabled(
      obs,
      micUuid,
      perScene.map(({ scene, items }) => ({ sceneName: scene.sceneName, items })),
    );
  }

  for (const { scene, items } of perScene) {
    for (const item of items) {
      if (item.sourceUuid !== micUuid || (item.sceneItemEnabled !== false) === desiredEnabled)
        continue;
      await obs.call('SetSceneItemEnabled', {
        sceneName: scene.sceneName,
        sceneItemId: item.sceneItemId,
        sceneItemEnabled: desiredEnabled,
      });
    }
  }
  return desiredEnabled;
}

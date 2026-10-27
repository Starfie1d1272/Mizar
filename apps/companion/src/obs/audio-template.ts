import { OBS_CAPTURE_INPUT, OBS_COLLECTION, obsDesiredScenes } from './desired-state.js';
import type { ObsRpc } from './reconcile.js';

type Ref = { sceneName: string; sceneItemId: number; sourceUuid: string };
function objects(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) throw new Error('audio_template_unknown');
  return value.filter((x): x is Record<string, unknown> => typeof x === 'object' && x !== null);
}
/** Fail closed unless the entire legacy default mix and its direct scene references match. */
export async function inspectLegacyAudioTemplate(
  obs: ObsRpc,
  baseUrl: string,
  commentaryUuid: string,
): Promise<{ desktop: Ref[]; microphoneUuid: string } | null> {
  if ((await obs.call('GetSceneCollectionList')).currentSceneCollectionName !== OBS_COLLECTION)
    return null;
  const specials = await obs.call('GetSpecialInputs');
  if (Object.values(specials).some((x) => typeof x === 'string' && x.length > 0)) return null;
  const inputs = objects((await obs.call('GetInputList')).inputs);
  const desired = obsDesiredScenes(baseUrl);
  const allowedNames = new Set([
    OBS_CAPTURE_INPUT,
    ...desired.map((scene) => scene.browserInput),
    'Mizar · Desktop Audio',
    'Mizar · Microphone',
  ]);
  if (
    inputs.some(
      (input) =>
        input.inputUuid !== commentaryUuid &&
        (typeof input.inputName !== 'string' || !allowedNames.has(input.inputName)),
    )
  )
    return null;
  for (const scene of desired) {
    const input = inputs.find((value) => value.inputName === scene.browserInput);
    if (!input || input.inputKind !== 'browser_source' || typeof input.inputUuid !== 'string')
      return null;
    const response = await obs.call('GetInputSettings', { inputUuid: input.inputUuid });
    if (
      !response.inputSettings ||
      typeof response.inputSettings !== 'object' ||
      (response.inputSettings as Record<string, unknown>).url !== scene.browserUrl
    )
      return null;
  }
  if (
    !inputs.some(
      (input) =>
        input.inputName === OBS_CAPTURE_INPUT &&
        input.inputKind === 'game_capture' &&
        typeof input.inputUuid === 'string',
    )
  )
    return null;
  const desktop = inputs.find(
    (x) => x.inputName === 'Mizar · Desktop Audio' && x.inputKind === 'wasapi_output_capture',
  );
  const microphone = inputs.find(
    (x) => x.inputName === 'Mizar · Microphone' && x.inputKind === 'wasapi_input_capture',
  );
  if (
    typeof desktop?.inputUuid !== 'string' ||
    typeof microphone?.inputUuid !== 'string' ||
    desktop.inputUuid === microphone.inputUuid
  )
    return null;
  const audioKinds = new Set([
    'wasapi_output_capture',
    'wasapi_input_capture',
    'wasapi_process_output_capture',
  ]);
  if (
    inputs.some(
      (x) =>
        audioKinds.has(String(x.inputKind)) &&
        ![desktop.inputUuid, microphone.inputUuid, commentaryUuid].includes(String(x.inputUuid)),
    )
  )
    return null;
  for (const input of inputs.filter((x) =>
    ['game_capture', 'window_capture'].includes(String(x.inputKind)),
  )) {
    if (typeof input.inputUuid !== 'string') return null;
    const settings = (await obs.call('GetInputSettings', { inputUuid: input.inputUuid }))
      .inputSettings;
    if (
      !settings ||
      typeof settings !== 'object' ||
      (settings as Record<string, unknown>).capture_audio === true
    )
      return null;
  }
  for (const input of [desktop, microphone]) {
    const [settings, mute, volume, monitor, tracks, filters] = await Promise.all([
      obs.call('GetInputSettings', { inputUuid: input.inputUuid }),
      obs.call('GetInputMute', { inputUuid: input.inputUuid }),
      obs.call('GetInputVolume', { inputUuid: input.inputUuid }),
      obs.call('GetInputAudioMonitorType', { inputUuid: input.inputUuid }),
      obs.call('GetInputAudioTracks', { inputUuid: input.inputUuid }),
      obs.call('GetSourceFilterList', { sourceName: input.inputName }),
    ]);
    if (
      !settings.inputSettings ||
      typeof settings.inputSettings !== 'object' ||
      (settings.inputSettings as Record<string, unknown>).device_id !== 'default' ||
      mute.inputMuted !== false ||
      volume.inputVolumeMul !== 1 ||
      monitor.monitorType !== 'OBS_MONITORING_TYPE_NONE' ||
      !Array.isArray(filters.filters) ||
      filters.filters.length !== 0
    )
      return null;
    const track = tracks.inputAudioTracks;
    if (
      !track ||
      typeof track !== 'object' ||
      Object.keys(track).length !== 6 ||
      Object.values(track).some((v) => v !== true)
    )
      return null;
  }
  const wanted = new Set(desired.map((x) => x.sceneName));
  const allScenes = objects((await obs.call('GetSceneList')).scenes);
  const seen = new Set<string>();
  const refs: Ref[] = [];
  for (const scene of allScenes) {
    if (typeof scene.sceneName !== 'string') return null;
    const items = objects(
      (await obs.call('GetSceneItemList', { sceneName: scene.sceneName })).sceneItems,
    );
    // Nested paths make ownership and duplicate capture impossible to prove from the template.
    if (items.some((x) => x.isGroup === true || x.sourceType === 'OBS_SOURCE_TYPE_SCENE'))
      return null;
    if (
      wanted.has(scene.sceneName) &&
      items.some(
        (x) =>
          x.sourceUuid !== commentaryUuid &&
          (typeof x.sourceName !== 'string' || !allowedNames.has(x.sourceName)),
      )
    )
      return null;
    if (wanted.has(scene.sceneName)) {
      const desiredScene = desired.find((value) => value.sceneName === scene.sceneName)!;
      const expectedNames = new Set([
        ...desiredScene.sources,
        'Mizar · Desktop Audio',
        'Mizar · Microphone',
      ]);
      if (
        items.some(
          (value) =>
            value.sourceUuid !== commentaryUuid &&
            (typeof value.sourceName !== 'string' || !expectedNames.has(value.sourceName)),
        )
      )
        return null;
      for (const source of desiredScene.sources) {
        const matches = items.filter(
          (value) => value.sourceName === source && value.sceneItemEnabled === true,
        );
        const expected = inputs.find((value) => value.inputName === source);
        if (matches.length !== 1 || !expected || matches[0]!.sourceUuid !== expected.inputUuid)
          return null;
      }
    }
    const old = items.filter((x) => x.sourceUuid === desktop.inputUuid);
    const mic = items.filter((x) => x.sourceUuid === microphone.inputUuid);
    if (!wanted.has(scene.sceneName)) {
      if (old.length || mic.length) return null;
      continue;
    }
    if (
      seen.has(scene.sceneName) ||
      old.length !== 1 ||
      mic.length !== 1 ||
      old[0]!.sceneItemEnabled !== true ||
      mic[0]!.sceneItemEnabled !== true ||
      typeof old[0]!.sceneItemId !== 'number'
    )
      return null;
    seen.add(scene.sceneName);
    refs.push({
      sceneName: scene.sceneName,
      sceneItemId: old[0]!.sceneItemId,
      sourceUuid: desktop.inputUuid,
    });
  }
  if (seen.size !== wanted.size) return null;
  return { desktop: refs, microphoneUuid: microphone.inputUuid };
}

import {
  OBS_CAPTURE_INPUT,
  OBS_COLLECTION,
  OBS_HEIGHT,
  OBS_WIDTH,
  obsDesiredScenes,
} from './desired-state.js';
import { BP_COMPACT_INPUT, BP_COMPACT_PATH } from './bp-overlay.js';
import type { ObsRpc } from './reconcile.js';

type Ref = { sceneName: string; sceneItemId: number; sourceUuid: string };
function objects(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) throw new Error('audio_template_unknown');
  return value.filter((x): x is Record<string, unknown> => typeof x === 'object' && x !== null);
}
/** Inspect only direct Mizar scene paths; shared source device, gain and filters remain untouched. */
export async function inspectLegacyAudioTemplate(
  obs: ObsRpc,
  baseUrl: string,
  commentaryUuid: string,
  gameAudioUuid?: string,
  desktopEnabled = true,
): Promise<{ desktop: Ref[]; microphoneUuid: string; microphone: Ref[] } | null> {
  if ((await obs.call('GetSceneCollectionList')).currentSceneCollectionName !== OBS_COLLECTION)
    return null;
  const specials = await obs.call('GetSpecialInputs');
  if (Object.values(specials).some((x) => typeof x === 'string' && x.length > 0)) return null;
  const inputs = objects((await obs.call('GetInputList')).inputs);
  const desired = obsDesiredScenes(baseUrl);
  if (
    !gameAudioUuid &&
    inputs.some(
      (input) =>
        typeof input.inputName === 'string' &&
        (input.inputName.startsWith('Mizar · Game Audio ') ||
          /^游戏声音(?: \d+)?$/.test(input.inputName)),
    )
  )
    return null;
  const allowedNames = new Set([
    OBS_CAPTURE_INPUT,
    ...desired.map((scene) => scene.browserInput),
    '桌面声音',
    '麦克风',
  ]);
  const musicNames = inputs
    .filter(
      (input) =>
        input.inputKind === 'ffmpeg_source' &&
        typeof input.inputName === 'string' &&
        (/^Mizar · (BGM|Stinger) · [0-9a-f-]{36}$/.test(input.inputName) ||
          /^(音乐|音效)(?: \d+)?$/.test(input.inputName)),
    )
    .map((input) => String(input.inputName));
  for (const name of musicNames) allowedNames.add(name);
  const compactInputs = inputs.filter((input) => input.inputName === BP_COMPACT_INPUT);
  if (compactInputs.length > 1) return null;
  const compact = compactInputs[0];
  if (compact) {
    if (compact.inputKind !== 'browser_source' || typeof compact.inputUuid !== 'string')
      return null;
    const settings = (await obs.call('GetInputSettings', { inputUuid: compact.inputUuid }))
      .inputSettings;
    if (
      !settings ||
      typeof settings !== 'object' ||
      (settings as Record<string, unknown>).url !== new URL(BP_COMPACT_PATH, baseUrl).toString() ||
      (settings as Record<string, unknown>).width !== OBS_WIDTH ||
      (settings as Record<string, unknown>).height !== OBS_HEIGHT
    )
      return null;
    allowedNames.add(BP_COMPACT_INPUT);
  }
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
    (x) => x.inputName === '桌面声音' && x.inputKind === 'wasapi_output_capture',
  );
  let microphone = inputs.find(
    (x) => x.inputName === '麦克风' && x.inputKind === 'wasapi_input_capture',
  );
  const activeMicrophones = new Set<string>();
  for (const scene of desired) {
    const items = objects(
      (await obs.call('GetSceneItemList', { sceneName: scene.sceneName })).sceneItems,
    );
    for (const item of items)
      if (
        item.sceneItemEnabled === true &&
        inputs.some(
          (input) =>
            input.inputUuid === item.sourceUuid &&
            input.inputKind === 'wasapi_input_capture' &&
            input.inputName !== '麦克风',
        )
      )
        activeMicrophones.add(String(item.sourceUuid));
  }
  if (activeMicrophones.size > 1) return null;
  if (activeMicrophones.size === 1)
    microphone = inputs.find((input) => activeMicrophones.has(String(input.inputUuid)));
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
  for (const input of inputs.filter((x) => x.inputName === OBS_CAPTURE_INPUT)) {
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
  const wanted = new Set(desired.map((x) => x.sceneName));
  const allScenes = objects((await obs.call('GetSceneList')).scenes);
  const seen = new Set<string>();
  const refs: Ref[] = [];
  const microphoneRefs: Ref[] = [];
  let compactSeen = false;
  for (const scene of allScenes) {
    if (typeof scene.sceneName !== 'string') return null;
    if (!wanted.has(scene.sceneName)) continue;
    const items = objects(
      (await obs.call('GetSceneItemList', { sceneName: scene.sceneName })).sceneItems,
    );
    // Nested paths make ownership and duplicate capture impossible to prove from the template.
    if (items.some((x) => x.isGroup === true || x.sourceType === 'OBS_SOURCE_TYPE_SCENE'))
      return null;
    const compactItems = items.filter(
      (item) =>
        item.sourceName === BP_COMPACT_INPUT || (compact && item.sourceUuid === compact.inputUuid),
    );
    if (compactItems.length) {
      const gameplay = desired.find((value) => value.id === 'gameplay')!;
      if (
        !compact ||
        compactSeen ||
        scene.sceneName !== gameplay.sceneName ||
        compactItems.length !== 1 ||
        compactItems[0]!.sourceUuid !== compact.inputUuid ||
        compactItems[0]!.sourceName !== BP_COMPACT_INPUT ||
        compactItems[0]!.sceneItemEnabled !== false
      )
        return null;
      compactSeen = true;
    }
    if (
      wanted.has(scene.sceneName) &&
      items.some(
        (x) =>
          x.sourceUuid !== commentaryUuid &&
          x.sourceUuid !== gameAudioUuid &&
          !inputs.some(
            (input) => input.inputUuid === x.sourceUuid && audioKinds.has(String(input.inputKind)),
          ) &&
          (typeof x.sourceName !== 'string' || !allowedNames.has(x.sourceName)),
      )
    )
      return null;
    if (wanted.has(scene.sceneName)) {
      const desiredScene = desired.find((value) => value.sceneName === scene.sceneName)!;
      const expectedNames = new Set([...desiredScene.sources, '桌面声音', '麦克风', ...musicNames]);
      if (compact && desiredScene.id === 'gameplay') expectedNames.add(BP_COMPACT_INPUT);
      if (
        items.some(
          (value) =>
            value.sourceUuid !== commentaryUuid &&
            value.sourceUuid !== gameAudioUuid &&
            !inputs.some(
              (input) =>
                input.inputUuid === value.sourceUuid && audioKinds.has(String(input.inputKind)),
            ) &&
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
    const old = items.filter(
      (item) =>
        item.sourceUuid !== microphone.inputUuid &&
        item.sourceUuid !== commentaryUuid &&
        item.sourceUuid !== gameAudioUuid &&
        inputs.some(
          (input) => input.inputUuid === item.sourceUuid && audioKinds.has(String(input.inputKind)),
        ),
    );
    const mic = items.filter((item) => item.sourceUuid === microphone.inputUuid);
    const desktopRefs = old.filter((item) => item.sourceUuid === desktop.inputUuid);
    if (
      seen.has(scene.sceneName) ||
      desktopRefs.length !== 1 ||
      mic.length !== 1 ||
      typeof mic[0]!.sceneItemEnabled !== 'boolean' ||
      typeof mic[0]!.sceneItemId !== 'number' ||
      old.some(
        (item) =>
          typeof item.sceneItemEnabled !== 'boolean' || typeof item.sceneItemId !== 'number',
      ) ||
      (desktopEnabled
        ? !old.some((item) => item.sceneItemEnabled === true)
        : old.some((item) => item.sceneItemEnabled !== false))
    )
      return null;
    seen.add(scene.sceneName);
    for (const item of old.filter((value) => value.sceneItemEnabled === desktopEnabled))
      refs.push({
        sceneName: scene.sceneName,
        sceneItemId: item.sceneItemId as number,
        sourceUuid: String(item.sourceUuid),
      });
    if (mic[0]!.sceneItemEnabled === false)
      microphoneRefs.push({
        sceneName: scene.sceneName,
        sceneItemId: mic[0]!.sceneItemId,
        sourceUuid: microphone.inputUuid,
      });
  }
  if (seen.size !== wanted.size || Boolean(compact) !== compactSeen) return null;
  return { desktop: refs, microphoneUuid: microphone.inputUuid, microphone: microphoneRefs };
}

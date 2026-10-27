import { writeFile, rm } from 'node:fs/promises';
import { OBS_COLLECTION, obsDesiredScenes } from './desired-state.js';
import { createCommentaryProbe, RemoteCommentary } from './remote-commentary.js';
import type { ObsFinding, ObsRpc } from './reconcile.js';

function records(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) throw new Error('commentary_obs_response_invalid');
  return value.filter((x): x is Record<string, unknown> => typeof x === 'object' && x !== null);
}

/** Prepare inert scene references. Audio activation belongs to the later mixer migration. */
export async function prepareRemoteCommentary(
  obs: ObsRpc,
  owner: RemoteCommentary,
  journal: string,
  endpoint: string,
  baseUrl: string,
): Promise<ObsFinding[]> {
  const state = await owner.get();
  const pending = (message = '场景已准备，音频分路待完成。'): ObsFinding[] => [
    { code: 'commentary_pending', message },
  ];
  if (state.preference.mode === 'disabled') {
    await rm(`${journal}.waiting`, { force: true });
    return [];
  }
  const collection = (await obs.call('GetSceneCollectionList')).currentSceneCollectionName;
  if (collection !== OBS_COLLECTION) return pending('当前场景集合已改变，远端解说音频待配置。');
  const [stream, record] = await Promise.all([
    obs.call('GetStreamStatus'),
    obs.call('GetRecordStatus'),
  ]);
  if (stream.outputActive !== false || record.outputActive !== false)
    return pending('OBS 正在输出，远端解说音频将在停止输出后配置。');
  const check = async () => {
    if ((await owner.get()).revision !== state.revision)
      throw new Error('commentary_revision_changed');
    const [s, r, c] = await Promise.all([
      obs.call('GetStreamStatus'),
      obs.call('GetRecordStatus'),
      obs.call('GetSceneCollectionList'),
    ]);
    if (
      s.outputActive !== false ||
      r.outputActive !== false ||
      c.currentSceneCollectionName !== collection
    )
      throw new Error('commentary_context_changed');
  };
  const scenes = obsDesiredScenes(baseUrl);
  let inputs = records((await obs.call('GetInputList')).inputs);
  let target: string | undefined;
  let pendingMessage: string | undefined;
  if (state.preference.mode === 'existingInput') {
    const binding = state.preference.binding;
    if (
      binding.endpoint !== endpoint ||
      binding.collection !== collection ||
      !inputs.some((i) => i.inputUuid === binding.inputUuid)
    )
      return pending('所选远端解说来源已失效，请重新选择。');
    target = binding.inputUuid;
  } else {
    let probe = inputs.find(
      (i) => i.inputKind === 'wasapi_process_output_capture' && typeof i.inputUuid === 'string',
    )?.inputUuid as string | undefined;
    if (!probe) {
      probe = await createCommentaryProbe(
        obs,
        journal,
        { endpoint, collection, sceneName: scenes[0]!.sceneName },
        check,
      );
      inputs = records((await obs.call('GetInputList')).inputs);
    }
    let window: string | undefined;
    if (state.preference.mode === 'application') window = state.preference.window;
    else {
      const found = await owner.discover(obs, state.revision, probe);
      if (found.kind === 'existing') target = found.candidate.inputUuid;
      else if (found.kind === 'window') window = found.candidate.window;
      else if (found.kind === 'waiting') {
        target = await createCommentaryProbe(
          obs,
          journal,
          { endpoint, collection, sceneName: scenes[0]!.sceneName },
          check,
        );
        inputs = records((await obs.call('GetInputList')).inputs);
        await writeFile(
          `${journal}.waiting`,
          `${JSON.stringify({ endpoint, collection, uuid: target, revision: state.revision, phase: 'waiting' })}\n`,
          { mode: 0o600 },
        );
        pendingMessage = '等待 TeamSpeak 启动；场景已准备，音频分路待完成。';
      } else return pending('检测到多个远端解说候选，请选择来源。');
    }
    if (window) {
      const owned = await createCommentaryProbe(
        obs,
        journal,
        { endpoint, collection, sceneName: scenes[0]!.sceneName },
        check,
      );
      const settings = (await obs.call('GetInputSettings', { inputUuid: owned })).inputSettings;
      if (!settings || typeof settings !== 'object') throw new Error('commentary_settings_unknown');
      const existing = (settings as Record<string, unknown>).window;
      if (existing && existing !== window) return pending('远端解说来源目标已改变，请重新配置。');
      if (!existing) {
        await check();
        await obs.call('SetInputSettings', {
          inputUuid: owned,
          inputSettings: { window, priority: 2 },
          overlay: true,
        });
      }
      target = owned;
      inputs = records((await obs.call('GetInputList')).inputs);
    }
  }
  const source = inputs.find((i) => i.inputUuid === target);
  if (!source || typeof source.inputName !== 'string')
    return pending('所选远端解说来源已失效，请重新选择。');
  const name = source.inputName;
  const containsEnabled = async (
    scene: string,
    group: boolean,
    ancestors: Set<string>,
  ): Promise<boolean> => {
    if (ancestors.has(scene) || ancestors.size >= 16) throw new Error('commentary_scene_cycle');
    const next = new Set(ancestors).add(scene);
    const items = records(
      (await obs.call(group ? 'GetGroupSceneItemList' : 'GetSceneItemList', { sceneName: scene }))
        .sceneItems,
    );
    for (const item of items) {
      if (item.sceneItemEnabled !== true) continue;
      if (item.sourceUuid === target) return true;
      if (
        typeof item.sourceName === 'string' &&
        (item.isGroup === true || item.sourceType === 'OBS_SOURCE_TYPE_SCENE') &&
        (await containsEnabled(item.sourceName, item.isGroup === true, next))
      )
        return true;
    }
    return false;
  };
  for (const scene of scenes) {
    const items = records(
      (await obs.call('GetSceneItemList', { sceneName: scene.sceneName })).sceneItems,
    );
    if (
      items.some((i) => i.sourceUuid === target) ||
      (await containsEnabled(scene.sceneName, false, new Set()))
    )
      continue;
    await check();
    await obs.call('CreateSceneItem', {
      sceneName: scene.sceneName,
      sourceName: name,
      sceneItemEnabled: false,
    });
  }
  if (!pendingMessage) await rm(`${journal}.waiting`, { force: true });
  return pending(pendingMessage);
}

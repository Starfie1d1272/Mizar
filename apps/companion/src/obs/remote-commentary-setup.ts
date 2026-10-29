import { writeFile, rm } from 'node:fs/promises';
import { inspectAudioSceneGraph } from './audio-scene-graph.js';
import { OBS_COLLECTION, obsDesiredScenes } from './desired-state.js';
import { createCommentaryProbe, isTeamspeak, RemoteCommentary } from './remote-commentary.js';
import {
  AUTO_TEAMSPEAK_TARGET,
  applyCommentarySwitch,
  readCommentarySwitch,
  saveCommentarySwitch,
  type CommentarySwitch,
} from './commentary-switch.js';
import type { MigrationObserver } from './audio-migration.js';
import { readOwnedCommentaryTarget, saveOwnedCommentaryTarget } from './commentary-owned-target.js';
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
  observer?: MigrationObserver,
  verifySwitch?: (plan: CommentarySwitch) => Promise<boolean>,
  onReady?: (target: string, revision: string) => void,
  allowOutput = false,
): Promise<ObsFinding[]> {
  const state = await owner.get();
  const pending = (message = '场景已准备，音频分路待完成。'): ObsFinding[] => [
    { code: 'commentary_pending', message },
  ];
  if ((await readCommentarySwitch(`${journal}.switch`))?.phase === 'sent')
    return pending('上次解说来源切换结果待核对，请在 OBS 中检查后处理。');
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
  if (
    typeof stream.outputActive !== 'boolean' ||
    typeof record.outputActive !== 'boolean' ||
    (!allowOutput && (stream.outputActive || record.outputActive))
  )
    return pending('OBS 音频状态未确认，请稍后重试。');
  const check = async () => {
    if ((await owner.get()).revision !== state.revision)
      throw new Error('commentary_revision_changed');
    const [s, r, c] = await Promise.all([
      obs.call('GetStreamStatus'),
      obs.call('GetRecordStatus'),
      obs.call('GetSceneCollectionList'),
    ]);
    if (
      typeof s.outputActive !== 'boolean' ||
      typeof r.outputActive !== 'boolean' ||
      (!allowOutput && (s.outputActive || r.outputActive)) ||
      c.currentSceneCollectionName !== collection
    )
      throw new Error('commentary_context_changed');
  };
  const scenes = obsDesiredScenes(baseUrl);
  const ensureInert = async (uuid: string) => {
    if (!allowOutput) return;
    const graph = await inspectAudioSceneGraph(
      obs,
      scenes.map((scene) => scene.sceneName),
    );
    if (
      graph.some((container) =>
        container.items.some(
          (item) =>
            item.sourceUuid === uuid && (item.sceneItemEnabled || container.otherRoots.size),
        ),
      )
    )
      throw new Error('commentary_shared_source');
    const inputs = records((await obs.call('GetInputList')).inputs);
    const name = inputs.find((input) => input.inputUuid === uuid)?.inputName;
    if (Object.values(await obs.call('GetSpecialInputs')).includes(name))
      throw new Error('commentary_shared_source');
  };
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
        { endpoint, collection, sceneName: scenes[0]!.sceneName, allowOutput },
        check,
      );
      inputs = records((await obs.call('GetInputList')).inputs);
    }
    let window: string | undefined;
    if (state.preference.mode === 'application') window = state.preference.window;
    else {
      const deferred = await readCommentarySwitch(`${journal}.switch`);
      if (
        deferred?.phase === 'prepared' &&
        deferred.to === AUTO_TEAMSPEAK_TARGET &&
        deferred.endpoint === endpoint &&
        deferred.collection === collection &&
        deferred.revision === state.revision
      ) {
        const windows = (await owner.windows(obs, state.revision, deferred.uuid)).filter(
          (candidate) => isTeamspeak(candidate.window),
        );
        if (windows.length === 0) {
          await writeFile(
            `${journal}.waiting`,
            `${JSON.stringify({ endpoint, collection, uuid: deferred.uuid, revision: state.revision, phase: 'waiting' })}\n`,
            { mode: 0o600 },
          );
          return pending('等待 TeamSpeak 启动；当前解说来源保持不变。');
        }
        if (windows.length !== 1) return pending('检测到多个 TeamSpeak 窗口，请选择来源。');
        window = windows[0]!.window;
        await saveCommentarySwitch(`${journal}.switch`, { ...deferred, to: window });
      } else {
        const found = await owner.discover(obs, state.revision, probe);
        if (found.kind === 'existing') target = found.candidate.inputUuid;
        else if (found.kind === 'window') window = found.candidate.window;
        else if (found.kind === 'waiting') {
          target = await createCommentaryProbe(
            obs,
            journal,
            { endpoint, collection, sceneName: scenes[0]!.sceneName, allowOutput },
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
    }
    if (window) {
      const owned = await createCommentaryProbe(
        obs,
        journal,
        { endpoint, collection, sceneName: scenes[0]!.sceneName, allowOutput },
        check,
      );
      const settings = (await obs.call('GetInputSettings', { inputUuid: owned })).inputSettings;
      if (!settings || typeof settings !== 'object') throw new Error('commentary_settings_unknown');
      const existing = (settings as Record<string, unknown>).window;
      if (state.preference.mode === 'application') {
        const candidates = await owner.windows(obs, state.revision, owned);
        if (!candidates.some((candidate) => candidate.window === window)) {
          target = owned;
          await writeFile(
            `${journal}.waiting`,
            `${JSON.stringify({ endpoint, collection, uuid: target, revision: state.revision, phase: 'waiting' })}\n`,
            { mode: 0o600 },
          );
          pendingMessage = '等待所选应用启动；场景已准备，音频分路待完成。';
          window = undefined;
        }
      }
      const planned = window ? await readCommentarySwitch(`${journal}.switch`) : null;
      if (
        window &&
        planned?.phase === 'prepared' &&
        planned.endpoint === endpoint &&
        planned.collection === collection &&
        planned.uuid === owned &&
        planned.revision === state.revision &&
        planned.to === window &&
        existing !== planned.from
      )
        return pending('远端解说来源目标已改变，请重新配置。');
      if (window && existing && existing !== window) {
        if (allowOutput) return pending('解说来源已改变，请重新选择。');
        const path = `${journal}.switch`;
        const plan = planned;
        if (
          !plan ||
          plan.endpoint !== endpoint ||
          plan.collection !== collection ||
          plan.uuid !== owned ||
          plan.revision !== state.revision ||
          plan.from !== existing ||
          plan.to !== window
        )
          return pending('远端解说来源目标已改变，请重新配置。');
        if (!observer || !verifySwitch) throw new Error('commentary_switch_observer_required');
        const targetPath = `${journal}.owned-target`;
        await applyCommentarySwitch(
          obs,
          path,
          plan,
          observer,
          async () => {
            await check();
            const previous = await readOwnedCommentaryTarget(targetPath);
            if (
              !(await verifySwitch(plan)) ||
              !previous ||
              previous.endpoint !== plan.endpoint ||
              previous.collection !== plan.collection ||
              previous.uuid !== plan.uuid ||
              previous.window !== plan.from
            )
              throw new Error('commentary_switch_binding_changed');
          },
          async () => {
            await saveOwnedCommentaryTarget(targetPath, {
              endpoint: plan.endpoint,
              collection: plan.collection,
              uuid: plan.uuid,
              window: plan.to,
            });
          },
        );
      }
      if (window && !existing) {
        await ensureInert(owned);
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
  if (!pendingMessage && target) onReady?.(target, state.revision);
  return pending(pendingMessage);
}

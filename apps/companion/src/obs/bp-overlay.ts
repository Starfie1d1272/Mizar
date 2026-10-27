import {
  OBS_COLLECTION,
  OBS_HEIGHT,
  OBS_WIDTH,
  obsBrowserInputName,
  obsSceneName,
} from './desired-state.js';
import type { ObsRpc } from './reconcile.js';

export const BP_COMPACT_INPUT = 'Mizar · BP 紧凑底栏';
export const BP_COMPACT_PATH = '/program/bp-compact';

function objects(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter(
        (item): item is Record<string, unknown> => typeof item === 'object' && item !== null,
      )
    : [];
}

/** Mutates only the compact source in the managed gameplay scene and verifies the result. */
export async function setBpCompactVisible(
  obs: ObsRpc,
  baseUrl: string,
  visible: boolean,
): Promise<void> {
  const base = new URL(baseUrl);
  if (base.protocol !== 'http:' || base.hostname !== '127.0.0.1')
    throw new Error('无效的本机地址。');
  const url = new URL(BP_COMPACT_PATH, base).toString();
  const sceneName = obsSceneName('gameplay');
  const collection = await obs.call('GetSceneCollectionList');
  if (collection.currentSceneCollectionName !== OBS_COLLECTION)
    throw new Error('请先在 OBS 中选择 Mizar 场景集合。');
  const scenes = await obs.call('GetSceneList');
  if (visible && scenes.currentProgramSceneName !== sceneName)
    throw new Error('请先将受管比赛画面切到播出。');
  const inputs = objects((await obs.call('GetInputList')).inputs);
  const input = inputs.find((item) => item.inputName === BP_COMPACT_INPUT);
  if (input && input.inputKind !== 'browser_source') throw new Error('紧凑 BP 来源名称冲突。');
  let items = objects((await obs.call('GetSceneItemList', { sceneName })).sceneItems);
  // Avoid obscuring an enabled managed HUD; its layout can be customized arbitrarily.
  if (
    visible &&
    items.some(
      (item) =>
        item.sourceName === obsBrowserInputName('gameplay') && item.sceneItemEnabled !== false,
    )
  )
    throw new Error('比赛 HUD 与底栏可能重叠。请先在 OBS 中关闭比赛 HUD 来源，再播出紧凑 BP。');
  if (input) {
    const settings = (await obs.call('GetInputSettings', { inputName: BP_COMPACT_INPUT }))
      .inputSettings as Record<string, unknown> | undefined;
    if (settings?.url !== url || settings.width !== OBS_WIDTH || settings.height !== OBS_HEIGHT)
      throw new Error('紧凑 BP 来源配置不匹配，请检查 OBS。');
  } else if (visible) {
    await obs.call('CreateInput', {
      sceneName,
      inputName: BP_COMPACT_INPUT,
      inputKind: 'browser_source',
      inputSettings: { url, width: OBS_WIDTH, height: OBS_HEIGHT },
      sceneItemEnabled: false,
    });
  }
  if (visible && input && !items.some((item) => item.sourceName === BP_COMPACT_INPUT)) {
    await obs.call('CreateSceneItem', {
      sceneName,
      sourceName: BP_COMPACT_INPUT,
      sceneItemEnabled: false,
    });
  }
  items = objects((await obs.call('GetSceneItemList', { sceneName })).sceneItems);
  const matches = items.filter((item) => item.sourceName === BP_COMPACT_INPUT);
  if (matches.length > 1) throw new Error('紧凑 BP 来源重复，请在 OBS 中检查。');
  const item = matches[0];
  if (!item) {
    if (!visible) return;
    throw new Error('未能确认紧凑 BP 来源。');
  }
  if (typeof item.sceneItemId !== 'number') throw new Error('未能确认紧凑 BP 来源。');
  if (visible) {
    await obs.call('SetSceneItemTransform', {
      sceneName,
      sceneItemId: item.sceneItemId,
      sceneItemTransform: {
        positionX: 0,
        positionY: 0,
        rotation: 0,
        scaleX: 1,
        scaleY: 1,
        boundsType: 'OBS_BOUNDS_NONE',
        cropLeft: 0,
        cropRight: 0,
        cropTop: 0,
        cropBottom: 0,
      },
    });
    await obs.call('SetSceneItemIndex', {
      sceneName,
      sceneItemId: item.sceneItemId,
      sceneItemIndex: items.length - 1,
    });
  }
  await obs.call('SetSceneItemEnabled', {
    sceneName,
    sceneItemId: item.sceneItemId,
    sceneItemEnabled: visible,
  });
  const verified = objects((await obs.call('GetSceneItemList', { sceneName })).sceneItems).find(
    (candidate) =>
      candidate.sceneItemId === item.sceneItemId && candidate.sourceName === BP_COMPACT_INPUT,
  );
  if (!verified || verified.sceneItemEnabled !== visible)
    throw new Error('OBS 未确认紧凑 BP 状态。');
  if (
    (await obs.call('GetSceneCollectionList')).currentSceneCollectionName !== OBS_COLLECTION ||
    (visible && (await obs.call('GetCurrentProgramScene')).currentProgramSceneName !== sceneName)
  )
    throw new Error('OBS 场景已变化，紧凑 BP 状态待确认。');
}

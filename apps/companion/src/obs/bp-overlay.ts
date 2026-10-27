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
  const verifiedItems = objects((await obs.call('GetSceneItemList', { sceneName })).sceneItems);
  const verified = verifiedItems.find(
    (candidate) =>
      candidate.sceneItemId === item.sceneItemId && candidate.sourceName === BP_COMPACT_INPUT,
  );
  if (
    visible &&
    verifiedItems.some(
      (candidate) =>
        candidate.sourceName === obsBrowserInputName('gameplay') &&
        candidate.sceneItemEnabled !== false,
    )
  ) {
    await obs.call('SetSceneItemEnabled', {
      sceneName,
      sceneItemId: item.sceneItemId,
      sceneItemEnabled: false,
    });
    throw new Error('比赛 HUD 已重新启用，底栏未播出。');
  }
  if (visible) {
    const actualInput = objects((await obs.call('GetInputList')).inputs).find(
      (candidate) => candidate.inputName === BP_COMPACT_INPUT,
    );
    const settings = (await obs.call('GetInputSettings', { inputName: BP_COMPACT_INPUT }))
      .inputSettings as Record<string, unknown> | undefined;
    if (
      actualInput?.inputKind !== 'browser_source' ||
      settings?.url !== url ||
      settings.width !== OBS_WIDTH ||
      settings.height !== OBS_HEIGHT
    )
      throw new Error('未能确认紧凑 BP 来源配置。');
  }
  if (!verified || verified.sceneItemEnabled !== visible)
    throw new Error('OBS 未确认紧凑 BP 状态。');
  if (
    (await obs.call('GetSceneCollectionList')).currentSceneCollectionName !== OBS_COLLECTION ||
    (visible && (await obs.call('GetCurrentProgramScene')).currentProgramSceneName !== sceneName)
  )
    throw new Error('OBS 场景已变化，紧凑 BP 状态待确认。');
}

/** Do not re-enable the managed HUD while a compact source is on air. */
export async function assertBpCompactOff(obs: ObsRpc): Promise<void> {
  const collection = await obs.call('GetSceneCollectionList');
  if (collection.currentSceneCollectionName !== OBS_COLLECTION) return;
  const sceneName = obsSceneName('gameplay');
  const scenes = objects((await obs.call('GetSceneList')).scenes);
  if (!scenes.some((scene) => scene.sceneName === sceneName)) return;
  const items = objects((await obs.call('GetSceneItemList', { sceneName })).sceneItems);
  if (items.some((item) => item.sourceName === BP_COMPACT_INPUT && item.sceneItemEnabled !== false))
    throw new Error('请先关闭紧凑 BP 底栏，再修复 OBS 场景。');
}

/** Tracks only the managed gameplay HUD scene item for one compact playback. */
export class BpOverlayOwner {
  private lease: {
    sceneUuid: string;
    inputUuid: string;
    itemId: number;
    original: boolean;
    modified: boolean;
    uncertain: boolean;
    pending: boolean | null;
  } | null = null;

  observeItem(sceneName: string, itemId: number, enabled: boolean): boolean {
    const lease = this.lease;
    if (!lease || sceneName !== obsSceneName('gameplay') || lease.itemId !== itemId) return false;
    if (lease.pending === enabled) {
      lease.pending = null;
      return false;
    }
    lease.modified = true;
    return true;
  }
  observeRemoval(sceneName: string, itemId: number): boolean {
    if (sceneName !== obsSceneName('gameplay') || this.lease?.itemId !== itemId) return false;
    this.invalidate();
    return true;
  }
  observeSceneRemoval(sceneName: string): boolean {
    if (sceneName !== obsSceneName('gameplay') || !this.lease) return false;
    this.invalidate();
    return true;
  }
  invalidate(): void {
    if (this.lease) this.lease.uncertain = true;
  }
  async set(obs: ObsRpc, baseUrl: string, visible: boolean): Promise<void> {
    const sceneName = obsSceneName('gameplay');
    const hudName = obsBrowserInputName('gameplay');
    const collection = await obs.call('GetSceneCollectionList');
    if (collection.currentSceneCollectionName !== OBS_COLLECTION) {
      this.invalidate();
      throw new Error('OBS 场景集合已改变，请核对比赛 HUD。');
    }
    const sceneList = await obs.call('GetSceneList');
    const scene = objects(sceneList.scenes).find((item) => item.sceneName === sceneName);
    if (typeof scene?.sceneUuid !== 'string') {
      this.invalidate();
      throw new Error('无法确认受管比赛场景身份。');
    }
    if (visible && sceneList.currentProgramSceneName !== sceneName)
      throw new Error('请先将受管比赛画面切到播出。');
    let items = objects((await obs.call('GetSceneItemList', { sceneName })).sceneItems);
    const hud = items.filter((item) => item.sourceName === hudName);
    if (visible && this.lease === null) {
      const input = objects((await obs.call('GetInputList')).inputs).find(
        (item) => item.inputName === hudName,
      );
      const settings = (await obs.call('GetInputSettings', { inputName: hudName }))
        .inputSettings as Record<string, unknown> | undefined;
      if (
        hud.length !== 1 ||
        typeof hud[0]?.sceneItemId !== 'number' ||
        typeof hud[0].sceneItemEnabled !== 'boolean' ||
        input?.inputKind !== 'browser_source' ||
        typeof input.inputUuid !== 'string' ||
        settings?.url !== new URL('/program', baseUrl).toString()
      )
        throw new Error('无法确认受管比赛 HUD 身份。');
      this.lease = {
        sceneUuid: scene.sceneUuid,
        inputUuid: input.inputUuid,
        itemId: hud[0].sceneItemId,
        original: hud[0].sceneItemEnabled,
        modified: false,
        uncertain: false,
        pending: null,
      };
      if (this.lease.original) {
        this.lease.pending = false;
        try {
          await obs.call('SetSceneItemEnabled', {
            sceneName,
            sceneItemId: this.lease.itemId,
            sceneItemEnabled: false,
          });
        } catch (error) {
          this.invalidate();
          throw error;
        }
        items = objects((await obs.call('GetSceneItemList', { sceneName })).sceneItems);
        if (
          !items.some(
            (item) =>
              item.sceneItemId === this.lease?.itemId &&
              item.sourceName === hudName &&
              item.sceneItemEnabled === false,
          )
        ) {
          this.invalidate();
          throw new Error('比赛 HUD 隐藏未确认。');
        }
      }
    }
    if (visible && this.lease) {
      if (
        this.lease.sceneUuid !== scene.sceneUuid ||
        this.lease.modified ||
        this.lease.uncertain ||
        !items.some(
          (item) =>
            item.sceneItemId === this.lease?.itemId &&
            item.sourceName === hudName &&
            item.sceneItemEnabled === false,
        )
      ) {
        this.invalidate();
        throw new Error('比赛 HUD 已变化或状态待确认，请先关闭底栏。');
      }
    }
    await setBpCompactVisible(obs, baseUrl, visible);
    const lease = this.lease;
    if (!visible && lease) {
      items = objects((await obs.call('GetSceneItemList', { sceneName })).sceneItems);
      const current = items.find(
        (item) => item.sceneItemId === lease.itemId && item.sourceName === hudName,
      );
      const input = objects((await obs.call('GetInputList')).inputs).find(
        (item) => item.inputName === hudName,
      );
      const settings = input
        ? ((await obs.call('GetInputSettings', { inputName: hudName })).inputSettings as
            Record<string, unknown> | undefined)
        : undefined;
      if (
        lease.sceneUuid !== scene.sceneUuid ||
        lease.uncertain ||
        !current ||
        input?.inputUuid !== lease.inputUuid ||
        input.inputKind !== 'browser_source' ||
        settings?.url !== new URL('/program', baseUrl).toString()
      ) {
        this.lease = null;
        throw new Error('比赛 HUD 状态待确认，请在 OBS 中核对。');
      }
      if (lease.original && !lease.modified && current.sceneItemEnabled === false) {
        lease.pending = true;
        try {
          await obs.call('SetSceneItemEnabled', {
            sceneName,
            sceneItemId: lease.itemId,
            sceneItemEnabled: true,
          });
        } catch (error) {
          this.invalidate();
          throw error;
        }
        const restored = objects(
          (await obs.call('GetSceneItemList', { sceneName })).sceneItems,
        ).find((item) => item.sceneItemId === lease.itemId && item.sourceName === hudName);
        if (restored?.sceneItemEnabled !== true) {
          this.invalidate();
          throw new Error('比赛 HUD 恢复未确认，请在 OBS 中核对。');
        }
      }
      this.lease = null;
    }
  }
}

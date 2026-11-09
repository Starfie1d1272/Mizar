import {
  OBS_COLLECTION,
  OBS_HEIGHT,
  OBS_WIDTH,
  obsBrowserInputName,
  obsSceneName,
} from './desired-state.js';
import type { ObsRpc } from './reconcile.js';

export const BP_COMPACT_INPUT = '禁选紧凑底栏';
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

const DEFAULT_COMPACT_TRANSFORM: Record<string, unknown> = {
  positionX: 0,
  positionY: 0,
  rotation: 0,
  scaleX: 1,
  scaleY: 1,
  alignment: 5,
  boundsType: 'OBS_BOUNDS_NONE',
  boundsAlignment: 0,
  boundsWidth: 0,
  boundsHeight: 0,
  cropLeft: 0,
  cropRight: 0,
  cropTop: 0,
  cropBottom: 0,
  cropToBounds: false,
};
function configuredTransform(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object') return null;
  const fields = value as Record<string, unknown>;
  if (!Object.keys(DEFAULT_COMPACT_TRANSFORM).every((key) => fields[key] !== undefined))
    return null;
  return Object.fromEntries(
    Object.keys(DEFAULT_COMPACT_TRANSFORM).map((key) => [key, fields[key]]),
  );
}
function sameTransform(expected: Record<string, unknown>, actual: unknown): boolean {
  const fields = configuredTransform(actual);
  return fields !== null && Object.entries(expected).every(([key, value]) => fields[key] === value);
}

type PreparationReceipt = {
  event: string;
  fields: Record<string, unknown>;
  expires: number;
  received?: Record<string, unknown>;
  onReceived?: (data: Record<string, unknown>) => void;
};

/** Tracks only the managed gameplay HUD scene item for one compact playback. */
export class BpOverlayOwner {
  private preparationReceipts: PreparationReceipt[] = [];
  private compactTransform: {
    sceneUuid: string;
    inputUuid: string;
    itemId: number;
    fields: Record<string, unknown>;
  } | null = null;

  /** Consume only one exact receipt of a submitted compact-owner write. */
  observePreparationEvent(event: string, data: Record<string, unknown>): boolean {
    this.preparationReceipts = this.preparationReceipts.filter((item) => item.expires > Date.now());
    const same = (expected: unknown, actual: unknown): boolean => {
      if (Array.isArray(expected))
        return (
          Array.isArray(actual) &&
          expected.length === actual.length &&
          expected.every((value, index) => same(value, actual[index]))
        );
      if (expected && typeof expected === 'object')
        return (
          actual !== null &&
          typeof actual === 'object' &&
          Object.entries(expected).every(([key, value]) =>
            same(value, (actual as Record<string, unknown>)[key]),
          )
        );
      return expected === actual;
    };
    const normalized =
      event === 'SceneItemListReindexed'
        ? {
            ...data,
            sceneItems: objects(data.sceneItems).sort(
              (a, b) => Number(a.sceneItemIndex) - Number(b.sceneItemIndex),
            ),
          }
        : data;
    const index = this.preparationReceipts.findIndex(
      (item) => item.event === event && same(item.fields, normalized),
    );
    if (index < 0) {
      const owned = this.compactTransform;
      if (
        owned &&
        ((event === 'SceneItemRemoved' &&
          data.sceneUuid === owned.sceneUuid &&
          data.sceneItemId === owned.itemId) ||
          (event === 'SceneRemoved' && data.sceneUuid === owned.sceneUuid) ||
          (event === 'InputRemoved' && data.inputUuid === owned.inputUuid))
      )
        this.compactTransform = null;
      // OBS repeats transform events when source dimensions become available. Only
      // unchanged configured fields of the exact owned item are equivalent evidence.
      return Boolean(
        event === 'SceneItemTransformChanged' &&
        owned &&
        data.sceneUuid === owned.sceneUuid &&
        data.sceneItemId === owned.itemId &&
        sameTransform(owned.fields, data.sceneItemTransform),
      );
    }
    const [receipt] = this.preparationReceipts.splice(index, 1);
    receipt!.received = normalized;
    receipt!.onReceived?.(normalized);
    return true;
  }

  /** Expectations survive the RPC response because OBS observers use separate sockets. */
  preparationRpc(obs: ObsRpc, baseUrl: string): ObsRpc {
    return {
      ...obs,
      call: async (type, data) => {
        if (type === 'SetSceneItemTransform' && data) {
          const fields = data.sceneItemTransform as Record<string, unknown>;
          const crop = Object.fromEntries(
            Object.entries(fields).filter(([key]) => /^crop(Left|Right|Top|Bottom)$/.test(key)),
          );
          const geometry = Object.fromEntries(
            Object.entries(fields).filter(([key]) => !/^crop(Left|Right|Top|Bottom)$/.test(key)),
          );
          // OBS applies info2 before crop. Separate the two known states rather than
          // assuming one event, a fixed count, or accepting arbitrary intermediate geometry.
          if (Object.keys(crop).length && Object.keys(geometry).length) {
            await this.preparationRpc(obs, baseUrl).call(type, {
              ...data,
              sceneItemTransform: geometry,
            });
            return this.preparationRpc(obs, baseUrl).call(type, {
              ...data,
              sceneItemTransform: crop,
            });
          }
        }
        if (
          !data ||
          ![
            'CreateInput',
            'CreateSceneItem',
            'SetSceneItemEnabled',
            'SetSceneItemTransform',
            'SetSceneItemIndex',
          ].includes(type)
        )
          return obs.call(type, data);
        const sceneName = obsSceneName('gameplay');
        const scene = objects((await obs.call('GetSceneList')).scenes).find(
          (item) => item.sceneName === sceneName,
        );
        if (typeof scene?.sceneUuid !== 'string' || data.sceneName !== sceneName)
          throw new Error('紧凑 BP 场景身份未确认。');
        const sceneUuid = scene.sceneUuid;
        const items = objects((await obs.call('GetSceneItemList', { sceneName })).sceneItems);
        const receipts: PreparationReceipt[] = [];
        const expect = (event: string, fields: Record<string, unknown>) => {
          const receipt: PreparationReceipt = { event, fields, expires: Date.now() + 4000 };
          receipts.push(receipt);
          return receipt;
        };
        const createdItem = (sourceUuid?: string) => {
          const created = expect('SceneItemCreated', {
            sceneUuid,
            ...(sourceUuid ? { sourceUuid } : { sourceName: BP_COMPACT_INPUT }),
          });
          const disabled = expect('SceneItemEnableStateChanged', {
            sceneUuid,
            sceneItemId: null,
            sceneItemEnabled: false,
          });
          created.onReceived = (event) => {
            disabled.fields.sceneItemId = event.sceneItemId;
            if (typeof event.sceneItemId === 'number' && typeof event.sourceUuid === 'string')
              this.compactTransform = {
                sceneUuid,
                inputUuid: event.sourceUuid,
                itemId: event.sceneItemId,
                fields: { ...DEFAULT_COMPACT_TRANSFORM },
              };
          };
        };
        if (type === 'CreateInput') {
          const settings = data.inputSettings as Record<string, unknown> | undefined;
          if (
            data.inputName !== BP_COMPACT_INPUT ||
            data.inputKind !== 'browser_source' ||
            data.sceneItemEnabled !== false ||
            settings?.url !== new URL(BP_COMPACT_PATH, baseUrl).toString()
          )
            throw new Error('紧凑 BP 创建目标未确认。');
          expect('InputCreated', {
            inputName: BP_COMPACT_INPUT,
            inputKind: 'browser_source',
            inputSettings: data.inputSettings,
          });
          createdItem();
        } else if (type === 'CreateSceneItem') {
          const input = objects((await obs.call('GetInputList')).inputs).find(
            (item) => item.inputName === BP_COMPACT_INPUT,
          );
          if (
            data.sourceName !== BP_COMPACT_INPUT ||
            typeof input?.inputUuid !== 'string' ||
            data.sceneItemEnabled !== false
          )
            throw new Error('紧凑 BP 来源身份未确认。');
          createdItem(input.inputUuid);
        } else {
          const item = items.find((item) => item.sceneItemId === data.sceneItemId);
          if (
            !item ||
            (item.sourceName !== BP_COMPACT_INPUT &&
              !(
                type === 'SetSceneItemEnabled' &&
                this.lease &&
                this.lease.sceneUuid === sceneUuid &&
                this.lease.itemId === item.sceneItemId &&
                item.sourceName === obsBrowserInputName('gameplay')
              ))
          )
            throw new Error('紧凑 BP 场景项身份未确认。');
          const input = objects((await obs.call('GetInputList')).inputs).find(
            (entry) => entry.inputName === item.sourceName,
          );
          if (
            typeof input?.inputUuid !== 'string' ||
            (item.sourceName === obsBrowserInputName('gameplay') &&
              input.inputUuid !== this.lease?.inputUuid) ||
            (item.sourceName === BP_COMPACT_INPUT &&
              this.compact &&
              (this.compact.sceneUuid !== sceneUuid ||
                this.compact.itemId !== item.sceneItemId ||
                this.compact.inputUuid !== input.inputUuid))
          )
            throw new Error('紧凑 BP 来源身份已变化。');
          const identity = { sceneUuid, sceneItemId: item.sceneItemId };
          // Do not leave an unobservable expectation for an idempotent OBS write.
          if (type === 'SetSceneItemEnabled' && item.sceneItemEnabled === data.sceneItemEnabled)
            return {};
          if (type === 'SetSceneItemIndex' && item.sceneItemIndex === data.sceneItemIndex)
            return {};
          if (type === 'SetSceneItemTransform') {
            const actual = configuredTransform(
              (
                await obs.call('GetSceneItemTransform', {
                  sceneName,
                  sceneItemId: item.sceneItemId,
                })
              ).sceneItemTransform,
            );
            if (!actual || typeof item.sceneItemId !== 'number')
              throw new Error('紧凑 BP 变换未确认。');
            const expected = { ...actual, ...(data.sceneItemTransform as Record<string, unknown>) };
            this.compactTransform = {
              sceneUuid,
              inputUuid: input.inputUuid,
              itemId: item.sceneItemId,
              fields: actual,
            };
            if (sameTransform(expected, actual)) return {};
            const receipt = expect('SceneItemTransformChanged', {
              ...identity,
              sceneItemTransform: expected,
            });
            receipt.onReceived = () => {
              this.compactTransform = {
                sceneUuid,
                inputUuid: input.inputUuid as string,
                itemId: item.sceneItemId as number,
                fields: expected,
              };
            };
          }
          if (type === 'SetSceneItemEnabled')
            expect('SceneItemEnableStateChanged', {
              ...identity,
              sceneItemEnabled: data.sceneItemEnabled,
            });

          if (type === 'SetSceneItemIndex') {
            const ordered = [...items].sort(
              (a, b) => Number(a.sceneItemIndex) - Number(b.sceneItemIndex),
            );
            ordered.splice(ordered.indexOf(item), 1);
            ordered.splice(Number(data.sceneItemIndex), 0, item);
            expect('SceneItemListReindexed', {
              sceneUuid,
              sceneItems: ordered.map((entry, index) => ({
                sceneItemId: entry.sceneItemId,
                sceneItemIndex: index,
              })),
            });
          }
        }
        this.preparationReceipts.push(...receipts);
        try {
          const result = await obs.call(type, data);
          if (type === 'CreateInput' || type === 'CreateSceneItem') {
            if (
              typeof result.sceneItemId !== 'number' ||
              (type === 'CreateInput' && typeof result.inputUuid !== 'string')
            )
              throw new Error('紧凑 BP 创建回执未确认。');
            for (const receipt of receipts) {
              const identity =
                receipt.event === 'InputCreated'
                  ? { inputUuid: result.inputUuid }
                  : receipt.event === 'SceneItemCreated'
                    ? {
                        sceneItemId: result.sceneItemId,
                        ...(type === 'CreateInput' ? { sourceUuid: result.inputUuid } : {}),
                      }
                    : { sceneItemId: result.sceneItemId };
              if (
                receipt.received &&
                !Object.entries(identity).every(([key, value]) => receipt.received![key] === value)
              )
                throw new Error('紧凑 BP 创建身份已变化。');
              Object.assign(receipt.fields, identity);
            }
          }
          // A late event on the persistent socket must be consumed before another
          // write can reuse the same target/value. Missing receipts fail closed.
          while (
            receipts.some((receipt) => !receipt.received) &&
            receipts.every((receipt) => receipt.expires > Date.now())
          )
            await new Promise<void>((resolve) => setTimeout(resolve, 10));
          if (receipts.some((receipt) => !receipt.received))
            throw new Error('紧凑 BP 配置变更回执未确认。');
          if (type === 'SetSceneItemTransform' && this.compactTransform) {
            const actual = (
              await obs.call('GetSceneItemTransform', { sceneName, sceneItemId: data.sceneItemId })
            ).sceneItemTransform;
            if (!sameTransform(this.compactTransform.fields, actual))
              throw new Error('紧凑 BP 变换回读不一致。');
          }
          return result;
        } catch (error) {
          this.preparationReceipts = this.preparationReceipts.filter(
            (item) => !receipts.includes(item),
          );
          throw error;
        }
      },
    };
  }

  private compact: { sceneUuid: string; inputUuid: string; itemId: number } | null = null;

  private lease: {
    sceneUuid: string;
    inputUuid: string;
    itemId: number;
    original: boolean;
    modified: boolean;
    uncertain: boolean;
    pending: boolean | null;
  } | null = null;

  observeItem(sceneUuid: string, itemId: number, enabled: boolean): boolean {
    const lease = this.lease;
    if (!lease || sceneUuid !== lease.sceneUuid || lease.itemId !== itemId) return false;
    if (lease.pending === enabled) {
      lease.pending = null;
      return false;
    }
    lease.modified = true;
    return true;
  }
  observeRemoval(sceneUuid: string, itemId: number): boolean {
    if (sceneUuid !== this.lease?.sceneUuid || this.lease?.itemId !== itemId) return false;
    this.invalidate();
    return true;
  }
  observeSceneRemoval(sceneUuid: string): boolean {
    if (sceneUuid !== this.lease?.sceneUuid || !this.lease) return false;
    this.invalidate();
    return true;
  }
  invalidate(): void {
    this.preparationReceipts = [];
    this.compactTransform = null;
    if (this.lease) this.lease.uncertain = true;
  }
  async hiddenHud(
    obs: ObsRpc,
    baseUrl: string,
  ): Promise<{ sceneUuid: string; inputUuid: string; itemId: number } | null> {
    const lease = this.lease;
    if (!lease || !this.compact || !lease.original || lease.modified || lease.uncertain)
      return null;
    const sceneName = obsSceneName('gameplay');
    const scenes = objects((await obs.call('GetSceneList')).scenes);
    const inputs = objects((await obs.call('GetInputList')).inputs);
    const items = objects((await obs.call('GetSceneItemList', { sceneName })).sceneItems);
    const hud = inputs.find((item) => item.inputUuid === lease.inputUuid);
    const compact = inputs.find((item) => item.inputName === BP_COMPACT_INPUT);
    const compactItems = items.filter((item) => item.sourceName === BP_COMPACT_INPUT);
    const hudItems = items.filter((item) => item.sourceName === obsBrowserInputName('gameplay'));
    if (
      !scenes.some((item) => item.sceneName === sceneName && item.sceneUuid === lease.sceneUuid) ||
      hud?.inputName !== obsBrowserInputName('gameplay') ||
      hud.inputKind !== 'browser_source' ||
      hudItems.length !== 1 ||
      hudItems[0]?.sceneItemId !== lease.itemId ||
      hudItems[0]?.sceneItemEnabled !== false ||
      compact?.inputKind !== 'browser_source' ||
      compact.inputUuid !== this.compact.inputUuid ||
      this.compact.sceneUuid !== lease.sceneUuid ||
      compactItems[0]?.sceneItemId !== this.compact.itemId ||
      compactItems.length !== 1 ||
      compactItems[0]?.sceneItemEnabled !== true
    )
      return null;
    const settings = (await obs.call('GetInputSettings', { inputName: BP_COMPACT_INPUT }))
      .inputSettings as Record<string, unknown> | undefined;
    if (
      settings?.url !== new URL(BP_COMPACT_PATH, baseUrl).toString() ||
      settings.width !== OBS_WIDTH ||
      settings.height !== OBS_HEIGHT
    )
      return null;
    const transform = (
      await obs.call('GetSceneItemTransform', { sceneName, sceneItemId: this.compact.itemId })
    ).sceneItemTransform as Record<string, unknown> | undefined;
    if (
      !transform ||
      !Object.entries({
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
      }).every(([key, value]) => transform[key] === value) ||
      compactItems[0]?.sceneItemIndex !== items.length - 1
    )
      return null;
    return this.lease === lease && !lease.modified && !lease.uncertain
      ? { sceneUuid: lease.sceneUuid, inputUuid: lease.inputUuid, itemId: lease.itemId }
      : null;
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
    if (visible) {
      const input = objects((await obs.call('GetInputList')).inputs).find(
        (item) => item.inputName === BP_COMPACT_INPUT,
      );
      const matches = objects(
        (await obs.call('GetSceneItemList', { sceneName })).sceneItems,
      ).filter((item) => item.sourceName === BP_COMPACT_INPUT);
      if (
        typeof input?.inputUuid !== 'string' ||
        matches.length !== 1 ||
        typeof matches[0]?.sceneItemId !== 'number'
      )
        throw new Error('紧凑 BP 来源身份未确认。');
      this.compact = {
        sceneUuid: scene.sceneUuid,
        inputUuid: input.inputUuid,
        itemId: matches[0].sceneItemId,
      };
      if (this.lease?.original && !(await this.hiddenHud(obs, baseUrl)))
        throw new Error('紧凑 BP 最终状态未确认。');
    }
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
    if (!visible) this.compact = null;
  }
}

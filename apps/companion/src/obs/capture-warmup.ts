import { randomUUID } from 'node:crypto';
import { link, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';
import { OBS_CAPTURE_INPUT, OBS_COLLECTION, obsSceneName } from './desired-state.js';
import { assertNoVideoOutput } from './video-transaction.js';
import type { ObsRpc } from './reconcile.js';

const journalSchema = z
  .object({
    id: z.string().uuid(),
    preparationId: z.string().uuid(),
    endpoint: z.string().min(1),
    sceneUuid: z.string().min(1),
    sourceUuid: z.string().min(1),
    itemId: z.number().int().nonnegative().nullable(),
    baselineIds: z.array(z.number().int().nonnegative()),
    initialTransform: z.record(z.string(), z.unknown()).nullable(),
    appliedTransform: z.record(z.string(), z.unknown()).nullable(),
    phase: z.enum(['creating', 'created', 'transformed', 'enabling', 'enabled']),
  })
  .strict();
type Journal = z.infer<typeof journalSchema>;
const transform = {
  boundsType: 'OBS_BOUNDS_NONE',
  scaleX: 0,
  scaleY: 0,
  positionX: -1,
  positionY: -1,
  rotation: 0,
} as const;
const objects = (value: unknown): Record<string, unknown>[] =>
  Array.isArray(value)
    ? value.filter(
        (item): item is Record<string, unknown> =>
          !!item && typeof item === 'object' && !Array.isArray(item),
      )
    : [];

export class ObsCaptureWarmupError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ObsCaptureWarmupError';
  }
}
const error = (code: string, message: string) => new ObsCaptureWarmupError(code, message);
const lost = () => error('capture_warmup_changed', 'OBS 状态已变化，临时采集保留待核对，请重试。');
const safeTransform = (value: unknown) => {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return (
    Object.entries(transform).every(([key, expected]) => record[key] === expected) &&
    record.width === 0 &&
    record.height === 0
  );
};
const stableTransform = (value: unknown): Record<string, unknown> | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !['sourceWidth', 'sourceHeight', 'width', 'height'].includes(key))
      .sort(([a], [b]) => a.localeCompare(b)),
  );
};
async function identity(obs: ObsRpc): Promise<{ sceneUuid: string; sourceUuid: string }> {
  if ((await obs.call('GetSceneCollectionList')).currentSceneCollectionName !== OBS_COLLECTION)
    throw lost();
  const scenes = await obs.call('GetSceneList');
  const waiting = obsSceneName('waiting');
  const current = objects(scenes.scenes).filter((scene) => scene.sceneName === waiting);
  if (
    scenes.currentProgramSceneName !== waiting ||
    current.length !== 1 ||
    typeof current[0]?.sceneUuid !== 'string'
  )
    throw lost();
  const inputs = objects((await obs.call('GetInputList')).inputs).filter(
    (item) => item.inputName === OBS_CAPTURE_INPUT && item.inputKind === 'game_capture',
  );
  if (inputs.length !== 1 || typeof inputs[0]?.inputUuid !== 'string') throw lost();
  return { sceneUuid: current[0].sceneUuid as string, sourceUuid: inputs[0].inputUuid as string };
}
async function audioDisabled(obs: ObsRpc, sourceUuid: string): Promise<void> {
  const actual = (await obs.call('GetInputSettings', { inputUuid: sourceUuid })).inputSettings;
  if (!actual || typeof actual !== 'object' || Array.isArray(actual))
    throw error('capture_audio_unknown', '无法确认 OBS 游戏来源的附带音频，请核对后重试。');
  let value = (actual as Record<string, unknown>).capture_audio;
  if (value === undefined) {
    const defaults = (await obs.call('GetInputDefaultSettings', { inputKind: 'game_capture' }))
      .defaultInputSettings;
    value =
      defaults && typeof defaults === 'object' && !Array.isArray(defaults)
        ? (defaults as Record<string, unknown>).capture_audio
        : undefined;
  }
  if (value !== false)
    throw error(
      value === true ? 'capture_audio_enabled' : 'capture_audio_unknown',
      value === true
        ? 'OBS 游戏来源启用了附带音频，无法安全预热采集。'
        : '无法确认 OBS 游戏来源的附带音频，请核对后重试。',
    );
}

/** One explicit preparation lease. Reads never infer ownership from a source name. */
export class ObsCaptureWarmup {
  private active: { id: string; startedAt: number; valid: () => boolean } | undefined;
  constructor(private readonly path: string) {}
  private async read(): Promise<Journal | null> {
    try {
      return journalSchema.parse(JSON.parse(await readFile(this.path, 'utf8')));
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw cause;
    }
  }
  private async save(value: Journal, create = false): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const temp = `${this.path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temp, `${JSON.stringify(value)}\n`, { mode: 0o600 });
      if (create) await link(temp, this.path);
      else await rename(temp, this.path);
    } finally {
      await rm(temp, { force: true });
    }
  }
  async valid(id: string): Promise<boolean> {
    const journal = await this.read();
    return (
      this.active?.id === id &&
      this.active.valid() &&
      journal?.id === id &&
      journal.phase === 'enabled'
    );
  }
  async pending(id: string): Promise<boolean> {
    return (await this.read())?.id === id;
  }
  async matches(id: string, since: number): Promise<boolean> {
    return this.active?.startedAt === since && (await this.valid(id));
  }
  async confirm(obs: ObsRpc, id: string): Promise<boolean> {
    if (!(await this.valid(id))) return false;
    const journal = await this.read();
    if (!journal || journal.id !== id || journal.itemId === null) return false;
    await assertNoVideoOutput(obs);
    const latest = await identity(obs);
    if (latest.sceneUuid !== journal.sceneUuid || latest.sourceUuid !== journal.sourceUuid)
      return false;
    await audioDisabled(obs, journal.sourceUuid);
    const items = objects(
      (await obs.call('GetSceneItemList', { sceneUuid: journal.sceneUuid })).sceneItems,
    );
    const item = items.find((candidate) => candidate.sceneItemId === journal.itemId);
    const measured = await obs.call('GetSceneItemTransform', {
      sceneUuid: journal.sceneUuid,
      sceneItemId: journal.itemId,
    });
    return (
      item?.sourceUuid === journal.sourceUuid &&
      item.sceneItemEnabled === true &&
      safeTransform(measured.sceneItemTransform) &&
      journal.appliedTransform !== null &&
      JSON.stringify(stableTransform(measured.sceneItemTransform)) ===
        JSON.stringify(journal.appliedTransform) &&
      (await this.valid(id))
    );
  }
  async begin(
    obs: ObsRpc,
    endpoint: string,
    preparationId: string,
    valid: () => boolean,
    lease: () => boolean,
  ): Promise<{ transactionId: string; startedAt: number }> {
    if (!valid() || !lease()) throw lost();
    const previous = await this.read();
    if (previous) {
      if (this.active?.id === previous.id && this.active.valid())
        throw error('capture_warmup_busy', 'OBS 临时采集正在使用，请等待当前准备完成。');
      this.active = undefined;
      await this.release(obs, endpoint, previous.id, lease);
    }
    await assertNoVideoOutput(obs);
    const original = await identity(obs);
    await audioDisabled(obs, original.sourceUuid);
    if (!valid() || !lease()) throw lost();
    const before = objects(
      (await obs.call('GetSceneItemList', { sceneUuid: original.sceneUuid })).sceneItems,
    );
    if (
      before.some(
        (item) =>
          typeof item.sceneItemId !== 'number' ||
          !Number.isSafeInteger(item.sceneItemId) ||
          item.sceneItemId < 0,
      )
    )
      throw lost();
    const journal: Journal = {
      id: randomUUID(),
      preparationId,
      endpoint,
      ...original,
      itemId: null,
      baselineIds: before.map((item) => item.sceneItemId as number),
      initialTransform: null,
      appliedTransform: null,
      phase: 'creating',
    };
    await this.save(journal, true);
    const current = async () => {
      if (!valid() || !lease()) throw lost();
      await assertNoVideoOutput(obs);
      const latest = await identity(obs);
      if (latest.sceneUuid !== journal.sceneUuid || latest.sourceUuid !== journal.sourceUuid)
        throw lost();
      await audioDisabled(obs, journal.sourceUuid);
      if (!valid() || !lease()) throw lost();
    };
    let createSent = false;
    try {
      await current();
      createSent = true;
      const created = await obs.call('CreateSceneItem', {
        sceneUuid: journal.sceneUuid,
        sourceUuid: journal.sourceUuid,
        sceneItemEnabled: false,
      });
      if (
        typeof created.sceneItemId !== 'number' ||
        !Number.isSafeInteger(created.sceneItemId) ||
        created.sceneItemId < 0 ||
        journal.baselineIds.includes(created.sceneItemId)
      )
        throw lost();
      journal.itemId = created.sceneItemId;
      journal.phase = 'created';
      await this.save(journal);
      await current();
      journal.initialTransform = stableTransform(
        (
          await obs.call('GetSceneItemTransform', {
            sceneUuid: journal.sceneUuid,
            sceneItemId: journal.itemId,
          })
        ).sceneItemTransform,
      );
      if (!journal.initialTransform) throw lost();
      await this.save(journal);
      await current();
      await obs.call('SetSceneItemTransform', {
        sceneUuid: journal.sceneUuid,
        sceneItemId: journal.itemId,
        sceneItemTransform: transform,
      });
      await current();
      const measured = await obs.call('GetSceneItemTransform', {
        sceneUuid: journal.sceneUuid,
        sceneItemId: journal.itemId,
      });
      if (!safeTransform(measured.sceneItemTransform)) throw lost();
      journal.appliedTransform = stableTransform(measured.sceneItemTransform);
      if (!journal.appliedTransform) throw lost();
      const items = objects(
        (await obs.call('GetSceneItemList', { sceneUuid: journal.sceneUuid })).sceneItems,
      );
      if (
        !items.some(
          (item) =>
            item.sceneItemId === journal.itemId &&
            item.sourceUuid === journal.sourceUuid &&
            item.sceneItemEnabled === false,
        )
      )
        throw lost();
      journal.phase = 'transformed';
      await this.save(journal);
      await current();
      const startedAt = Date.now();
      journal.phase = 'enabling';
      await this.save(journal);
      await obs.call('SetSceneItemEnabled', {
        sceneUuid: journal.sceneUuid,
        sceneItemId: journal.itemId,
        sceneItemEnabled: true,
      });
      await current();
      const confirmed = objects(
        (await obs.call('GetSceneItemList', { sceneUuid: journal.sceneUuid })).sceneItems,
      );
      const finalTransform = await obs.call('GetSceneItemTransform', {
        sceneUuid: journal.sceneUuid,
        sceneItemId: journal.itemId,
      });
      if (
        !confirmed.some(
          (item) =>
            item.sceneItemId === journal.itemId &&
            item.sourceUuid === journal.sourceUuid &&
            item.sceneItemEnabled === true,
        ) ||
        !safeTransform(finalTransform.sceneItemTransform)
      )
        throw lost();
      journal.phase = 'enabled';
      await this.save(journal);
      if (!valid() || !lease()) throw lost();
      this.active = { id: journal.id, startedAt, valid: lease };
      return { transactionId: journal.id, startedAt };
    } catch (cause) {
      if (!createSent) {
        await rm(this.path);
        throw cause;
      }
      try {
        if (!lease()) throw lost();
        await this.release(obs, endpoint, journal.id, lease);
      } catch {
        throw error(
          'capture_warmup_pending',
          'OBS 临时采集状态待核对，已保留恢复记录；请在输出停止后重试。',
        );
      }
      throw cause;
    }
  }
  async release(obs: ObsRpc, endpoint: string, id: string, lease: () => boolean): Promise<void> {
    const journal = await this.read();
    if (!journal || journal.id !== id) return;
    if (this.active?.id === id) lease = this.active.valid;
    this.active = undefined;
    if (
      !lease() ||
      endpoint !== journal.endpoint ||
      journal.itemId === null ||
      !['created', 'transformed', 'enabling', 'enabled'].includes(journal.phase)
    )
      throw lost();
    await assertNoVideoOutput(obs);
    const latest = await identity(obs);
    if (latest.sceneUuid !== journal.sceneUuid || latest.sourceUuid !== journal.sourceUuid)
      throw lost();
    const items = objects(
      (await obs.call('GetSceneItemList', { sceneUuid: journal.sceneUuid })).sceneItems,
    );
    const item = items.find((candidate) => candidate.sceneItemId === journal.itemId);
    if (!item) {
      await rm(this.path);
      return;
    }
    if (item.sourceUuid !== journal.sourceUuid || typeof item.sceneItemEnabled !== 'boolean')
      throw lost();
    if (journal.phase === 'created' && item.sceneItemEnabled !== false) throw lost();
    if (journal.phase === 'transformed' && item.sceneItemEnabled !== false) throw lost();
    if (journal.phase === 'enabled' && item.sceneItemEnabled !== true) throw lost();
    let measured = await obs.call('GetSceneItemTransform', {
      sceneUuid: journal.sceneUuid,
      sceneItemId: journal.itemId,
    });
    if (!safeTransform(measured.sceneItemTransform)) {
      if (
        journal.phase !== 'created' ||
        !journal.initialTransform ||
        JSON.stringify(stableTransform(measured.sceneItemTransform)) !==
          JSON.stringify(journal.initialTransform)
      )
        throw lost();
      await audioDisabled(obs, journal.sourceUuid);
      await assertNoVideoOutput(obs);
      if (!lease()) throw lost();
      await obs.call('SetSceneItemTransform', {
        sceneUuid: journal.sceneUuid,
        sceneItemId: journal.itemId,
        sceneItemTransform: transform,
      });
      measured = await obs.call('GetSceneItemTransform', {
        sceneUuid: journal.sceneUuid,
        sceneItemId: journal.itemId,
      });
      if (!safeTransform(measured.sceneItemTransform)) throw lost();
      journal.appliedTransform = stableTransform(measured.sceneItemTransform);
      if (!journal.appliedTransform) throw lost();
      await this.save(journal);
    }
    const expectedTransform =
      journal.appliedTransform ??
      (journal.phase === 'created' && journal.initialTransform
        ? stableTransform({ ...journal.initialTransform, ...transform })
        : null);
    if (
      !expectedTransform ||
      JSON.stringify(stableTransform(measured.sceneItemTransform)) !==
        JSON.stringify(expectedTransform)
    )
      throw lost();
    await assertNoVideoOutput(obs);
    if (!lease()) throw lost();
    await obs.call('RemoveSceneItem', {
      sceneUuid: journal.sceneUuid,
      sceneItemId: journal.itemId,
    });
    await assertNoVideoOutput(obs);
    if (!lease()) throw lost();
    const after = objects(
      (await obs.call('GetSceneItemList', { sceneUuid: journal.sceneUuid })).sceneItems,
    );
    if (after.some((candidate) => candidate.sceneItemId === journal.itemId)) throw lost();
    await rm(this.path);
  }
}

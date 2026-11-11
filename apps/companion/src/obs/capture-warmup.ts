import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { link, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { z } from 'zod';
import { OBS_CAPTURE_INPUT, OBS_COLLECTION, obsSceneName } from './desired-state.js';
import { assertNoVideoOutput } from './video-transaction.js';
import type { ObsRpc } from './reconcile.js';

const journalSchema = z
  .object({
    id: z.string().uuid(),
    preparationId: z.string().uuid(),
    endpoint: z.string().min(1),
    collection: z.enum(['Mizar', OBS_COLLECTION]).optional(),
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
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'ObsCaptureWarmupError';
  }
}
const error = (code: string, message: string, options?: ErrorOptions) =>
  new ObsCaptureWarmupError(code, message, options);
const lost = () =>
  error('capture_warmup_changed', 'OBS 游戏画面检查已中断，请重新检查；仍失败时导出诊断。');
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
async function recoveryIdentity(obs: ObsRpc, journal: Journal): Promise<boolean> {
  const collection = (await obs.call('GetSceneCollectionList')).currentSceneCollectionName;
  if (
    !['Mizar', OBS_COLLECTION].includes(String(collection)) ||
    (journal.collection && collection !== journal.collection)
  )
    return false;
  const scenes = (await obs.call('GetSceneList')).scenes;
  const inputs = (await obs.call('GetInputList')).inputs;
  if (
    !Array.isArray(scenes) ||
    !Array.isArray(inputs) ||
    objects(scenes).length !== scenes.length ||
    objects(inputs).length !== inputs.length ||
    objects(scenes).some((scene) => typeof scene.sceneUuid !== 'string') ||
    objects(inputs).some(
      (input) => typeof input.inputUuid !== 'string' || typeof input.inputKind !== 'string',
    )
  )
    throw lost();
  const source = objects(inputs).find((input) => input.inputUuid === journal.sourceUuid);
  if (source && source.inputKind !== 'game_capture') throw lost();
  if ((await obs.call('GetSceneCollectionList')).currentSceneCollectionName !== collection)
    throw lost();
  return objects(scenes).some((scene) => scene.sceneUuid === journal.sceneUuid) && !!source;
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
  private async archive(journal: Journal, disposition = 'completed'): Promise<void> {
    const archived = `${this.path}.${disposition}-${journal.id}.json`;
    if (!isDeepStrictEqual(await this.read(), journal)) throw lost();
    try {
      await link(this.path, archived);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== 'EEXIST') throw cause;
    }
    if (
      !isDeepStrictEqual(JSON.parse(await readFile(archived, 'utf8')), journal) ||
      !isDeepStrictEqual(await this.read(), journal)
    )
      throw lost();
    await rm(this.path);
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
  /** Detached records retain recovery duties when a new collection starts its own warmup. */
  private async detached(): Promise<ObsCaptureWarmup[]> {
    const files = await readdir(dirname(this.path)).catch((cause: NodeJS.ErrnoException) => {
      if (cause.code === 'ENOENT') return [];
      throw cause;
    });
    const prefix = `${basename(this.path)}.detached-`;
    return files
      .filter(
        (name) =>
          name.startsWith(prefix) &&
          name.endsWith('.json') &&
          z.string().uuid().safeParse(name.slice(prefix.length, -5)).success,
      )
      .map((name) => new ObsCaptureWarmup(join(dirname(this.path), name)));
  }
  async status(): Promise<'checking' | 'cleanup_pending' | null> {
    const journal = await this.read();
    if (journal && this.active?.id === journal.id && this.active.valid()) return 'checking';
    return journal || (await this.detached()).length ? 'cleanup_pending' : null;
  }
  /** Only the exact current collection graph can still contain this temporary item. */
  async affectsCurrentCollection(obs: ObsRpc, endpoint: string): Promise<boolean> {
    for (const owner of [this, ...(await this.detached())]) {
      const journal = await owner.read();
      if (journal && journal.endpoint === endpoint && (await recoveryIdentity(obs, journal)))
        return true;
    }
    return false;
  }
  async recoverCurrentCollection(
    obs: ObsRpc,
    endpoint: string,
    lease: () => boolean,
  ): Promise<void> {
    for (const owner of [this, ...(await this.detached())]) {
      const journal = await owner.read();
      if (journal && journal.endpoint === endpoint && (await recoveryIdentity(obs, journal)))
        await owner.recoverBeforePreparation(obs, endpoint, lease);
    }
  }
  async pending(id: string): Promise<boolean> {
    for (const owner of [this, ...(await this.detached())])
      if ((await owner.read())?.id === id) return true;
    return false;
  }
  async matches(id: string, since: number): Promise<boolean> {
    return this.active?.id === id && this.active.startedAt === since && (await this.pending(id));
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
  /** Settle the previous warmup before changing its shared capture source. */
  private async recoverBeforePreparation(
    obs: ObsRpc,
    endpoint: string,
    lease: () => boolean,
  ): Promise<void> {
    if (!lease()) throw lost();
    const previous = await this.read();
    if (!previous) return;
    if (this.active?.id === previous.id && this.active.valid())
      throw error('capture_warmup_busy', '正在检查 OBS 游戏画面，请等待检查完成。');
    this.active = undefined;
    if (endpoint !== previous.endpoint) throw lost();
    await this.release(obs, endpoint, previous.id, lease);
  }
  async begin(
    obs: ObsRpc,
    endpoint: string,
    preparationId: string,
    valid: () => boolean,
    lease: () => boolean,
  ): Promise<{ transactionId: string; startedAt: number }> {
    if (!valid() || !lease()) throw lost();
    await this.recoverCurrentCollection(obs, endpoint, lease);
    await assertNoVideoOutput(obs);
    const original = await identity(obs);
    const detached = await this.read();
    if (detached) {
      if (!lease() || (await this.affectsCurrentCollection(obs, endpoint))) throw lost();
      // Keep unresolved evidence for its original collection; it owns no item here.
      await this.archive(detached, 'detached');
    }
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
      collection: OBS_COLLECTION,
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
      // A missing create receipt is reconciled only by a later explicit recovery.
      // The current RPC may still complete after its response is lost.
      if (journal.phase === 'creating' && journal.itemId === null)
        throw error('capture_warmup_pending', 'OBS 游戏画面检查未完成，请在输出停止后重新检查。', {
          cause,
        });
      try {
        if (!lease()) throw lost();
        await this.release(obs, endpoint, journal.id, lease);
      } catch (recovery) {
        throw error('capture_warmup_pending', 'OBS 游戏画面检查未完成，请在输出停止后重新检查。', {
          cause: new AggregateError([cause, recovery], 'Capture warmup and cleanup failed'),
        });
      }
      throw cause;
    }
  }
  async release(obs: ObsRpc, endpoint: string, id: string, lease: () => boolean): Promise<void> {
    const journal = await this.read();
    if (!journal || journal.id !== id) {
      for (const owner of await this.detached())
        if ((await owner.read())?.id === id) await owner.release(obs, endpoint, id, lease);
      return;
    }
    if (this.active?.id === id && this.active.valid()) lease = this.active.valid;
    this.active = undefined;
    if (!lease() || endpoint !== journal.endpoint) throw lost();
    await assertNoVideoOutput(obs);
    // Reclaim the item we own without requiring its scene to remain on air.
    if (!(await recoveryIdentity(obs, journal))) throw lost();
    const items = objects(
      (await obs.call('GetSceneItemList', { sceneUuid: journal.sceneUuid })).sceneItems,
    );
    if (journal.phase === 'creating' && journal.itemId === null) {
      // CreateSceneItem was sent disabled. Its response may have been lost, so a
      // new item cannot safely be identified as ours and must never be deleted.
      // Once every possible new matching item is disabled, abandoning this
      // journal is safe even if OBS eventually completes that disabled create.
      const unsafeCandidate = items.some(
        (item) =>
          typeof item.sceneItemId !== 'number' ||
          typeof item.sourceUuid !== 'string' ||
          (item.sourceUuid === journal.sourceUuid &&
            !journal.baselineIds.includes(item.sceneItemId) &&
            item.sceneItemEnabled !== false),
      );
      if (unsafeCandidate)
        throw error(
          'capture_warmup_ownership_unknown',
          '无法确认临时游戏来源归属。请在 OBS 等待场景中禁用或移除新增的游戏来源后重试。',
        );
      await assertNoVideoOutput(obs);
      if (!lease()) throw lost();
      await rm(this.path);
      return;
    }
    if (
      journal.itemId === null ||
      !['created', 'transformed', 'enabling', 'enabled'].includes(journal.phase)
    )
      throw lost();
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

import { randomUUID } from 'node:crypto';
import { link, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';
import type { ObsRpc } from './reconcile.js';

const item = z
  .object({
    sceneName: z.string().min(1),
    sceneItemId: z.number().int(),
    sourceUuid: z.string().min(1),
  })
  .strict();
const transaction = z
  .object({
    endpoint: z.string().min(1),
    collection: z.string().min(1),
    desktop: z.array(item).min(1),
    independent: z.array(item).min(1),
  })
  .strict();
export type AudioMigrationPlan = z.infer<typeof transaction>;

/** Durable rollback primitive. A caller must independently prove template ownership and mix safety. */
export class AudioMigration {
  constructor(private readonly path: string) {}
  private async save(value: AudioMigrationPlan) {
    await mkdir(dirname(this.path), { recursive: true });
    const temp = `${this.path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temp, `${JSON.stringify(value)}\n`, { mode: 0o600 });
      await link(temp, this.path);
    } finally {
      await rm(temp, { force: true });
    }
  }
  private async read(): Promise<AudioMigrationPlan | null> {
    try {
      return transaction.parse(JSON.parse(await readFile(this.path, 'utf8')));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }
  private async context(obs: ObsRpc, plan: AudioMigrationPlan, endpoint: string) {
    const [stream, record, collection] = await Promise.all([
      obs.call('GetStreamStatus'),
      obs.call('GetRecordStatus'),
      obs.call('GetSceneCollectionList'),
    ]);
    if (
      endpoint !== plan.endpoint ||
      collection.currentSceneCollectionName !== plan.collection ||
      stream.outputActive !== false ||
      record.outputActive !== false
    )
      throw new Error('audio_migration_context_changed');
  }
  private async status(obs: ObsRpc, ref: z.infer<typeof item>): Promise<boolean> {
    const raw = (await obs.call('GetSceneItemList', { sceneName: ref.sceneName })).sceneItems;
    if (!Array.isArray(raw)) throw new Error('audio_migration_items_unknown');
    const found = raw.find(
      (value: unknown) =>
        typeof value === 'object' &&
        value !== null &&
        (value as Record<string, unknown>).sceneItemId === ref.sceneItemId,
    ) as Record<string, unknown> | undefined;
    if (
      !found ||
      found.sourceUuid !== ref.sourceUuid ||
      typeof found.sceneItemEnabled !== 'boolean'
    )
      throw new Error('audio_migration_item_changed');
    return found.sceneItemEnabled;
  }
  private async change(
    obs: ObsRpc,
    plan: AudioMigrationPlan,
    endpoint: string,
    ref: z.infer<typeof item>,
    enabled: boolean,
  ) {
    await this.context(obs, plan, endpoint);
    if ((await this.status(obs, ref)) === enabled) return;
    await obs.call('SetSceneItemEnabled', {
      sceneName: ref.sceneName,
      sceneItemId: ref.sceneItemId,
      sceneItemEnabled: enabled,
    });
    if ((await this.status(obs, ref)) !== enabled)
      throw new Error('audio_migration_write_unconfirmed');
  }
  /** Restore old audio first; only then disable any new paths. */
  async recover(obs: ObsRpc, endpoint: string): Promise<boolean> {
    const plan = await this.read();
    if (!plan) return false;
    await this.context(obs, plan, endpoint);
    for (const ref of plan.desktop) await this.change(obs, plan, endpoint, ref, true);
    for (const ref of plan.independent) await this.change(obs, plan, endpoint, ref, false);
    await rm(this.path);
    return true;
  }
  /** Run only after all source identities, settings and the entire legacy structure have been proved. */
  async migrate(obs: ObsRpc, endpoint: string, raw: AudioMigrationPlan): Promise<void> {
    const plan = transaction.parse(raw);
    if (await this.read()) throw new Error('audio_migration_recovery_required');
    await this.context(obs, plan, endpoint);
    const ids = [...plan.desktop, ...plan.independent].map(
      (ref) => `${ref.sceneName}\0${ref.sceneItemId}`,
    );
    if (new Set(ids).size !== ids.length) throw new Error('audio_migration_duplicate');
    for (const ref of plan.desktop)
      if (!(await this.status(obs, ref))) throw new Error('audio_migration_desktop_changed');
    for (const ref of plan.independent)
      if (await this.status(obs, ref)) throw new Error('audio_migration_independent_changed');
    await this.save(plan);
    try {
      for (const ref of plan.desktop) await this.change(obs, plan, endpoint, ref, false);
      for (const ref of plan.independent) await this.change(obs, plan, endpoint, ref, true);
      await rm(this.path);
    } catch (error) {
      try {
        await this.recover(obs, endpoint);
      } catch {
        /* Leave the journal for an idle retry. */
      }
      throw error;
    }
  }
}

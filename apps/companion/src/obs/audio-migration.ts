import { randomUUID } from 'node:crypto';
import { link, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';
import type { ObsRpc } from './reconcile.js';

const ref = z
  .object({
    sceneName: z.string().min(1),
    sceneItemId: z.number().int(),
    sourceUuid: z.string().min(1),
  })
  .strict();
const field = ref
  .extend({
    before: z.boolean(),
    applied: z.boolean(),
    phase: z.enum(['prepared', 'sent', 'confirmed', 'uncertain', 'restored']),
    externalChanged: z.boolean(),
  })
  .strict();
const planSchema = z
  .object({
    endpoint: z.string().min(1),
    collection: z.string().min(1),
    desktop: z.array(ref).min(1),
    independent: z.array(ref).min(1),
  })
  .strict();
const journalSchema = z
  .object({ endpoint: z.string(), collection: z.string(), fields: z.array(field) })
  .strict();
export type AudioMigrationPlan = z.infer<typeof planSchema>;
type Field = z.infer<typeof field>;
type Journal = z.infer<typeof journalSchema>;
export type MigrationEvent =
  | { type: 'item'; sceneName: string; sceneItemId: number; enabled: boolean }
  | { type: 'outputStarting' }
  | { type: 'identityChanged' }
  | { type: 'disconnected' };
/** Events must cover output start, item enable changes, input/settings removal, collection and connection changes on the same connection used for RPCs. */
export interface MigrationObserver {
  subscribe(listener: (event: MigrationEvent) => void): () => void;
}

/** A transaction is never resumed from disk while output is active or after observation is lost. */
export class AudioMigration {
  private running = false;
  constructor(private readonly path: string) {}
  private async create(value: Journal) {
    await mkdir(dirname(this.path), { recursive: true });
    const temp = `${this.path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temp, `${JSON.stringify(value)}\n`, { mode: 0o600 });
      await link(temp, this.path);
    } finally {
      await rm(temp, { force: true });
    }
  }
  private async save(value: Journal) {
    const temp = `${this.path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temp, `${JSON.stringify(value)}\n`, { mode: 0o600 });
      await rename(temp, this.path);
    } finally {
      await rm(temp, { force: true });
    }
  }
  async pending(): Promise<Journal | null> {
    try {
      return journalSchema.parse(JSON.parse(await readFile(this.path, 'utf8')));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }
  private async context(obs: ObsRpc, plan: AudioMigrationPlan, endpoint: string, idle: boolean) {
    const [stream, record, collection] = await Promise.all([
      obs.call('GetStreamStatus'),
      obs.call('GetRecordStatus'),
      obs.call('GetSceneCollectionList'),
    ]);
    if (endpoint !== plan.endpoint || collection.currentSceneCollectionName !== plan.collection)
      throw new Error('audio_migration_identity_changed');
    if (idle && (stream.outputActive !== false || record.outputActive !== false))
      throw new Error('audio_migration_output_active');
  }
  private async status(obs: ObsRpc, entry: Field): Promise<boolean> {
    const raw = (await obs.call('GetSceneItemList', { sceneName: entry.sceneName })).sceneItems;
    if (!Array.isArray(raw)) throw new Error('audio_migration_items_unknown');
    const found = raw.find(
      (value: unknown) =>
        typeof value === 'object' &&
        value !== null &&
        (value as Record<string, unknown>).sceneItemId === entry.sceneItemId,
    ) as Record<string, unknown> | undefined;
    if (
      !found ||
      found.sourceUuid !== entry.sourceUuid ||
      typeof found.sceneItemEnabled !== 'boolean'
    )
      throw new Error('audio_migration_identity_changed');
    return found.sceneItemEnabled;
  }
  async migrate(
    obs: ObsRpc,
    endpoint: string,
    raw: AudioMigrationPlan,
    observer: MigrationObserver,
  ): Promise<void> {
    if (this.running) throw new Error('audio_migration_busy');
    const plan = planSchema.parse(raw);
    this.running = true;
    const ids = [...plan.desktop, ...plan.independent].map(
      (x) => `${x.sceneName}\0${x.sceneItemId}`,
    );
    if (new Set(ids).size !== ids.length) {
      this.running = false;
      throw new Error('audio_migration_duplicate');
    }
    const journal: Journal = {
      endpoint: plan.endpoint,
      collection: plan.collection,
      fields: [
        ...plan.independent.map((x) => ({
          ...x,
          before: false,
          applied: true,
          phase: 'prepared' as const,
          externalChanged: false,
        })),
        ...plan.desktop.map((x) => ({
          ...x,
          before: true,
          applied: false,
          phase: 'prepared' as const,
          externalChanged: false,
        })),
      ],
    };
    let connected = true;
    let identity = true;
    let output = false;
    let expected: { entry: Field; value: boolean; seen: boolean } | undefined;
    let persistence: Promise<void> = Promise.resolve();
    let created = false;
    let wake: (() => void) | undefined;
    const changed = () => {
      if (created) persistence = persistence.then(() => this.save(journal));
    };
    const unsubscribe = observer.subscribe((event) => {
      if (event.type === 'disconnected') {
        connected = false;
        wake?.();
      } else if (event.type === 'identityChanged') {
        identity = false;
        wake?.();
      } else if (event.type === 'outputStarting') output = true;
      else {
        const entry = journal.fields.find(
          (x) => x.sceneName === event.sceneName && x.sceneItemId === event.sceneItemId,
        );
        if (!entry) return;
        if (expected?.entry === entry && !expected.seen && event.enabled === expected.value)
          expected.seen = true;
        else {
          entry.externalChanged = true;
          changed();
        }
      }
    });
    const flush = async () => {
      await persistence;
    };
    const available = () => connected && identity;
    const verify = async (idle: boolean) => {
      await flush();
      if (!available()) throw new Error('audio_migration_observation_lost');
      await this.context(obs, plan, endpoint, idle);
      if (!available()) throw new Error('audio_migration_observation_lost');
    };
    const send = async (
      entry: Field,
      value: boolean,
      phase: 'sent' | 'restored',
      idle: boolean,
    ) => {
      await verify(idle);
      if (entry.externalChanged) throw new Error('audio_migration_external_change');
      const wantedBefore = phase === 'sent' ? entry.before : entry.applied;
      if ((await this.status(obs, entry)) !== wantedBefore) {
        entry.externalChanged = true;
        changed();
        await flush();
        throw new Error('audio_migration_external_change');
      }
      if (phase === 'sent') {
        entry.phase = 'sent';
        changed();
        await flush();
      }
      if (!available() || entry.externalChanged || (idle && output)) {
        if (phase === 'sent') {
          entry.phase = 'prepared';
          changed();
          await flush();
        }
        throw new Error('audio_migration_interrupted');
      }
      expected = { entry, value, seen: false };
      const interrupted = new Promise<'lost'>((resolve) => {
        wake = () => resolve('lost');
      });
      const call = obs.call('SetSceneItemEnabled', {
        sceneName: entry.sceneName,
        sceneItemId: entry.sceneItemId,
        sceneItemEnabled: value,
      });
      const result = await Promise.race([
        call.then(
          () => 'ok' as const,
          () => 'failed' as const,
        ),
        interrupted,
      ]);
      wake = undefined;
      if (result !== 'ok') {
        entry.phase = 'uncertain';
        changed();
        await flush();
        // A failed or interrupted request might still be applied later; do not compensate it.
        throw new Error('audio_migration_write_uncertain');
      }
      await verify(false);
      if ((await this.status(obs, entry)) !== value) {
        entry.phase = 'uncertain';
        changed();
        await flush();
        throw new Error('audio_migration_write_uncertain');
      }
      entry.phase = phase === 'sent' ? 'confirmed' : 'restored';
      changed();
      await flush();
      expected = undefined;
      if (entry.externalChanged) throw new Error('audio_migration_external_change');
    };
    try {
      if (await this.pending()) throw new Error('audio_migration_recovery_required');
      await verify(true);
      for (const entry of journal.fields)
        if ((await this.status(obs, entry)) !== entry.before)
          throw new Error('audio_migration_precondition_changed');
      await this.create(journal);
      created = true;
      for (const entry of journal.fields) {
        if (output) throw new Error('audio_migration_output_started');
        await send(entry, entry.applied, 'sent', true);
        if (output) throw new Error('audio_migration_output_started');
      }
      await verify(false);
      if (output) throw new Error('audio_migration_output_started');
      if (journal.fields.some((entry) => entry.externalChanged))
        throw new Error('audio_migration_external_change');
      unsubscribe();
      await rm(this.path);
      created = false;
    } catch (error) {
      await flush();
      if (created && available() && !journal.fields.some((x) => x.phase === 'uncertain')) {
        try {
          // Restore old paths before closing any newly enabled path.
          for (const entry of journal.fields.filter((x) => x.before && x.phase === 'confirmed'))
            await send(entry, entry.before, 'restored', false);
          for (const entry of journal.fields.filter((x) => !x.before && x.phase === 'confirmed'))
            await send(entry, entry.before, 'restored', false);
          if (journal.fields.every((x) => x.phase === 'prepared' || x.phase === 'restored')) {
            await rm(this.path);
            created = false;
          }
        } catch {
          /* Preserve the journal and any possible remaining audio for review. */
        }
      }
      throw error;
    } finally {
      unsubscribe();
      await flush();
      this.running = false;
    }
  }
}

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
    group: z.boolean().optional(),
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
const inputRef = z
  .object({ inputUuid: z.string().min(1), inputKind: z.enum(['game_capture', 'window_capture']) })
  .strict();
const inputField = inputRef
  .extend({
    before: z.boolean(),
    applied: z.boolean(),
    phase: z.enum(['prepared', 'sent', 'confirmed', 'uncertain', 'restored']),
    externalChanged: z.boolean(),
  })
  .strict();
const monitorMode = z.enum([
  'OBS_MONITORING_TYPE_NONE',
  'OBS_MONITORING_TYPE_MONITOR_ONLY',
  'OBS_MONITORING_TYPE_MONITOR_AND_OUTPUT',
]);
const monitorRef = z
  .object({
    kind: z.literal('monitor'),
    inputUuid: z.string().min(1),
    before: monitorMode,
    applied: monitorMode,
  })
  .strict();
const monitorField = monitorRef
  .extend({
    phase: z.enum(['prepared', 'sent', 'confirmed', 'uncertain', 'restored']),
    externalChanged: z.boolean(),
  })
  .strict();
export type AudioMonitorChange = z.infer<typeof monitorRef>;
type Value = boolean | z.infer<typeof monitorMode>;
function active(value: Value): boolean {
  return value === true || value === 'OBS_MONITORING_TYPE_MONITOR_AND_OUTPUT';
}
const planSchema = z
  .object({
    endpoint: z.string().min(1),
    collection: z.string().min(1),
    desktop: z.array(ref),
    independent: z.array(ref),
    monitor: z.array(monitorRef).default([]),
    captureAudio: z
      .array(inputRef.extend({ before: z.boolean(), applied: z.boolean() }).strict())
      .default([]),
  })
  .strict();
const journalSchema = z
  .object({
    endpoint: z.string(),
    collection: z.string(),
    modeId: z.string().uuid().optional(),
    fields: z.array(z.union([field, inputField, monitorField])),
  })
  .strict();
export type AudioMigrationPlan = z.input<typeof planSchema>;
type Field = z.infer<typeof field> | z.infer<typeof inputField> | z.infer<typeof monitorField>;
type Journal = z.infer<typeof journalSchema>;
export type MigrationEvent =
  | { type: 'item'; sceneName: string; sceneItemId: number; enabled: boolean }
  | { type: 'monitor'; inputUuid: string; monitorType: string }
  | { type: 'inputSettings'; inputUuid: string; settings: Record<string, unknown> }
  | { type: 'outputStarting' }
  | { type: 'programChanged' }
  | { type: 'identityChanged' }
  | { type: 'disconnected' };
/** Events must cover output start, item enable changes, input/settings removal, collection and connection changes on the same connection used for RPCs. */
export interface MigrationObserver {
  subscribe(listener: (event: MigrationEvent) => void): () => void;
}

/** Mode changes may run during output; initialization still requires idle output. */
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
    return this.readJournal(this.path);
  }
  private async readJournal(path: string): Promise<Journal | null> {
    try {
      return journalSchema.parse(JSON.parse(await readFile(path, 'utf8')));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }
  /** Read back a mode journal without replaying any write. */
  async inspectMode(
    obs: ObsRpc,
    endpoint: string,
    observer: MigrationObserver,
    modeId: string,
  ): Promise<'applied' | 'before' | 'mixed'> {
    const journal = await this.pending();
    if (!journal || journal.modeId !== modeId) throw new Error('audio_migration_mode_mismatch');
    if (journal.fields.some((entry) => entry.externalChanged || entry.before === entry.applied))
      throw new Error('audio_migration_external_change');
    let changed = false;
    const stop = observer.subscribe(() => {
      changed = true;
    });
    try {
      const plan = {
        endpoint: journal.endpoint,
        collection: journal.collection,
        desktop: [],
        independent: [],
      };
      await this.context(obs, plan, endpoint, false);
      const first = await Promise.all(journal.fields.map((entry) => this.status(obs, entry)));
      const second = await Promise.all(journal.fields.map((entry) => this.status(obs, entry)));
      await this.context(obs, plan, endpoint, false);
      if (
        changed ||
        first.some((value, index) => {
          const entry = journal.fields[index]!;
          return (
            value !== second[index] ||
            (value !== entry.before && value !== entry.applied) ||
            (['prepared', 'restored'].includes(entry.phase) && value !== entry.before) ||
            (entry.phase === 'confirmed' && value !== entry.applied)
          );
        })
      )
        throw new Error('audio_migration_external_change');
      if (journal.fields.every((entry, index) => first[index] === entry.applied)) {
        for (const entry of journal.fields) entry.phase = 'confirmed';
        await this.save(journal);
        if (changed) throw new Error('audio_migration_external_change');
        return 'applied';
      }
      return journal.fields.every((entry, index) => first[index] === entry.before)
        ? 'before'
        : 'mixed';
    } finally {
      stop();
    }
  }
  async saveModeBackup(completedPath: string, modeId: string): Promise<void> {
    const journal = await this.pending();
    if (
      !journal ||
      journal.modeId !== modeId ||
      journal.fields.some((entry) => entry.phase !== 'confirmed' || entry.externalChanged)
    )
      throw new Error('audio_migration_mode_mismatch');
    try {
      await link(this.path, completedPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const existing = await this.readJournal(completedPath);
      if (
        !existing ||
        existing.modeId !== modeId ||
        JSON.stringify(existing) !== JSON.stringify(journal)
      )
        throw new Error('audio_migration_backup_conflict', { cause: error });
    }
  }
  async clearMode(modeId: string): Promise<void> {
    const journal = await this.pending();
    if (!journal) return;
    if (journal.modeId !== modeId) throw new Error('audio_migration_mode_mismatch');
    await rm(this.path);
  }
  async clearModeBackup(completedPath: string, modeId?: string): Promise<void> {
    const journal = await this.readJournal(completedPath);
    if (!journal) return;
    if (modeId && journal.modeId !== modeId) return;
    await rm(completedPath);
  }
  /** Restore a completed switch only while every recorded item still has the
   * value written by that switch. The ordinary migration journal protects the
   * reverse operation itself if its outcome becomes uncertain. */
  async restoreCompleted(
    obs: ObsRpc,
    endpoint: string,
    observer: MigrationObserver,
    completedPath: string,
    extraMonitor: AudioMonitorChange[] = [],
    modeId?: string,
  ): Promise<boolean> {
    const completed = await this.readJournal(completedPath);
    if (!completed) return false;
    if (
      completed.endpoint !== endpoint ||
      completed.fields.some((entry) => entry.externalChanged || entry.phase !== 'confirmed')
    )
      throw new Error('audio_migration_external_change');
    await this.context(
      obs,
      {
        endpoint: completed.endpoint,
        collection: completed.collection,
        desktop: [],
        independent: [],
      },
      endpoint,
      !modeId,
    );
    const values = await Promise.all(completed.fields.map((entry) => this.status(obs, entry)));
    await this.context(
      obs,
      {
        endpoint: completed.endpoint,
        collection: completed.collection,
        desktop: [],
        independent: [],
      },
      endpoint,
      !modeId,
    );
    // A crash may occur after all reverse writes but before the mode commit.
    // Retain the record until that commit so a retry can recognize this state.
    const alreadyRestored = completed.fields.every(
      (entry, index) => values[index] === entry.before,
    );
    if (modeId && alreadyRestored && completed.fields.length)
      throw new Error('audio_migration_external_change');
    if (
      !alreadyRestored &&
      completed.fields.some((entry, index) => values[index] !== entry.applied)
    )
      throw new Error('audio_migration_external_change');
    const desktop: AudioMigrationPlan['desktop'] = [];
    const captureAudio: NonNullable<AudioMigrationPlan['captureAudio']> = [];
    const monitor: NonNullable<AudioMigrationPlan['monitor']> = extraMonitor.filter(
      (extra) =>
        !completed.fields.some((entry) => 'kind' in entry && entry.inputUuid === extra.inputUuid),
    );
    const independent: AudioMigrationPlan['independent'] = [];
    for (const entry of alreadyRestored ? [] : completed.fields) {
      if ('kind' in entry) {
        monitor.push({
          kind: 'monitor',
          inputUuid: entry.inputUuid,
          before: entry.applied,
          applied: entry.before,
        });
        continue;
      }
      if ('inputUuid' in entry) {
        captureAudio.push({
          inputUuid: entry.inputUuid,
          inputKind: entry.inputKind,
          before: entry.applied,
          applied: entry.before,
        });
        continue;
      }
      const ref = {
        sceneName: entry.sceneName,
        sceneItemId: entry.sceneItemId,
        sourceUuid: entry.sourceUuid,
        ...(entry.group === undefined ? {} : { group: entry.group }),
      };
      (entry.before ? independent : desktop).push(ref);
    }
    if (
      !modeId &&
      !desktop.length &&
      !independent.length &&
      !captureAudio.length &&
      !monitor.length
    )
      return true;
    await this.migrate(
      obs,
      endpoint,
      {
        endpoint: completed.endpoint,
        collection: completed.collection,
        desktop,
        independent,
        captureAudio,
        monitor,
      },
      observer,
      undefined,
      modeId,
    );
    return true;
  }
  private async context(obs: ObsRpc, plan: AudioMigrationPlan, endpoint: string, idle: boolean) {
    const [stream, record, collection] = await Promise.all([
      obs.call('GetStreamStatus'),
      obs.call('GetRecordStatus'),
      obs.call('GetSceneCollectionList'),
    ]);
    if (endpoint !== plan.endpoint || collection.currentSceneCollectionName !== plan.collection)
      throw new Error('audio_migration_identity_changed');
    if (typeof stream.outputActive !== 'boolean' || typeof record.outputActive !== 'boolean')
      throw new Error('audio_migration_output_unknown');
    if (idle && (stream.outputActive !== false || record.outputActive !== false))
      throw new Error('audio_migration_output_active');
  }
  private async status(obs: ObsRpc, entry: Field): Promise<Value> {
    if ('kind' in entry) {
      const result = await obs.call('GetInputAudioMonitorType', { inputUuid: entry.inputUuid });
      const parsed = monitorMode.safeParse(result.monitorType);
      if (!parsed.success) throw new Error('audio_migration_identity_changed');
      return parsed.data;
    }
    if ('inputUuid' in entry) {
      const result = await obs.call('GetInputSettings', { inputUuid: entry.inputUuid });
      const settings = result.inputSettings as Record<string, unknown> | undefined;
      if (result.inputKind !== entry.inputKind || typeof settings?.capture_audio !== 'boolean')
        throw new Error('audio_migration_identity_changed');
      return settings.capture_audio;
    }
    const raw = (
      await obs.call(entry.group ? 'GetGroupSceneItemList' : 'GetSceneItemList', {
        sceneName: entry.sceneName,
      })
    ).sceneItems;
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
  private matchesIdentity(event: MigrationEvent, entry: Field): boolean {
    return 'kind' in entry
      ? event.type === 'monitor' && event.inputUuid === entry.inputUuid
      : 'inputUuid' in entry
        ? event.type === 'inputSettings' && event.inputUuid === entry.inputUuid
        : event.type === 'item' &&
          event.sceneName === entry.sceneName &&
          event.sceneItemId === entry.sceneItemId;
  }
  private matches(event: MigrationEvent, entry: Field, value: Value): boolean {
    return (
      this.matchesIdentity(event, entry) &&
      (event.type === 'item'
        ? event.enabled === value
        : event.type === 'inputSettings'
          ? event.settings.capture_audio === value
          : event.type === 'monitor' && event.monitorType === value)
    );
  }
  private write(obs: ObsRpc, entry: Field, value: Value) {
    return 'kind' in entry
      ? obs.call('SetInputAudioMonitorType', { inputUuid: entry.inputUuid, monitorType: value })
      : 'inputUuid' in entry
        ? obs.call('SetInputSettings', {
            inputUuid: entry.inputUuid,
            inputSettings: { capture_audio: value },
            overlay: true,
          })
        : obs.call('SetSceneItemEnabled', {
            sceneName: entry.sceneName,
            sceneItemId: entry.sceneItemId,
            sceneItemEnabled: value,
          });
  }
  /** Recheck an interrupted transaction on a new observed connection and restore
   * its recorded pre-switch references before allowing another migration. */
  async recover(
    obs: ObsRpc,
    endpoint: string,
    observer: MigrationObserver,
    retain = false,
  ): Promise<void> {
    if (this.running) throw new Error('audio_migration_busy');
    this.running = true;
    let interrupted = false;
    let expected: { entry: Field; value: Value; seen: boolean } | undefined;
    const stop = observer.subscribe((event) => {
      if (expected && !expected.seen && this.matches(event, expected.entry, expected.value)) {
        expected.seen = true;
      } else if (!(retain && event.type === 'outputStarting')) interrupted = true;
    });
    try {
      const journal = await this.pending();
      if (!journal) return;
      if (journal.fields.some((entry) => entry.externalChanged || entry.before === entry.applied))
        throw new Error('audio_migration_external_change');
      const keys = journal.fields.map((entry) =>
        'kind' in entry
          ? `monitor\0${entry.inputUuid}`
          : 'inputUuid' in entry
            ? `input\0${entry.inputUuid}`
            : `item\0${entry.sceneName}\0${entry.sceneItemId}`,
      );
      if (new Set(keys).size !== keys.length) throw new Error('audio_migration_duplicate');
      const plan = {
        endpoint: journal.endpoint,
        collection: journal.collection,
        desktop: [],
        independent: [],
      };
      const check = async () => {
        if (interrupted) throw new Error('audio_migration_observation_lost');
        await this.context(obs, plan, endpoint, !retain);
        if (interrupted) throw new Error('audio_migration_observation_lost');
      };
      await check();
      const initial = await Promise.all(journal.fields.map((entry) => this.status(obs, entry)));
      await check();
      const confirmed = await Promise.all(journal.fields.map((entry) => this.status(obs, entry)));
      if (
        initial.some(
          (value, index) =>
            value !== confirmed[index] ||
            (value !== journal.fields[index]!.before && value !== journal.fields[index]!.applied) ||
            (['prepared', 'restored'].includes(journal.fields[index]!.phase) &&
              value !== journal.fields[index]!.before) ||
            (journal.fields[index]!.phase === 'confirmed' &&
              value !== journal.fields[index]!.applied),
        )
      )
        throw new Error('audio_migration_external_change');
      await check();
      // Close paths added by the interrupted switch before reopening the previous paths.
      for (const entry of [...journal.fields].sort(
        (a, b) => Number(active(a.before)) - Number(active(b.before)),
      )) {
        await check();
        const current = await this.status(obs, entry);
        if (current !== entry.before) {
          entry.phase = 'uncertain';
          await this.save(journal);
          await check();
          expected = { entry, value: entry.before, seen: false };
          await this.write(obs, entry, entry.before);
          await check();
          if ((await this.status(obs, entry)) !== entry.before)
            throw new Error('audio_migration_write_uncertain');
          expected = undefined;
        }
        entry.phase = 'restored';
        await this.save(journal);
      }
      await check();
      for (const entry of journal.fields)
        if ((await this.status(obs, entry)) !== entry.before)
          throw new Error('audio_migration_external_change');
      await check();
      stop();
      if (!retain) await rename(this.path, `${this.path}.recovered-${randomUUID()}.json`);
    } finally {
      stop();
      this.running = false;
    }
  }
  async migrate(
    obs: ObsRpc,
    endpoint: string,
    raw: AudioMigrationPlan,
    observer: MigrationObserver,
    completedPath?: string,
    modeId?: string,
  ): Promise<void> {
    if (this.running) throw new Error('audio_migration_busy');
    const plan = planSchema.parse(raw);
    this.running = true;
    const ids = [...plan.desktop, ...plan.independent]
      .map((x) => `item\0${x.sceneName}\0${x.sceneItemId}`)
      .concat((plan.captureAudio ?? []).map((x) => `input\0${x.inputUuid}`))
      .concat((plan.monitor ?? []).map((x) => `monitor\0${x.inputUuid}`));
    if (
      [...(plan.captureAudio ?? []), ...(plan.monitor ?? [])].some(
        (entry) => entry.before === entry.applied,
      )
    ) {
      this.running = false;
      throw new Error('audio_migration_invalid_field');
    }
    if (new Set(ids).size !== ids.length) {
      this.running = false;
      throw new Error('audio_migration_duplicate');
    }
    const journal: Journal = {
      endpoint: plan.endpoint,
      collection: plan.collection,
      ...(modeId ? { modeId } : {}),
      fields: [
        ...(plan.monitor ?? []).map((x) => ({
          ...x,
          phase: 'prepared' as const,
          externalChanged: false,
        })),
        ...(plan.captureAudio ?? []).map((x) => ({
          ...x,
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
        ...plan.independent.map((x) => ({
          ...x,
          before: false,
          applied: true,
          phase: 'prepared' as const,
          externalChanged: false,
        })),
      ].sort((a, b) => Number(active(a.applied)) - Number(active(b.applied))),
    };
    let connected = true;
    let identity = true;
    let output = false;
    let expected: { entry: Field; value: Value; seen: boolean } | undefined;
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
      } else if (event.type === 'identityChanged' || event.type === 'programChanged') {
        identity = false;
        wake?.();
      } else if (event.type === 'outputStarting') output = true;
      else {
        const entry = journal.fields.find((x) => this.matchesIdentity(event, x));
        if (!entry) {
          if (event.type === 'inputSettings' || event.type === 'monitor') {
            identity = false;
            wake?.();
          }
          return;
        }
        if (
          expected?.entry === entry &&
          !expected.seen &&
          this.matches(event, entry, expected.value)
        )
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
      await this.context(obs, plan, endpoint, idle && !modeId);
      if (!available()) throw new Error('audio_migration_observation_lost');
    };
    const send = async (entry: Field, value: Value, phase: 'sent' | 'restored', idle: boolean) => {
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
      if (!available() || entry.externalChanged || (idle && output && !modeId)) {
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
      const call = this.write(obs, entry, value);
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
        if (output && !modeId) throw new Error('audio_migration_output_started');
        await send(entry, entry.applied, 'sent', true);
        if (output && !modeId) throw new Error('audio_migration_output_started');
      }
      await verify(false);
      if (output && !modeId) throw new Error('audio_migration_output_started');
      if (journal.fields.some((entry) => entry.externalChanged))
        throw new Error('audio_migration_external_change');
      unsubscribe();
      // Keep the original reference states as an audit/restore backup after a successful change.
      if (modeId) {
        // The mode coordinator owns finalization after its durable commit.
      } else if (completedPath) {
        // Do not replace the only restore record from an earlier switch.
        await link(this.path, completedPath);
        await rm(this.path);
      } else {
        await rename(this.path, `${this.path}.completed-${randomUUID()}.json`);
      }
      created = false;
    } catch (error) {
      await flush();
      if (created && available() && !journal.fields.some((x) => x.phase === 'uncertain')) {
        try {
          // Close newly enabled paths before restoring old paths to avoid duplicate audio.
          for (const entry of journal.fields.filter(
            (x) => !active(x.before) && x.phase === 'confirmed',
          ))
            await send(entry, entry.before, 'restored', false);
          for (const entry of journal.fields.filter(
            (x) => active(x.before) && x.phase === 'confirmed',
          ))
            await send(entry, entry.before, 'restored', false);
          if (journal.fields.every((x) => x.phase === 'prepared' || x.phase === 'restored')) {
            if (!modeId) await rm(this.path);
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

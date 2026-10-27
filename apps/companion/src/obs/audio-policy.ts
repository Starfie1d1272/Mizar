import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';
import { obsAudioBindingSchema } from '@mizar/protocol/obs';
import type { ObsAudioBinding } from '@mizar/protocol/obs';
import type { ObsRpc } from './reconcile.js';

export type AudioPolicy = { mode: 'keep' } | { mode: 'attenuate'; db: number } | { mode: 'mute' };
type Field = 'volume' | 'mute';
export interface AudioLease {
  operation: string;
  binding: ObsAudioBinding;
  revision: string;
  epoch: number;
  field: Field;
  before: number | boolean;
  applied: number | boolean;
  phase: 'intent' | 'owned' | 'held';
}
export interface AudioLeaseStore {
  read(): Promise<AudioLease | null>;
  write(lease: AudioLease | null): Promise<void>;
}

const leaseSchema = z
  .object({
    operation: z.string().uuid(),
    binding: obsAudioBindingSchema,
    revision: z.string(),
    epoch: z.number().int(),
    field: z.enum(['volume', 'mute']),
    before: z.union([z.number().finite(), z.boolean()]),
    applied: z.union([z.number().finite(), z.boolean()]),
    phase: z.enum(['intent', 'owned', 'held']),
  })
  .strict()
  .refine((lease) =>
    lease.field === 'volume'
      ? typeof lease.before === 'number' && typeof lease.applied === 'number'
      : typeof lease.before === 'boolean' && typeof lease.applied === 'boolean',
  );

/** Serialize event and request writes so an older intent cannot overwrite a later hold. */
export class FileAudioLeaseStore implements AudioLeaseStore {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly path: string) {}
  async read() {
    await this.queue;
    try {
      return leaseSchema.nullable().parse(JSON.parse(await readFile(this.path, 'utf8')));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }
  write(lease: AudioLease | null) {
    const task = this.queue.then(async () => {
      const value = leaseSchema.nullable().parse(lease);
      await mkdir(dirname(this.path), { recursive: true });
      const temp = `${this.path}.${randomUUID()}.tmp`;
      try {
        await writeFile(temp, `${JSON.stringify(value)}\n`, { mode: 0o600 });
        await rename(temp, this.path);
      } finally {
        await rm(temp, { force: true });
      }
    });
    this.queue = task.catch(() => undefined);
    return task;
  }
}

/** A single field lease. The caller serializes calls and supplies a continuously observed connection. */
export class GameAudioPolicy {
  private lease: AudioLease | null = null;
  private loaded = false;
  private sequence = 0;
  private watched: { uuid: string; field: Field } | null = null;
  private pending: { field: Field; value: number | boolean } | null = null;
  constructor(private readonly store: AudioLeaseStore) {}
  async load() {
    if (!this.loaded) {
      this.lease = await this.store.read();
      this.loaded = true;
      // A previous process cannot prove uninterrupted observation.
      if (this.lease && this.lease.phase !== 'held') {
        this.lease = { ...this.lease, phase: 'held' };
        await this.store.write(this.lease);
      }
    }
  }
  get status() {
    return this.lease?.phase ?? 'idle';
  }
  async releaseHeld() {
    await this.load();
    if (this.lease?.phase !== 'held') throw new Error('audio_policy_not_held');
    await this.store.write(null);
    this.lease = null;
    this.watched = null;
    this.pending = null;
  }
  /** Invoke for every volume/mute event, including changes away and back. */
  observe(uuid: string, field: Field, value: number | boolean) {
    if (this.watched?.uuid !== uuid || this.watched.field !== field) return;
    if (this.pending?.field === field && this.pending.value === value) {
      this.pending = null;
      return;
    }
    this.sequence++;
    if (this.lease) {
      this.lease = { ...this.lease, phase: 'held' };
      void this.store.write(this.lease).catch(() => undefined);
    }
  }
  disconnect() {
    this.sequence++;
    this.pending = null;
    if (this.lease) {
      this.lease = { ...this.lease, phase: 'held' };
      void this.store.write(this.lease).catch(() => undefined);
    }
  }
  private async get(obs: ObsRpc, lease: AudioLease) {
    const value = await obs.call(lease.field === 'volume' ? 'GetInputVolume' : 'GetInputMute', {
      inputUuid: lease.binding.inputUuid,
    });
    const result = lease.field === 'volume' ? value.inputVolumeMul : value.inputMuted;
    if (
      lease.field === 'volume'
        ? typeof result !== 'number' || !Number.isFinite(result)
        : typeof result !== 'boolean'
    )
      throw new Error('audio_policy_read_invalid');
    return result as number | boolean;
  }
  private async set(obs: ObsRpc, lease: AudioLease, value: number | boolean) {
    this.pending = { field: lease.field, value };
    await obs.call(
      lease.field === 'volume' ? 'SetInputVolume' : 'SetInputMute',
      lease.field === 'volume'
        ? { inputUuid: lease.binding.inputUuid, inputVolumeMul: value }
        : { inputUuid: lease.binding.inputUuid, inputMuted: value },
    );
  }
  async apply(
    obs: ObsRpc,
    epoch: number,
    binding: ObsAudioBinding,
    revision: string,
    policy: AudioPolicy,
    valid: () => boolean,
  ) {
    await this.load();
    if (this.lease || policy.mode === 'keep' || !valid()) return;
    if (
      policy.mode === 'attenuate' &&
      (!Number.isFinite(policy.db) || policy.db <= 0 || policy.db > 60)
    )
      throw new Error('audio_policy_invalid');
    const field: Field = policy.mode === 'mute' ? 'mute' : 'volume';
    this.watched = { uuid: binding.inputUuid, field };
    const sequence = this.sequence;
    const initial: AudioLease = {
      operation: randomUUID(),
      binding,
      revision,
      epoch,
      field,
      before: field === 'mute' ? false : 0,
      applied: field === 'mute' ? true : 0,
      phase: 'intent',
    };
    const before = await this.get(obs, initial);
    if (!valid() || sequence !== this.sequence) return;
    // Never unmute or lease an already muted source.
    const muted = await obs.call('GetInputMute', { inputUuid: binding.inputUuid });
    if (muted.inputMuted !== false || !valid() || sequence !== this.sequence) return;
    const applied = policy.mode === 'mute' ? true : Number(before) * 10 ** (-policy.db / 20);
    if (before === applied) return;
    const lease: AudioLease = { ...initial, before, applied };
    this.lease = lease;
    await this.store.write(lease);
    if (!valid() || sequence !== this.sequence) {
      this.disconnect();
      return;
    }
    try {
      await this.set(obs, lease, applied);
      const current = await this.get(obs, lease);
      if (!valid() || sequence !== this.sequence || current !== applied) {
        this.disconnect();
        return;
      }
      this.lease = { ...lease, phase: 'owned' };
      await this.store.write(this.lease);
    } catch (error) {
      // Unknown result: observe, but never retry or assume ownership.
      await this.get(obs, lease).catch(() => undefined);
      this.disconnect();
      throw error;
    }
  }
  async restore(
    obs: ObsRpc,
    epoch: number,
    binding: ObsAudioBinding,
    revision: string,
    valid: () => boolean,
  ) {
    await this.load();
    const lease = this.lease;
    if (!lease || lease.phase !== 'owned') return;
    if (
      lease.epoch !== epoch ||
      lease.revision !== revision ||
      JSON.stringify(lease.binding) !== JSON.stringify(binding) ||
      !valid()
    ) {
      this.disconnect();
      return;
    }
    const sequence = this.sequence;
    const current = await this.get(obs, lease);
    if (!valid() || sequence !== this.sequence || current !== lease.applied) {
      this.disconnect();
      return;
    }
    // Persist the restore intent before the RPC. A crash leaves a held lease on restart.
    this.lease = { ...lease, phase: 'intent' };
    await this.store.write(this.lease);
    if (!valid() || sequence !== this.sequence) {
      this.disconnect();
      return;
    }
    try {
      await this.set(obs, lease, lease.before);
      const after = await this.get(obs, lease);
      if (!valid() || sequence !== this.sequence || after !== lease.before) {
        this.disconnect();
        return;
      }
      this.lease = null;
      await this.store.write(null);
    } catch (error) {
      await this.get(obs, lease).catch(() => undefined);
      this.disconnect();
      throw error;
    }
  }
}

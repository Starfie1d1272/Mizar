import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { obsGameAudioPolicySchema } from '@mizar/protocol/obs';
import type { ObsConfigStore } from './config.js';
import type { ObsAudioRouting } from './audio-routing.js';
import { FileAudioLeaseStore, GameAudioPolicy, type AudioPolicy } from './audio-policy.js';
import { GameAudioConnection } from './audio-policy-connection.js';

export class GameAudioController {
  private policy: AudioPolicy = { mode: 'keep' };
  private readonly owner: GameAudioPolicy;
  private readonly connection: GameAudioConnection;
  private desired: 'halftime' | 'gameplay' | 'unknown' = 'unknown';
  private generation = 0;
  private busy = false;
  private ready = false;
  private closed = false;
  private unsubscribe: (() => void)[];
  constructor(
    private readonly routing: ObsAudioRouting,
    config: ObsConfigStore,
    private readonly path: string,
  ) {
    this.owner = new GameAudioPolicy(new FileAudioLeaseStore(`${path}.lease`));
    this.connection = new GameAudioConnection(config, this.owner);
    this.unsubscribe = [
      routing.onChanged(() => this.invalidate()),
      config.onChanged(() => this.invalidate()),
    ];
  }
  private invalidate() {
    this.generation++;
    this.connection.invalidate();
  }
  async load() {
    try {
      this.policy = obsGameAudioPolicySchema.parse(JSON.parse(await readFile(this.path, 'utf8')));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    await this.owner.load();
    this.ready = true;
  }
  status() {
    return { policy: this.policy, ownership: this.owner.status, ready: this.ready };
  }
  async releaseHeld() {
    if (this.busy) throw new Error('audio_policy_busy');
    this.busy = true;
    try {
      this.invalidate();
      await this.owner.releaseHeld();
    } finally {
      this.busy = false;
    }
  }
  async configure(policy: AudioPolicy) {
    if (!this.ready) throw new Error('audio_policy_not_ready');
    if (this.busy) throw new Error('audio_policy_busy');
    const value = obsGameAudioPolicySchema.parse(policy);
    this.busy = true;
    try {
      this.invalidate();
      await mkdir(dirname(this.path), { recursive: true });
      const temp = `${this.path}.${randomUUID()}.tmp`;
      try {
        await writeFile(temp, `${JSON.stringify(value)}\n`, { mode: 0o600 });
        await rename(temp, this.path);
      } finally {
        await rm(temp, { force: true });
      }
      this.policy = value;
    } finally {
      this.busy = false;
    }
  }
  tick(desired: 'halftime' | 'gameplay' | 'unknown') {
    if (this.desired !== desired) {
      this.desired = desired;
      this.generation++;
    }
    if (desired === 'unknown') {
      this.connection.invalidate();
      return;
    }
    if (!this.ready || this.closed || this.busy || this.policy.mode === 'keep') return;
    if (
      this.owner.status === 'held' ||
      (desired === 'halftime' && this.owner.status === 'owned') ||
      (desired === 'gameplay' && this.owner.status === 'idle')
    )
      return;
    this.busy = true;
    const generation = this.generation;
    const valid = () => !this.closed && this.ready && this.generation === generation;
    void (async () => {
      const { binding, revision } = await this.routing.gameBinding();
      if (!binding) {
        this.invalidate();
        return;
      }
      if (valid()) await this.connection.run(binding, revision, desired, this.policy, valid);
    })()
      .catch(() => undefined)
      .finally(() => {
        this.busy = false;
      });
  }
  close() {
    this.closed = true;
    for (const stop of this.unsubscribe) stop();
    this.connection.close();
  }
}

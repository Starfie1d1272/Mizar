import { findBundledMap, loadBundledMap } from 'cs2-c4-damage/node';
import { prepareBombDamage, type BombDamageResource } from '@mizar/core/projection';
import { BombDamageWorkerClient } from './bomb-damage-worker-client.js';

/** Two cached maps, one in-flight load. Completion only asks the owner to re-project CURRENT state. */
export class BombDamageResources {
  private readonly cache = new Map<string, BombDamageResource>();
  private loading = false;
  private pending: Promise<void> | undefined;
  private closed = false;
  private readonly worker = new BombDamageWorkerClient(() => this.changed());
  constructor(
    private readonly changed: () => void,
    private readonly load?: typeof loadBundledMap,
  ) {}
  get(mapName: string | null, context = ''): BombDamageResource {
    this.worker.setContext(context);
    const entry = mapName === null ? undefined : findBundledMap(mapName);
    if (!entry) return { status: 'unavailable', reason: 'unsupported-map' };
    const cached = this.cache.get(entry.mapName);
    if (cached) {
      this.cache.delete(entry.mapName);
      this.cache.set(entry.mapName, cached);
      return cached;
    }
    if (!this.loading && !this.closed) {
      this.loading = true;
      const prepared = this.load
        ? this.load(entry.mapName).then((field) => {
            if (
              field.metadata.mapName !== entry.mapName ||
              field.metadata.normalizedFieldSha256 !== entry.normalizedFieldSha256
            )
              throw new Error('resource-mismatch');
            return prepareBombDamage(field);
          })
        : this.worker.load(entry.mapName);
      this.pending = prepared
        .then((value): BombDamageResource => ({ status: 'ready', value }))
        .catch((): BombDamageResource => ({ status: 'unavailable', reason: 'resource-invalid' }))
        .then((result) => {
          this.loading = false;
          if (this.closed) return;
          this.cache.set(entry.mapName, result);
          while (this.cache.size > 2) {
            const oldest = this.cache.keys().next().value!;
            this.cache.delete(oldest);
            this.worker.evict(oldest);
          }
          this.changed();
        });
    }
    return { status: 'unavailable', reason: 'resource-loading' };
  }
  async prepare(mapName: string | null): Promise<void> {
    this.get(mapName);
    if (this.pending) await this.pending;
    this.get(mapName);
    if (this.pending) await this.pending;
  }
  async settlePredictions(): Promise<boolean> {
    return this.worker.settle();
  }
  close(): void {
    this.closed = true;
    this.cache.clear();
    this.worker.close();
  }
}

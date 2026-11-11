import type { ReliableEventV1 } from '@mizar/protocol/output';
import type { ExactSource } from '../match-context/rivalhub-source-state.js';
import type { CaptureInterval } from './capture-interval.js';
import { sourceKey } from './outbox-codec.js';
import type { HistoryRow, HistoryScope } from './outbox-repository.js';
import type { OutboxOperations } from './outbox-worker.js';

type CaptureIndex = ReturnType<OutboxOperations['load']>['capture'];
type CaptureUnknown = CaptureIndex['unknown'][number];

export function deliveryScope(event: ReliableEventV1): HistoryScope {
  return {
    matchId: event.matchId,
    producerInstanceId: event.cursor.producerInstanceId,
    ...(event.cursor.liveSessionId ? { liveSessionId: event.cursor.liveSessionId } : {}),
  };
}

function deliveryKey(scope: HistoryScope): string {
  return JSON.stringify([scope.matchId, scope.producerInstanceId, scope.liveSessionId ?? null]);
}

/** Committed evidence for active deliveries and the one current observation. */
export class OutboxReadView {
  captureStoreId: string | undefined;
  readonly intervals = new Map<string, CaptureInterval>();
  private readonly intervalBySource = new Map<string, string>();
  readonly unknown = new Map<string, CaptureUnknown>();
  readonly archived = new Set<string>();

  private active = new Set<string>();
  private observed: HistoryScope | undefined;
  private readonly history = new Map<string, readonly HistoryRow[]>();

  restoreCapture(index: CaptureIndex): void {
    this.captureStoreId = index.storeId;
    this.intervals.clear();
    this.intervalBySource.clear();
    this.unknown.clear();
    this.archived.clear();
    for (const interval of index.intervals) this.setInterval(interval);
    for (const item of index.unknown) this.unknown.set(sourceKey(item.source), item);
    for (const key of index.archived) this.archived.add(key);
  }

  setInterval(interval: CaptureInterval): void {
    this.intervals.set(interval.reference.id, interval);
    this.intervalBySource.set(sourceKey(interval.source), interval.reference.id);
  }

  intervalForSource(source: ExactSource): CaptureInterval | undefined {
    const id = this.intervalBySource.get(sourceKey(source));
    return id === undefined ? undefined : this.intervals.get(id);
  }

  get(scope: HistoryScope): readonly HistoryRow[] | undefined {
    return this.history.get(deliveryKey(scope));
  }

  activeHistory(): readonly HistoryRow[] {
    return [...this.active].flatMap((key) => this.history.get(key) ?? []);
  }

  observe(scope: HistoryScope | undefined): void {
    const prior = this.observed && deliveryKey(this.observed);
    const key = scope && deliveryKey(scope);
    this.observed = scope;
    if (prior && prior !== key && !this.active.has(prior)) this.history.delete(prior);
  }

  missingObservation(): HistoryScope | undefined {
    return this.observed && !this.get(this.observed) ? this.observed : undefined;
  }

  setObservation(scope: HistoryScope, rows: readonly HistoryRow[]): void {
    const key = deliveryKey(scope);
    if (this.observed && key === deliveryKey(this.observed)) this.history.set(key, rows);
  }

  plan(events: readonly ReliableEventV1[], refresh: boolean) {
    const active = new Map(
      events.map((event) => {
        const scope = deliveryScope(event);
        return [deliveryKey(scope), scope] as const;
      }),
    );
    const targets = new Map(active);
    if (this.observed) targets.set(deliveryKey(this.observed), this.observed);
    const lookups = [...targets].filter(([key]) => refresh || !this.history.has(key));
    return {
      scopes: lookups.map(([, scope]) => scope),
      apply: (rows: readonly (readonly HistoryRow[])[]) => {
        this.active = new Set(active.keys());
        const observed = this.observed && deliveryKey(this.observed);
        if (refresh) this.history.clear();
        for (const [index, [key]] of lookups.entries()) {
          if (this.active.has(key) || key === observed) this.history.set(key, rows[index]!);
        }
        for (const key of this.history.keys()) {
          if (!this.active.has(key) && key !== observed) this.history.delete(key);
        }
      },
    };
  }
}

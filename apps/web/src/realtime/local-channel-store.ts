import type { SnapshotResetSignals, SnapshotEnvelopeLike } from '@mizar/protocol/acceptance';

export type LocalChannelConnectionState =
  | 'idle'
  | 'connecting'
  | 'awaiting-baseline'
  | 'live'
  | 'reconnecting'
  | 'protocol-error'
  | 'closed';

export interface LocalChannelStoreSnapshot<TSnapshot extends SnapshotEnvelopeLike> {
  readonly state: LocalChannelConnectionState;
  readonly current: TSnapshot | null;
  readonly reset: SnapshotResetSignals | null;
  readonly error: string | null;
}

export type LocalChannelStoreListener = () => void;

export class LocalChannelStore<TSnapshot extends SnapshotEnvelopeLike> {
  private snapshot: LocalChannelStoreSnapshot<TSnapshot> = {
    state: 'idle',
    current: null,
    reset: null,
    error: null,
  };
  private readonly listeners = new Set<LocalChannelStoreListener>();

  getSnapshot = (): LocalChannelStoreSnapshot<TSnapshot> => this.snapshot;

  subscribe = (listener: LocalChannelStoreListener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  setState(state: LocalChannelConnectionState, error: string | null = null): void {
    this.update({ state, error });
  }

  accept(snapshot: TSnapshot, reset: SnapshotResetSignals): void {
    this.update({ state: 'live', current: snapshot, reset, error: null });
  }

  private update(patch: Partial<LocalChannelStoreSnapshot<TSnapshot>>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of this.listeners) listener();
  }
}

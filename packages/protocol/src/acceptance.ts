import type { LocalSnapshotChannel } from './version.js';

export interface SnapshotCursorLike {
  readonly producerInstanceId: string;
  readonly liveSessionId: string | null;
  readonly runtimeSeq: number;
  readonly programSourceGeneration: number;
  readonly programReceiveSequence: number | null;
  readonly mapEpoch: number;
}

export interface SnapshotEnvelopeLike {
  readonly type: 'snapshot';
  readonly protocolVersion: number;
  readonly channel: LocalSnapshotChannel;
  readonly schemaVersion: number;
  readonly channelSeq: number;
  readonly cursor: SnapshotCursorLike;
  readonly payload: unknown;
}

export interface SnapshotAcceptanceState {
  readonly channel: LocalSnapshotChannel | null;
  readonly producerInstanceId: string | null;
  readonly lastAcceptedChannelSeq: number | null;
  readonly lastAcceptedRuntimeSeq: number | null;
  readonly lastCursor: SnapshotCursorLike | null;
}

export type SnapshotAcceptanceKind = 'accepted' | 'ignored' | 'rejected';

export interface SnapshotResetSignals {
  readonly liveSessionChanged: boolean;
  readonly programSourceGenerationChanged: boolean;
  readonly mapEpochChanged: boolean;
}

export interface SnapshotAccepted<TSnapshot> {
  readonly kind: 'accepted';
  readonly snapshot: TSnapshot;
  readonly state: SnapshotAcceptanceState;
  readonly reset: SnapshotResetSignals;
}

export interface SnapshotIgnored {
  readonly kind: 'ignored';
  readonly reason: 'duplicate-or-out-of-order';
  readonly state: SnapshotAcceptanceState;
  readonly reset: SnapshotResetSignals;
}

export interface SnapshotRejected {
  readonly kind: 'rejected';
  readonly reason:
    'schema-invalid' | 'channel-changed' | 'producer-changed' | 'runtime-seq-regression';
  readonly state: SnapshotAcceptanceState;
  readonly reset: SnapshotResetSignals;
}

export type SnapshotAcceptanceResult<TSnapshot> =
  SnapshotAccepted<TSnapshot> | SnapshotIgnored | SnapshotRejected;

export interface SnapshotSchema<TSnapshot> {
  parse(input: unknown): TSnapshot;
}

export function createSnapshotAcceptanceState(): SnapshotAcceptanceState {
  return {
    channel: null,
    producerInstanceId: null,
    lastAcceptedChannelSeq: null,
    lastAcceptedRuntimeSeq: null,
    lastCursor: null,
  };
}

function noResets(): SnapshotResetSignals {
  return {
    liveSessionChanged: false,
    programSourceGenerationChanged: false,
    mapEpochChanged: false,
  };
}

function rejected(
  state: SnapshotAcceptanceState,
  reason: SnapshotRejected['reason'],
): SnapshotRejected {
  return { kind: 'rejected', reason, state, reset: noResets() };
}

export function acceptSnapshot<TSnapshot extends SnapshotEnvelopeLike>(
  input: unknown,
  schema: SnapshotSchema<TSnapshot>,
  previous: SnapshotAcceptanceState = createSnapshotAcceptanceState(),
): SnapshotAcceptanceResult<TSnapshot> {
  let snapshot: TSnapshot;
  try {
    snapshot = schema.parse(input);
  } catch {
    return rejected(previous, 'schema-invalid');
  }

  const channel = snapshot.channel;
  if (previous.channel !== null && previous.channel !== channel) {
    return rejected(previous, 'channel-changed');
  }
  if (
    previous.producerInstanceId !== null &&
    previous.producerInstanceId !== snapshot.cursor.producerInstanceId
  ) {
    return rejected(previous, 'producer-changed');
  }
  if (
    previous.lastAcceptedChannelSeq !== null &&
    snapshot.channelSeq <= previous.lastAcceptedChannelSeq
  ) {
    return {
      kind: 'ignored',
      reason: 'duplicate-or-out-of-order',
      state: previous,
      reset: noResets(),
    };
  }
  if (
    previous.lastAcceptedRuntimeSeq !== null &&
    snapshot.cursor.runtimeSeq < previous.lastAcceptedRuntimeSeq
  ) {
    return rejected(previous, 'runtime-seq-regression');
  }

  const previousCursor = previous.lastCursor;
  const reset: SnapshotResetSignals = {
    liveSessionChanged:
      previousCursor !== null && previousCursor.liveSessionId !== snapshot.cursor.liveSessionId,
    programSourceGenerationChanged:
      previousCursor !== null &&
      previousCursor.programSourceGeneration !== snapshot.cursor.programSourceGeneration,
    mapEpochChanged:
      previousCursor !== null && previousCursor.mapEpoch !== snapshot.cursor.mapEpoch,
  };
  const state: SnapshotAcceptanceState = {
    channel,
    producerInstanceId: snapshot.cursor.producerInstanceId,
    lastAcceptedChannelSeq: snapshot.channelSeq,
    lastAcceptedRuntimeSeq: snapshot.cursor.runtimeSeq,
    lastCursor: snapshot.cursor,
  };
  return { kind: 'accepted', snapshot, state, reset };
}

export interface SnapshotAcceptance<TSnapshot extends SnapshotEnvelopeLike> {
  accept(input: unknown): SnapshotAcceptanceResult<TSnapshot>;
  getState(): SnapshotAcceptanceState;
  reset(): void;
}

export function createSnapshotAcceptance<TSnapshot extends SnapshotEnvelopeLike>(
  schema: SnapshotSchema<TSnapshot>,
): SnapshotAcceptance<TSnapshot> {
  let state = createSnapshotAcceptanceState();
  return {
    accept(input) {
      const result = acceptSnapshot(input, schema, state);
      if (result.kind === 'accepted') state = result.state;
      return result;
    },
    getState: () => state,
    reset: () => {
      state = createSnapshotAcceptanceState();
    },
  };
}

export const acceptLocalSnapshot = acceptSnapshot;

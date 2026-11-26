import {
  LOCAL_PROTOCOL_VERSION,
  LOCAL_SNAPSHOT_CHANNELS,
  LOCAL_SNAPSHOT_VERSIONS,
  type LocalSnapshotChannel,
} from './version.js';

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

export type SnapshotValidator<TSnapshot> =
  SnapshotSchema<TSnapshot> | ((input: unknown) => TSnapshot | null);

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

export interface SnapshotEnvelopeExpectation {
  readonly channel?: LocalSnapshotChannel;
  readonly protocolVersion?: number;
  readonly schemaVersion?: number;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonNegativeInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function isSnapshotChannel(value: unknown): value is LocalSnapshotChannel {
  return (
    typeof value === 'string' && (LOCAL_SNAPSHOT_CHANNELS as readonly string[]).includes(value)
  );
}

function hasValidChannelPayload(
  channel: LocalSnapshotChannel,
  payload: Record<string, unknown>,
): boolean {
  switch (channel) {
    case 'program':
      return (
        isPlainRecord(payload.status) &&
        isPlainRecord(payload.teams) &&
        isPlainRecord(payload.map) &&
        Array.isArray(payload.players)
      );
    case 'radar':
      return (
        (payload.mapName === null || typeof payload.mapName === 'string') &&
        Array.isArray(payload.players) &&
        Array.isArray(payload.grenades)
      );
    case 'operator':
      return (
        isPlainRecord(payload.runtime) &&
        isPlainRecord(payload.matchContext) &&
        isPlainRecord(payload.identity) &&
        isPlainRecord(payload.activeLineup) &&
        isPlainRecord(payload.sources)
      );
    case 'assist':
      return (
        typeof payload.availability === 'string' &&
        (payload.observer === undefined || isPlainRecord(payload.observer))
      );
  }
}

/**
 * Zero-copy structural validator for local WebSocket snapshot hot paths.
 * Validates envelope, cursor, and channel-specific top-level payload invariants
 * without allocating a deep-cloned object tree.
 */
export function parseSnapshotEnvelope<TSnapshot extends SnapshotEnvelopeLike>(
  input: unknown,
  expected?: SnapshotEnvelopeExpectation,
): TSnapshot | null {
  if (!isPlainRecord(input) || input.type !== 'snapshot') return null;

  const protocolVersion = input.protocolVersion;
  if (typeof protocolVersion !== 'number' || !Number.isInteger(protocolVersion)) return null;
  if (expected?.protocolVersion !== undefined && protocolVersion !== expected.protocolVersion) {
    return null;
  }

  const channel = input.channel;
  if (!isSnapshotChannel(channel)) return null;
  if (expected?.channel !== undefined && channel !== expected.channel) return null;

  const schemaVersion = input.schemaVersion;
  if (typeof schemaVersion !== 'number' || !Number.isInteger(schemaVersion)) return null;
  if (expected?.schemaVersion !== undefined && schemaVersion !== expected.schemaVersion) {
    return null;
  }

  const channelSeq = input.channelSeq;
  if (typeof channelSeq !== 'number' || !Number.isInteger(channelSeq) || channelSeq < 1) {
    return null;
  }

  const cursor = input.cursor;
  if (!isPlainRecord(cursor)) return null;
  if (typeof cursor.producerInstanceId !== 'string' || cursor.producerInstanceId.length === 0) {
    return null;
  }
  if (cursor.liveSessionId !== null && typeof cursor.liveSessionId !== 'string') {
    return null;
  }
  if (!isNonNegativeInt(cursor.runtimeSeq)) return null;
  if (!isNonNegativeInt(cursor.programSourceGeneration)) return null;
  if (cursor.programReceiveSequence !== null && !isNonNegativeInt(cursor.programReceiveSequence)) {
    return null;
  }
  if (!isNonNegativeInt(cursor.mapEpoch)) return null;

  const payload = input.payload;
  if (!isPlainRecord(payload) || !hasValidChannelPayload(channel, payload)) return null;

  return input as unknown as TSnapshot;
}

export function createChannelSnapshotValidator<TSnapshot extends SnapshotEnvelopeLike>(
  channel: LocalSnapshotChannel,
): (input: unknown) => TSnapshot | null {
  const expected: SnapshotEnvelopeExpectation = {
    channel,
    protocolVersion: LOCAL_PROTOCOL_VERSION,
    schemaVersion: LOCAL_SNAPSHOT_VERSIONS[channel],
  };
  return (input: unknown) => parseSnapshotEnvelope<TSnapshot>(input, expected);
}

export function acceptSnapshot<TSnapshot extends SnapshotEnvelopeLike>(
  input: unknown,
  validator: SnapshotValidator<TSnapshot>,
  previous: SnapshotAcceptanceState = createSnapshotAcceptanceState(),
): SnapshotAcceptanceResult<TSnapshot> {
  let snapshot: TSnapshot | null;
  if (typeof validator === 'function') {
    snapshot = validator(input);
  } else {
    try {
      snapshot = validator.parse(input);
    } catch {
      snapshot = null;
    }
  }
  if (snapshot === null) {
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
  validator: SnapshotValidator<TSnapshot>,
): SnapshotAcceptance<TSnapshot> {
  let state = createSnapshotAcceptanceState();
  return {
    accept(input) {
      const result = acceptSnapshot(input, validator, state);
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

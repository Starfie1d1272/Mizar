import { describe, expect, it } from 'vitest';

import {
  acceptSnapshot,
  createSnapshotAcceptance,
  createSnapshotAcceptanceState,
} from '../src/acceptance.js';
import { programSnapshotSchema } from '../src/program.js';
import {
  LOCAL_PROTOCOL_SUBPROTOCOL,
  LOCAL_PROTOCOL_VERSION,
  PROGRAM_SCHEMA_VERSION,
} from '../src/version.js';

const cursor = {
  producerInstanceId: 'producer-29',
  liveSessionId: 'live-29',
  runtimeSeq: 1,
  programSourceGeneration: 0,
  programReceiveSequence: 1,
  mapEpoch: 0,
};

function payload() {
  return {
    status: {
      telemetry: 'fresh' as const,
      context: 'unbound' as const,
      identity: 'unbound' as const,
    },
    match: null,
    teams: {
      ct: {
        mode: 'neutral' as const,
        entryId: null,
        name: 'CT' as const,
        logoUrl: null,
        seriesScore: null,
      },
      t: {
        mode: 'neutral' as const,
        entryId: null,
        name: 'T' as const,
        logoUrl: null,
        seriesScore: null,
      },
    },
    series: null,
    map: {
      name: 'de_mirage',
      mode: null,
      phase: 'live' as const,
      roundNumber: 1,
      score: { ct: 0, t: 0 },
      timeoutsRemaining: { ct: null, t: null },
      consecutiveRoundLosses: { ct: null, t: null },
    },
    round: null,
    clock: null,
    observedPlayerSourceId: null,
    players: [],
    bomb: null,
    coverage: {
      map: 'present' as const,
      round: 'absent' as const,
      phaseCountdowns: 'absent' as const,
      player: 'absent' as const,
      allPlayers: 'absent' as const,
      bomb: 'absent' as const,
    },
  };
}

function snapshot(channelSeq: number, overrides: Record<string, unknown> = {}) {
  return {
    type: 'snapshot' as const,
    protocolVersion: LOCAL_PROTOCOL_VERSION,
    channel: 'program' as const,
    schemaVersion: PROGRAM_SCHEMA_VERSION,
    channelSeq,
    cursor: { ...cursor },
    payload: payload(),
    ...overrides,
  };
}

describe('Local Protocol V1 and channel schema acceptance', () => {
  it('keeps channel schemas independent and strips future fields', () => {
    const parsed = programSnapshotSchema.parse({
      ...snapshot(1),
      lookahead: { killer: 'future-only' },
      payload: { ...payload(), futureCue: { shouldNotLeak: true } },
    });

    expect(LOCAL_PROTOCOL_SUBPROTOCOL).toBe('mizar.local.v1');
    expect(LOCAL_PROTOCOL_VERSION).toBe(1);
    expect(PROGRAM_SCHEMA_VERSION).toBe(7);
    expect(parsed.channel).toBe('program');
    expect(parsed).not.toHaveProperty('lookahead');
    expect(parsed.payload).not.toHaveProperty('futureCue');
  });

  it('requires the Program v7 series, player evidence, ADR views, and life state fields', () => {
    const player = {
      sourcePlayerId: 'player-1',
      canonicalPlayerId: null,
      identityEvidence: 'observed' as const,
      lineupEvidence: 'current' as const,
      displayName: 'Player 1',
      displayNameSource: 'observed' as const,
      avatarUrl: null,
      side: 'CT' as const,
      observerSlot: 1,
      activity: 'playing',
      lifeState: 'alive' as const,
      liveAdr: null,
      completedAdr: null,
      weaponsAvailable: true,
      currentRoundDamage: null,
      roundMoneySpent: null,
      state: null,
      matchStats: null,
      weapons: [],
    };

    expect(
      programSnapshotSchema.parse({
        ...snapshot(1),
        payload: { ...payload(), players: [player] },
      }).payload.players[0]?.lifeState,
    ).toBe('alive');
    const missingLifeState: Record<string, unknown> = { ...player };
    delete missingLifeState.lifeState;
    expect(() =>
      programSnapshotSchema.parse({
        ...snapshot(1),
        payload: {
          ...payload(),
          players: [missingLifeState],
        },
      }),
    ).toThrow();

    for (const field of [
      'liveAdr',
      'completedAdr',
      'weaponsAvailable',
      'currentRoundDamage',
      'roundMoneySpent',
    ] as const) {
      const missingAdrView: Record<string, unknown> = { ...player };
      delete missingAdrView[field];
      expect(() =>
        programSnapshotSchema.parse({
          ...snapshot(1),
          payload: { ...payload(), players: [missingAdrView] },
        }),
      ).toThrow();
    }
  });

  it('fails closed on the retired Program v6 envelope', () => {
    expect(() =>
      programSnapshotSchema.parse({
        ...snapshot(1),
        schemaVersion: 6,
      }),
    ).toThrow();
  });

  it('accepts monotonic snapshots, ignores duplicates, and emits epoch reset signals', () => {
    const first = acceptSnapshot(
      snapshot(1),
      programSnapshotSchema,
      createSnapshotAcceptanceState(),
    );
    expect(first.kind).toBe('accepted');

    const duplicate = acceptSnapshot(snapshot(1), programSnapshotSchema, first.state);
    expect(duplicate).toMatchObject({ kind: 'ignored', reason: 'duplicate-or-out-of-order' });

    const next = acceptSnapshot(
      snapshot(2, { cursor: { ...cursor, runtimeSeq: 2, mapEpoch: 1 } }),
      programSnapshotSchema,
      first.state,
    );
    expect(next.kind).toBe('accepted');
    expect(next.reset.mapEpochChanged).toBe(true);

    const sourceAndSession = acceptSnapshot(
      snapshot(3, {
        cursor: {
          ...cursor,
          runtimeSeq: 3,
          programSourceGeneration: 1,
          liveSessionId: null,
        },
      }),
      programSnapshotSchema,
      next.state,
    );
    expect(sourceAndSession.kind).toBe('accepted');
    expect(sourceAndSession.reset).toMatchObject({
      liveSessionChanged: true,
      programSourceGenerationChanged: true,
    });
    expect(sourceAndSession.reset).not.toHaveProperty('producerInstanceChanged');
  });

  it('rejects an unsafe channel sequence', () => {
    const result = acceptSnapshot(
      snapshot(Number.MAX_SAFE_INTEGER + 1),
      programSnapshotSchema,
      createSnapshotAcceptanceState(),
    );

    expect(result).toMatchObject({ kind: 'rejected', reason: 'schema-invalid' });
  });

  it('rejects wrong protocol, schema, and channel literals', () => {
    expect(
      acceptSnapshot(
        snapshot(1, { protocolVersion: 2 }),
        programSnapshotSchema,
        createSnapshotAcceptanceState(),
      ),
    ).toMatchObject({ kind: 'rejected', reason: 'schema-invalid' });
    expect(
      acceptSnapshot(
        snapshot(1, { schemaVersion: 1 }),
        programSnapshotSchema,
        createSnapshotAcceptanceState(),
      ),
    ).toMatchObject({ kind: 'rejected', reason: 'schema-invalid' });
    expect(
      acceptSnapshot(
        snapshot(1, { channel: 'radar' }),
        programSnapshotSchema,
        createSnapshotAcceptanceState(),
      ),
    ).toMatchObject({ kind: 'rejected', reason: 'schema-invalid' });
  });

  it('rejects runtime regressions and producer changes on the same socket', () => {
    const acceptance = createSnapshotAcceptance(programSnapshotSchema);
    expect(acceptance.accept(snapshot(1)).kind).toBe('accepted');
    expect(acceptance.accept(snapshot(2, { cursor: { ...cursor, runtimeSeq: 0 } }))).toMatchObject({
      kind: 'rejected',
      reason: 'runtime-seq-regression',
    });
    expect(
      acceptance.accept(
        snapshot(3, { cursor: { ...cursor, producerInstanceId: 'producer-new', runtimeSeq: 3 } }),
      ),
    ).toMatchObject({ kind: 'rejected', reason: 'producer-changed' });
  });
});

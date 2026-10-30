import { describe, expect, it } from 'vitest';

import {
  identityEvidenceFromObservation,
  resolveActiveLineup,
  resolveIdentity,
  type IdentityResolution,
} from '../src/identity/index.js';
import {
  createInitialRuntimeState,
  reduceRuntime,
  type RuntimeContinuityPolicy,
  type RuntimeState,
} from '../src/runtime/index.js';
import {
  getProjectionIdentityCapabilities,
  livePlayerDisplayName,
  matchPlayerDisplayName,
  projectProgram,
  selectProgramSafeRuntimeView,
} from '../src/projection/index.js';
import type { MatchContext } from '../src/match-context/index.js';
import type { ObservedPlayer, TelemetryObservation } from '../src/telemetry/index.js';

const POLICY: RuntimeContinuityPolicy = { staleAfterMs: 100 };

function steam64(index: number): string {
  return String(76561198000000000n + BigInt(index));
}

function contextFixture(): MatchContext {
  const entrant = (entryId: 'a' | 'b', name: string, offset: number) => ({
    entryId,
    name,
    logoUrl: `https://example.test/${entryId}.svg`,
    rosterId: `${entryId}-roster`,
    players: Array.from({ length: 5 }, (_, index) => ({
      playerId: `${entryId}-player-${index + 1}`,
      steam64: steam64(offset + index),
      displayName: `${name} Player ${index + 1}`,
      avatarUrl: null,
      isStarter: true,
    })),
  });

  return {
    matchId: 'match-29',
    competition: {
      competitionId: 'competition-1',
      slug: 'issue-29',
      name: 'Issue 29 Cup',
      themeColor: '#123456',
    },
    status: 'in_progress',
    format: 'bo3',
    stage: 'final',
    round: 1,
    entryRound: null,
    scheduledAt: null,
    startedAt: null,
    completedAt: null,
    scoreA: 1,
    scoreB: 0,
    isForfeit: false,
    entrants: {
      a: entrant('a', 'Alpha', 1),
      b: entrant('b', 'Bravo', 6),
    },
    maps: [1, 2, 3].map((mapOrder) => ({
      mapId: `map-${mapOrder}`,
      mapOrder,
      mapName: mapOrder === 1 ? 'de_mirage' : `de_map_${mapOrder}`,
      pickedByEntryId: null,
      teamAStartSide: 'CT' as const,
      scoreA: mapOrder === 1 ? 13 : null,
      scoreB: mapOrder === 1 ? 9 : null,
      completedAt: null,
    })),
    veto: [],
    commentators: [],
  };
}

function player(index: number, side: 'CT' | 'T', reverse = false): ObservedPlayer {
  return {
    sourcePlayerId: steam64(index),
    displayName: `Observed ${index}`,
    side,
    observerSlot: index,
    activity: 'playing',
    state: {
      health: index === 1 ? 100 : 0,
      armor: 100,
      hasHelmet: true,
      money: 1200,
      roundKills: index === 1 ? 2 : 0,
    },
    matchStats: { kills: index === 1 ? 4 : 0, deaths: 0, score: 10 },
    weapons: reverse
      ? [
          { sourceWeaponId: 'weapon-z', name: 'AK-47', state: 'holstered' },
          { sourceWeaponId: 'weapon-a', name: 'Knife', state: 'active' },
        ]
      : [{ sourceWeaponId: 'weapon-a', name: 'Knife', state: 'active' }],
    position: { x: index, y: index + 1, z: 0 },
    forward: { x: 1, y: 0, z: 0 },
  };
}

function observation(reverse = false): TelemetryObservation {
  const allPlayers = [
    ...Array.from({ length: 5 }, (_, index) => player(index + 1, 'CT', reverse)),
    ...Array.from({ length: 5 }, (_, index) => player(index + 6, 'T', reverse)),
  ];
  if (reverse) allPlayers.reverse();

  return {
    receive: {
      sequence: 7,
      receivedAt: '2026-09-16T00:00:00.007Z',
      receivedMonotonicMs: 7,
    },
    source: { kind: 'cs2-gsi', providerTimestampSeconds: 1_700_000_007 },
    coverage: {
      provider: 'present',
      map: 'present',
      round: 'present',
      phaseCountdowns: 'present',
      player: 'present',
      allPlayers: 'present',
      bomb: 'present',
      grenades: 'present',
    },
    telemetry: {
      map: {
        name: 'de_mirage',
        mode: 'competitive',
        phase: 'live',
        roundNumber: 3,
        sides: {
          ct: { name: 'Alpha', score: 8, timeoutsRemaining: 1 },
          t: { name: 'Bravo', score: 6, timeoutsRemaining: 0 },
        },
      },
      round: { phase: 'live', winnerSide: 'unknown' },
      phaseCountdowns: { phase: 'live', endsInSeconds: 42 },
      player: allPlayers[0]!,
      allPlayers,
      bomb: {
        state: 'dropped',
        position: { x: 10, y: 20, z: 0 },
        sourcePlayerId: allPlayers[0]!.sourcePlayerId,
        countdownSeconds: 12,
      },
    },
  };
}

function acceptedState(input: TelemetryObservation): RuntimeState {
  const initial = createInitialRuntimeState('producer-29', {
    kind: 'bound',
    liveSessionId: 'live-29',
  });
  return reduceRuntime(
    initial,
    { kind: 'program-telemetry', sourceGeneration: 0, observation: input },
    POLICY,
  ).state;
}

function matchedIdentity(context: MatchContext, input: TelemetryObservation): IdentityResolution {
  const state = acceptedState(input);
  return resolveIdentity(context, identityEvidenceFromObservation(input, 0, state.map.epoch));
}

function resolvedLineup(
  state: RuntimeState,
  input: TelemetryObservation,
  identity: IdentityResolution,
  context?: MatchContext,
) {
  return resolveActiveLineup({
    sourceGeneration: state.programSource.generation,
    mapEpoch: state.map.epoch,
    ...(input.telemetry.allPlayers === undefined ? {} : { allPlayers: input.telemetry.allPlayers }),
    allPlayersCoverage: input.coverage.allPlayers,
    ...(context === undefined ? {} : { context }),
    identity,
  });
}

describe('Program-safe projections', () => {
  it('uses only unique Steam64 match bindings for website names and preserves local fallback', () => {
    const context = contextFixture();
    const name = matchPlayerDisplayName(context, steam64(1));
    expect(livePlayerDisplayName('Game Name', name, [], true)).toEqual({
      displayName: 'Alpha Player 1',
      displayNameSource: 'canonical',
    });
    expect(livePlayerDisplayName('Game Name', name, [], false).displayName).toBe('Game Name');
    expect(
      livePlayerDisplayName('Game Name', matchPlayerDisplayName(context, steam64(99)), [], true)
        .displayName,
    ).toBe('Game Name');
    expect(livePlayerDisplayName(undefined, null, [], true).displayName).toBeNull();
    const duplicate = {
      ...context,
      entrants: {
        ...context.entrants,
        b: {
          ...context.entrants.b,
          players: [...context.entrants.b.players, context.entrants.a.players[0]!],
        },
      },
    };
    expect(matchPlayerDisplayName(duplicate, steam64(1))).toBeNull();
  });
  it('fails closed to neutral teams and player ids across an identity epoch change', () => {
    const context = contextFixture();
    const input = observation();
    const state = acceptedState(input);
    const identity = matchedIdentity(context, input);
    const activeLineup = resolvedLineup(state, input, identity, context);
    const projection = projectProgram({
      runtime: selectProgramSafeRuntimeView(state),
      context,
      identity: { ...identity, sourceGeneration: 1 },
      activeLineup,
      nowMonotonicMs: 7,
      continuityPolicy: POLICY,
    });

    expect(projection.teams.ct).toEqual({
      mode: 'neutral',
      entryId: null,
      name: 'CT',
      logoUrl: null,
      seriesScore: null,
    });
    expect(projection.players.every((item) => item.canonicalPlayerId === null)).toBe(true);
    expect(projection.status.identity).toBe('resolving');
    expect(
      getProjectionIdentityCapabilities(selectProgramSafeRuntimeView(state), {
        ...identity,
        sourceGeneration: 1,
      }),
    ).toEqual({
      canonicalPlayerMapping: false,
      canonicalTeamBranding: false,
      identityDependentResult: false,
      neutralTelemetry: true,
    });
  });

  it('does not expose the previous Program source after a source generation advance', () => {
    const input = observation();
    const state = acceptedState(input);
    const advanced = reduceRuntime(
      state,
      {
        kind: 'advance-program-source-generation',
        nextGeneration: 1,
        at: { monotonicMs: 8, utc: '2026-09-16T00:00:00.008Z' },
      },
      POLICY,
    ).state;
    const runtime = selectProgramSafeRuntimeView(advanced);

    expect(runtime.cursor.programSourceGeneration).toBe(1);
    expect(runtime.cursor.programReceiveSequence).toBeNull();
    expect(runtime.programSourceLastAccepted).toBeNull();
    expect(runtime.telemetry).toBeNull();
  });
});

it('projects held reload, bomb carrier and Zeus facts from the live observation', () => {
  const base = observation();
  const input: TelemetryObservation = {
    ...base,
    telemetry: {
      ...base.telemetry,
      bomb: { state: 'carried', sourcePlayerId: steam64(1) },
      allPlayers: base.telemetry.allPlayers!.map((p) =>
        p.sourcePlayerId !== steam64(1)
          ? p
          : {
              ...p,
              weapons: [
                { sourceWeaponId: 'rifle', name: 'weapon_ak47', state: 'reloading' },
                { sourceWeaponId: 'zeus', name: 'weapon_taser', state: 'holstered' },
              ],
            },
      ),
    },
  };
  const context = contextFixture();
  const state = acceptedState(input);
  const identity = matchedIdentity(context, input);
  const args = {
    runtime: selectProgramSafeRuntimeView(state),
    context,
    identity,
    activeLineup: resolvedLineup(state, input, identity, context),
    continuityPolicy: POLICY,
    equipmentCatalog: {
      weapon_ak47: { canonicalKey: 'firearm.ak47', kind: 'firearm' as const, family: 'rifle' },
      weapon_taser: { canonicalKey: 'utility.taser', kind: 'utility' as const, family: 'taser' },
    },
  };
  const live = projectProgram({ ...args, nowMonotonicMs: 7 });
  expect(live.players.find((p) => p.sourcePlayerId === steam64(1))?.equipment).toMatchObject({
    heldWeaponId: 'rifle',
    hasC4: true,
    zeusWeaponId: 'zeus',
  });
  const stale = projectProgram({ ...args, nowMonotonicMs: 108 });
  expect(
    stale.players.find((p) => p.sourcePlayerId === steam64(1))?.equipment.heldWeaponId,
  ).toBeNull();
});

import { describe, expect, it } from 'vitest';

import {
  identityEvidenceFromObservation,
  resolveActiveLineup,
  resolveIdentity,
  unboundIdentityResolution,
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
  projectObserverAssist,
  projectProgram,
  selectProgramSafeRuntimeView,
  observedPlayerDisplayName,
} from '../src/projection/index.js';
import { createSeriesProgress } from '../src/series-progress/index.js';
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
  it.each([
    ['The Beast TomatoDebu', ['The Beast'], 'TomatoDebu'],
    ['THE BEAST | TomatoDebu', ['The Beast'], 'TomatoDebu'],
    ['NJU美少女队｜小 明', ['NJU美少女队'], '小 明'],
    ['Team With Spaces - Player With Spaces', ['Team With Spaces'], 'Player With Spaces'],
    ['The Beast:TomatoDebu', ['The Beast'], 'TomatoDebu'],
    ['The Beast：TomatoDebu', ['The Beast'], 'TomatoDebu'],
    ['The Beast·TomatoDebu', ['The Beast'], 'TomatoDebu'],
    ['The Beast–TomatoDebu', ['The Beast'], 'TomatoDebu'],
    ['The Beast—TomatoDebu', ['The Beast'], 'TomatoDebu'],
    ['TB | TomatoDebu', ['The Beast', 'TB'], 'TomatoDebu'],
    ['The Beast TomatoDebu', ['The', 'The Beast'], 'TomatoDebu'],
    ['The Beast TomatoDebu', [], 'The Beast TomatoDebu'],
    ['Tomato The Beast Debu', ['The Beast'], 'Tomato The Beast Debu'],
    ['The Beasts TomatoDebu', ['The Beast'], 'The Beasts TomatoDebu'],
    ['The BeastTomatoDebu', ['The Beast'], 'The BeastTomatoDebu'],
    ['TB | TomatoDebu', ['The Beast'], 'TB | TomatoDebu'],
    ['Player With Spaces', ['The Beast'], 'Player With Spaces'],
    ['The Beast', ['The Beast'], 'The Beast'],
    ['The Beast | ', ['The Beast'], 'The Beast | '],
    ['The Beast | ', ['The', 'The Beast'], 'The Beast | '],
    ['The Beast', ['The', 'The Beast'], 'The Beast'],
    ['The Beast TomatoDebu', [null, '', ' '], 'The Beast TomatoDebu'],
    [null, ['The Beast'], null],
  ] as const)(
    'presents observed nickname %s only at proven team boundaries',
    (name, teams, expected) => {
      expect(observedPlayerDisplayName(name, teams)).toBe(expected);
    },
  );

  it('uses current side names for neutral telemetry without altering observations or Steam64', () => {
    const original = observation();
    const frame: TelemetryObservation = {
      ...original,
      telemetry: {
        ...original.telemetry,
        map: {
          ...original.telemetry.map,
          sides: { ct: { name: 'The Beast' }, t: { name: 'NJU美少女队' } },
        },
        allPlayers: original.telemetry.allPlayers!.map((item, index) => ({
          ...item,
          displayName: index === 0 ? 'The Beast TomatoDebu' : 'NJU美少女队｜小 明',
        })),
      },
    };
    const project = (input: TelemetryObservation) => {
      const state = acceptedState(input);
      const identity = unboundIdentityResolution();
      return projectProgram({
        runtime: selectProgramSafeRuntimeView(state),
        identity,
        activeLineup: resolvedLineup(state, input, identity),
        nowMonotonicMs: 7,
        continuityPolicy: POLICY,
      });
    };
    const result = project(frame);
    expect(result.players[0]).toMatchObject({
      sourcePlayerId: steam64(1),
      displayName: 'TomatoDebu',
      displayNameSource: 'observed',
    });
    expect(result.players[5]?.displayName).toBe('小 明');
    expect(result.players[1]?.displayName).toBe('NJU美少女队｜小 明');
    expect(frame.telemetry.allPlayers![0]!.displayName).toBe('The Beast TomatoDebu');
    const switched: TelemetryObservation = {
      ...frame,
      telemetry: {
        ...frame.telemetry,
        map: {
          ...frame.telemetry.map,
          sides: { ct: { name: 'Other Team' }, t: { name: 'The Beast' } },
        },
        allPlayers: frame.telemetry.allPlayers!.map((item) => ({
          ...item,
          side: item.side === 'CT' ? 'T' : 'CT',
        })),
      },
    };
    expect(project(switched).players[0]?.displayName).toBe('TomatoDebu');
    expect(
      project({
        ...frame,
        telemetry: { ...frame.telemetry, map: { ...frame.telemetry.map, sides: {} } },
      }).players[0]?.displayName,
    ).toBe('The Beast TomatoDebu');
    expect(
      project({ ...frame, coverage: { ...frame.coverage, map: 'degraded' } }).players[0]
        ?.displayName,
    ).toBe('The Beast TomatoDebu');
  });

  it('preserves canonical nicknames and uses mapped entrant names only for observed fallback', () => {
    const base = contextFixture();
    const context: MatchContext = {
      ...base,
      entrants: {
        ...base.entrants,
        a: {
          ...base.entrants.a,
          name: 'The Beast',
          players: base.entrants.a.players.map((item, index) => ({
            ...item,
            displayName: index === 0 ? null : 'The Beast Official Name',
          })),
        },
      },
    };
    const original = observation();
    const frame: TelemetryObservation = {
      ...original,
      telemetry: {
        ...original.telemetry,
        map: { ...original.telemetry.map, sides: {} },
        allPlayers: original.telemetry.allPlayers!.map((item) => ({
          ...item,
          displayName: 'The Beast TomatoDebu',
        })),
      },
    };
    const state = acceptedState(frame);
    const identity = matchedIdentity(context, frame);
    const input = {
      runtime: selectProgramSafeRuntimeView(state),
      context,
      identity,
      activeLineup: resolvedLineup(state, frame, identity, context),
      nowMonotonicMs: 7,
      continuityPolicy: POLICY,
    };
    expect(projectProgram(input).players[0]).toMatchObject({
      displayName: 'TomatoDebu',
      displayNameSource: 'observed',
      canonicalPlayerId: 'a-player-1',
    });
    expect(projectProgram(input).players[1]).toMatchObject({
      displayName: 'The Beast Official Name',
      displayNameSource: 'canonical',
    });
    expect(
      projectProgram({ ...input, identity: { ...identity, mapEpoch: identity.mapEpoch + 1 } })
        .players[0]?.displayName,
    ).toBe('The Beast TomatoDebu');
    expect(identity.players[0]?.observedDisplayName).toBe('The Beast TomatoDebu');
  });

  it('keeps selected match facts for control while projecting neutral unbound demo branding', () => {
    const context = contextFixture();
    const frame = observation(true);
    const state = acceptedState(frame);
    const identity = matchedIdentity(context, frame);
    const input = {
      runtime: selectProgramSafeRuntimeView(state),
      context,
      identity,
      activeLineup: resolvedLineup(state, frame, identity, context),
      seriesProgress: { ...createSeriesProgress(context), bindingState: 'needs_operator' as const },
      nowMonotonicMs: 7,
      continuityPolicy: POLICY,
    };
    expect(projectProgram(input).match?.matchId).toBe(context.matchId);
    const gameplay = projectProgram({ ...input, presentationRole: 'gameplay' });
    expect(gameplay.match).toBeNull();
    expect(gameplay.series).toBeNull();
    expect(gameplay.teams.ct).toMatchObject({ mode: 'neutral', name: 'CT', logoUrl: null });
    expect(gameplay.players.every((player) => player.canonicalPlayerId === null)).toBe(true);
    expect(gameplay.map.score).toEqual(projectProgram(input).map.score);
  });
  it('projects deterministic canonical Program data without mutating RuntimeState', () => {
    const context = contextFixture();
    const input = observation(true);
    const state = acceptedState(input);
    const before = structuredClone(state);
    const identity = matchedIdentity(context, input);
    const activeLineup = resolvedLineup(state, input, identity, context);
    const seriesProgress = createSeriesProgress(context);
    const runtime = selectProgramSafeRuntimeView(state);

    const first = projectProgram({
      runtime,
      context,
      identity,
      activeLineup,
      seriesProgress,
      nowMonotonicMs: 7,
      continuityPolicy: POLICY,
    });
    const second = projectProgram({
      runtime,
      context,
      identity,
      activeLineup,
      seriesProgress,
      nowMonotonicMs: 7,
      continuityPolicy: POLICY,
    });

    expect(first).toEqual(second);
    expect(state).toEqual(before);
    expect(first.status).toEqual({ telemetry: 'fresh', context: 'fresh', identity: 'matched' });
    expect(first.teams.ct).toMatchObject({
      mode: 'canonical',
      entryId: 'a',
      name: 'Alpha',
      seriesScore: 1,
    });
    expect(first.teams.t).toMatchObject({
      mode: 'canonical',
      entryId: 'b',
      name: 'Bravo',
      seriesScore: 0,
    });
    expect(first.players.map((item) => item.sourcePlayerId)).toEqual(
      [...first.players].map((item) => item.sourcePlayerId).sort(),
    );
    expect(first.players[0]?.weapons.map((item) => item.sourceWeaponId)).toEqual([
      'weapon-a',
      'weapon-z',
    ]);
    expect(first.players.map((item) => item.lifeState)).toEqual([
      'alive',
      'dead',
      'dead',
      'dead',
      'dead',
      'dead',
      'dead',
      'dead',
      'dead',
      'dead',
    ]);
    expect(first.players[0]).not.toHaveProperty('position');
    expect(first.bomb).not.toHaveProperty('position');
    expect(first).not.toHaveProperty('lookahead');
    expect(first).not.toHaveProperty('identityIssues');
  });

  it('keeps normalized values and local series facts while marking telemetry stale', () => {
    const context = contextFixture();
    const input = observation();
    const state = acceptedState(input);
    const identity = matchedIdentity(context, input);
    const activeLineup = resolvedLineup(state, input, identity, context);
    const seriesProgress = createSeriesProgress(context);
    const projection = projectProgram({
      runtime: selectProgramSafeRuntimeView(state),
      context,
      contextFreshness: 'stale',
      identity,
      activeLineup,
      seriesProgress,
      nowMonotonicMs: 108,
      continuityPolicy: POLICY,
    });

    expect(projection.status.telemetry).toBe('stale');
    expect(projection.status.context).toBe('stale');
    expect(projection.teams.ct.seriesScore).toBe(1);
    expect(projection.teams.t.seriesScore).toBe(0);
    expect(projection.map.name).toBe('de_mirage');
    expect(projection.clock?.endsInSeconds).toBe(42);
  });

  it('does not guess a Player Rails cohort from partial allplayers evidence', () => {
    const context = contextFixture();
    const input = observation();
    const state = acceptedState(input);
    const partialInput: TelemetryObservation = {
      ...input,
      telemetry: {
        ...input.telemetry,
        allPlayers: input.telemetry.allPlayers!.slice(0, 1),
      },
    };
    const identity = resolveIdentity(
      context,
      identityEvidenceFromObservation(partialInput, 0, state.map.epoch),
    );
    const partialState = state.programTelemetry
      ? {
          ...state,
          programTelemetry: { ...state.programTelemetry, telemetry: partialInput.telemetry },
        }
      : state;
    const partialLineup = resolvedLineup(partialState, partialInput, identity, context);
    const projection = projectProgram({
      runtime: selectProgramSafeRuntimeView(partialState),
      context,
      identity,
      activeLineup: partialLineup,
      nowMonotonicMs: 7,
      continuityPolicy: POLICY,
    });

    expect(identity.state).toBe('degraded');
    expect(identity.capabilities.canonicalPlayerMapping).toBe(true);
    expect(projection.teams.ct.mode).toBe('neutral');
    expect(projection.players).toEqual([]);
  });

  it('keeps live players visible for a soft roster mismatch', () => {
    const context = contextFixture();
    const input = observation();
    const state = acceptedState(input);
    const identity = matchedIdentity(context, input);
    const unexpected = player(20, 'T');
    const mismatchInput: TelemetryObservation = {
      ...input,
      telemetry: {
        ...input.telemetry,
        allPlayers: [...(input.telemetry.allPlayers?.slice(1) ?? []), unexpected],
      },
    };
    const mismatchIdentity = resolveIdentity(
      context,
      identityEvidenceFromObservation(mismatchInput, 0, state.map.epoch),
    );
    const activeLineup = resolvedLineup(state, input, identity, context);
    const mismatchProjection = projectProgram({
      runtime: selectProgramSafeRuntimeView(state),
      context,
      identity: mismatchIdentity,
      activeLineup,
      nowMonotonicMs: 7,
      continuityPolicy: POLICY,
    });
    const unboundProjection = projectProgram({
      runtime: selectProgramSafeRuntimeView(state),
      context,
      identity: unboundIdentityResolution(),
      activeLineup,
      nowMonotonicMs: 7,
      continuityPolicy: POLICY,
    });

    expect(mismatchIdentity.state).toBe('degraded');
    expect(mismatchProjection.map.name).toBe('de_mirage');
    expect(mismatchProjection.teams.ct.mode).toBe('canonical');
    expect(
      mismatchProjection.players.filter((item) => item.canonicalPlayerId === null),
    ).toHaveLength(1);
    expect(
      mismatchProjection.players.filter((item) => item.canonicalPlayerId !== null),
    ).toHaveLength(9);
    expect(unboundProjection.status.identity).toBe('unbound');
    expect(unboundProjection.teams.ct.mode).toBe('neutral');
    expect(unboundProjection.players[0]?.displayName).toBe('Observed 1');
  });

  it('retains a missing lineup member without fabricating its volatile telemetry', () => {
    const context = contextFixture();
    const input = observation();
    const state = acceptedState(input);
    const identity = matchedIdentity(context, input);
    const baseline = resolveActiveLineup({
      sourceGeneration: 0,
      mapEpoch: state.map.epoch,
      allPlayers: input.telemetry.allPlayers!,
      allPlayersCoverage: 'present',
      context,
      identity,
    });
    const missingSourcePlayerId = baseline.ct[0]!.sourcePlayerId;
    const currentPlayers = input.telemetry.allPlayers!.filter(
      (player) => player.sourcePlayerId !== missingSourcePlayerId,
    );
    const retained = resolveActiveLineup({
      sourceGeneration: 0,
      mapEpoch: state.map.epoch,
      allPlayers: currentPlayers,
      allPlayersCoverage: 'present',
      context,
      identity,
      previous: baseline,
    });
    const projection = projectProgram({
      runtime: selectProgramSafeRuntimeView(state),
      context,
      identity,
      activeLineup: retained,
      nowMonotonicMs: 7,
      continuityPolicy: POLICY,
    });
    const missing = projection.players.find(
      (player) => player.sourcePlayerId === missingSourcePlayerId,
    );

    expect(missing).toMatchObject({
      lineupEvidence: 'retained',
      observerSlot: null,
      activity: null,
      lifeState: 'unknown',
      state: null,
      matchStats: null,
      weapons: [],
    });
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

  it('keeps the Observer Assist seam unavailable and free of future fields', () => {
    const state = acceptedState(observation());
    const assist = projectObserverAssist(selectProgramSafeRuntimeView(state));

    expect(assist.availability).toBe('unavailable');
    expect(Object.keys(assist).sort()).toEqual(['availability', 'cursor']);
    expect(assist).not.toHaveProperty('future');
    expect(assist).not.toHaveProperty('cue');
  });

  it('keeps absent and degraded allplayers frame-local instead of inventing player LKG', () => {
    const context = contextFixture();
    const input = observation();
    const state = acceptedState(input);
    const identity = matchedIdentity(context, input);
    const telemetryWithoutPlayers = { ...state.programTelemetry!.telemetry };
    delete telemetryWithoutPlayers.allPlayers;
    const absent = projectProgram({
      runtime: selectProgramSafeRuntimeView({
        ...state,
        programTelemetry: {
          ...state.programTelemetry!,
          coverage: { ...state.programTelemetry!.coverage, allPlayers: 'absent' },
          telemetry: telemetryWithoutPlayers,
        },
      }),
      context,
      identity,
      activeLineup: resolvedLineup(
        state,
        {
          ...input,
          coverage: { ...input.coverage, allPlayers: 'absent' },
          telemetry: telemetryWithoutPlayers,
        },
        identity,
        context,
      ),
      nowMonotonicMs: 7,
      continuityPolicy: POLICY,
    });
    const degraded = projectProgram({
      runtime: selectProgramSafeRuntimeView({
        ...state,
        programTelemetry: {
          ...state.programTelemetry!,
          coverage: { ...state.programTelemetry!.coverage, allPlayers: 'degraded' },
        },
      }),
      context,
      identity,
      activeLineup: resolvedLineup(
        state,
        { ...input, coverage: { ...input.coverage, allPlayers: 'degraded' } },
        identity,
        context,
      ),
      nowMonotonicMs: 7,
      continuityPolicy: POLICY,
    });

    expect(absent.coverage.allPlayers).toBe('absent');
    expect(absent.players).toEqual([]);
    expect(degraded.coverage.allPlayers).toBe('degraded');
    expect(degraded.players).toEqual([]);
  });
});

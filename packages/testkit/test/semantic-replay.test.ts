import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { emptyActiveLineup, unboundIdentityResolution } from '@mizar/core/identity';
import { projectProgram, selectProgramSafeRuntimeView } from '@mizar/core/projection';
import { createInitialRuntimeState, reduceRuntime } from '@mizar/core/runtime';
import { iterateCaptureFrames, verifyCapture } from '../src/capture/reader.js';
import type { VerifiedCapture } from '../src/capture/types.js';
import { replayCapture } from '../src/replay/runner.js';
import type { ReplayedGsiFrame } from '../src/replay/types.js';

const RECOVERED_MATCH_SOURCE_CAPTURE_ID = '20260914T060149Z-4cda66b7-recovered-match';
const RECOVERED_MATCH_SOURCE_FRAMES_SHA256 =
  '7a2dfed10f28903de6a94e782ca3f0955593fe2f653e7e831e05305d8e99347a';
const WARMUP_SOURCE_CAPTURE_ID = '20260913T161643Z-56b6492b';
const WARMUP_SOURCE_FRAMES_SHA256 =
  '519cec4f94f93b2cbc3b34d5e32d60e428039a94b3999d058a56910afcd7c5f9';
const BOT_SOURCE_CAPTURE_ID = '20260913T162802Z-3f41d8df';
const BOT_SOURCE_FRAMES_SHA256 = 'e34505e2626dfa6f0941b8b4ed675dbea38e2ff53e29e3240c36ad7a2673d218';

const SOURCES = {
  match: [RECOVERED_MATCH_SOURCE_CAPTURE_ID, RECOVERED_MATCH_SOURCE_FRAMES_SHA256],
  warmup: [WARMUP_SOURCE_CAPTURE_ID, WARMUP_SOURCE_FRAMES_SHA256],
  bot: [BOT_SOURCE_CAPTURE_ID, BOT_SOURCE_FRAMES_SHA256],
} as const;
const SEMANTIC_FIXTURES = [
  ['observer/rich-live-state', 'match', 727, 727, 1],
  ['observer/missing-player-identity', 'match', 3, 14, 12],
  ['bomb/plant', 'match', 1015, 1029, 15],
  ['bomb/dropped', 'match', 260, 260, 1],
  ['bomb/defuse', 'match', 5522, 5544, 23],
  ['bomb/explode-reset', 'match', 1193, 1214, 22],
  ['match/halftime-side-switch', 'match', 6145, 6147, 3],
  ['match/regulation-to-overtime', 'match', 13096, 13130, 35],
  ['match/overtime-side-switch', 'match', 14461, 14463, 3],
  ['match/gameover', 'match', 16260, 16261, 2],
  ['match/paused', 'match', 3605, 3605, 1],
  ['match/timeout-ct', 'match', 2109, 2109, 1],
  ['match/timeout-t', 'match', 4489, 4489, 1],
  ['warmup/observer', 'warmup', 45, 45, 1],
  ['local-bot/numeric-player-id', 'bot', 540, 540, 1],
] as const;
const fixtureCases = SEMANTIC_FIXTURES.map(
  ([name, source, firstSequence, lastSequence, frameCount]) => ({
    name,
    sourceCaptureId: SOURCES[source][0],
    sourceFramesSha256: SOURCES[source][1],
    firstSequence,
    lastSequence,
    frameCount,
  }),
);

function semanticCapturePath(name: string): string {
  return resolve(process.cwd(), 'fixtures/gsi/semantic', name);
}

async function replayResultsAt(
  capture: VerifiedCapture,
  sequences: readonly number[],
): Promise<ReadonlyMap<number, ReplayedGsiFrame['result']>> {
  const wanted = new Set(sequences);
  const results = new Map<number, ReplayedGsiFrame['result']>();
  for await (const event of replayCapture(capture, { mode: { kind: 'step' } })) {
    if (event.kind === 'frame' && wanted.has(event.sourceFrame.sequence)) {
      results.set(event.sourceFrame.sequence, event.result);
    }
  }
  return results;
}

function resultAt(
  results: ReadonlyMap<number, ReplayedGsiFrame['result']>,
  sequence: number,
): ReplayedGsiFrame['result'] {
  const result = results.get(sequence);
  if (result === undefined) throw new Error(`missing replay result for seq=${sequence}`);
  return result;
}

function successfulObservation(
  result: ReplayedGsiFrame['result'],
  sequence: number,
): Extract<ReplayedGsiFrame['result'], { readonly ok: true }>['observation'] {
  expect(result.ok, `production replay failed at seq=${sequence}`).toBe(true);
  if (!result.ok) throw new Error(`production replay failed at seq=${sequence}`);
  return result.observation;
}

function sideNames(observation: ReturnType<typeof successfulObservation>) {
  return {
    ct: observation.telemetry.map?.sides?.ct?.name,
    t: observation.telemetry.map?.sides?.t?.name,
  };
}

describe('semantic real-evidence capture replay', () => {
  it.each(fixtureCases)(
    '$name verifies capture integrity, provenance, and selected boundaries',
    async (fixture) => {
      const capture = await verifyCapture(semanticCapturePath(fixture.name));
      expect(capture.manifest.frameCount).toBe(fixture.frameCount);
      expect(capture.manifest.provenance).toMatchObject({
        fixtureKind: 'sanitized-real-capture',
        sourceCaptureId: fixture.sourceCaptureId,
        sourceFramesSha256: fixture.sourceFramesSha256,
        sourceFrameSelection: {
          kind: 'sequence-range',
          firstSequence: fixture.firstSequence,
          lastSequence: fixture.lastSequence,
        },
        sanitizerVersion: 2,
        lifecycleCoverage: 'partial',
      });

      const firstAndLast: number[] = [];
      for await (const frame of iterateCaptureFrames(capture)) {
        if (firstAndLast.length === 0) firstAndLast.push(frame.sequence);
        firstAndLast[1] = frame.sequence;
      }
      expect(firstAndLast).toEqual([fixture.firstSequence, fixture.lastSequence]);
    },
  );

  it('normalizes rich observer state from real match evidence', async () => {
    const capture = await verifyCapture(semanticCapturePath('observer/rich-live-state'));
    const results = await replayResultsAt(capture, [727]);
    const observation = successfulObservation(resultAt(results, 727), 727);
    const telemetry = observation.telemetry;

    expect(telemetry.allPlayers).toHaveLength(10);
    const player = telemetry.allPlayers?.find(
      (candidate) => candidate.sourcePlayerId === '76561197960690195',
    );
    expect(player).toMatchObject({
      position: { x: -498, y: 653.9, z: 144.4 },
      forward: { x: 0.092, y: -0.979, z: -0.18 },
    });
    expect(player?.weapons).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'weapon_m4a1_silencer', state: 'reloading' }),
      ]),
    );
    expect(
      telemetry.allPlayers?.some((candidate) => candidate.state?.roundTotalDamage !== undefined),
    ).toBe(true);
    expect(
      telemetry.allPlayers?.some((candidate) => candidate.state?.hasDefuser !== undefined),
    ).toBe(true);
    expect(telemetry.phaseCountdowns?.phase).toBe('live');

    const grenades = telemetry.grenades;
    if (grenades === undefined) throw new Error('rich observer evidence has no grenades');
    expect(grenades.length).toBeGreaterThan(0);
    expect(grenades.map((grenade) => grenade.kind)).toEqual(
      expect.arrayContaining(['frag', 'inferno']),
    );
    const inferno = grenades.find((grenade) => grenade.kind === 'inferno');
    if (inferno === undefined) throw new Error('rich observer evidence has no inferno');
    expect(inferno.flames?.length).toBeGreaterThan(0);
    expect(inferno.flames?.[0]?.position).toEqual({ x: 496, y: -804, z: 113 });
  });

  it('degrades root player when observer frame has no source identity', async () => {
    const capture = await verifyCapture(semanticCapturePath('observer/missing-player-identity'));
    const results = await replayResultsAt(capture, [3, 4, 14]);

    expect(successfulObservation(resultAt(results, 3), 3).telemetry.player).toBeDefined();
    const missingIdentity = successfulObservation(resultAt(results, 4), 4);
    expect(missingIdentity.coverage.player).toBe('degraded');
    expect(missingIdentity.telemetry.player).toBeUndefined();
    expect(successfulObservation(resultAt(results, 14), 14).telemetry.player).toBeDefined();
  });

  it('observes bomb plant lifecycle', async () => {
    const capture = await verifyCapture(semanticCapturePath('bomb/plant'));
    const results = await replayResultsAt(capture, [1015, 1016, 1029]);

    expect(successfulObservation(resultAt(results, 1015), 1015).telemetry.bomb?.state).toBe(
      'carried',
    );
    expect(successfulObservation(resultAt(results, 1016), 1016).telemetry.bomb?.state).toBe(
      'planting',
    );
    const planted = successfulObservation(resultAt(results, 1029), 1029);
    expect(planted.telemetry.bomb?.state).toBe('planted');
    expect(planted.telemetry.round?.bomb).toEqual({ state: 'planted' });
  });

  it('normalizes a dropped bomb from real match evidence', async () => {
    const capture = await verifyCapture(semanticCapturePath('bomb/dropped'));
    const results = await replayResultsAt(capture, [260]);
    const observation = successfulObservation(resultAt(results, 260), 260);

    expect(observation.telemetry.bomb?.state).toBe('dropped');
  });

  it('observes bomb defuse lifecycle', async () => {
    const capture = await verifyCapture(semanticCapturePath('bomb/defuse'));
    const results = await replayResultsAt(capture, [5523, 5543, 5544]);

    expect(successfulObservation(resultAt(results, 5523), 5523).telemetry.bomb?.state).toBe(
      'defusing',
    );
    expect(successfulObservation(resultAt(results, 5543), 5543).telemetry.bomb?.state).toBe(
      'defused',
    );
    const defused = successfulObservation(resultAt(results, 5544), 5544);
    expect(defused.telemetry.round).toEqual({
      phase: 'over',
      bomb: { state: 'defused' },
      winnerSide: 'CT',
    });
  });

  it('replays planted then defusing evidence through Core objective timing', async () => {
    const capture = await verifyCapture(semanticCapturePath('bomb/defuse'));
    const results = await replayResultsAt(capture, [5522, 5523]);
    const planted = successfulObservation(resultAt(results, 5522), 5522);
    const defusing = successfulObservation(resultAt(results, 5523), 5523);
    const policy = { staleAfterMs: 20_000, objectiveClockLeaseMs: 1_000 } as const;
    let state = createInitialRuntimeState('semantic-objective-clock');
    state = reduceRuntime(
      state,
      { kind: 'program-telemetry', sourceGeneration: 0, observation: planted },
      policy,
    ).state;
    state = reduceRuntime(
      state,
      { kind: 'program-telemetry', sourceGeneration: 0, observation: defusing },
      policy,
    ).state;

    expect(state.objectiveTiming.explosionAnchor).toMatchObject({
      remainingSecondsAtSample: 28.708,
      source: 'bomb-planted-countdown',
    });
    const projection = projectProgram({
      runtime: selectProgramSafeRuntimeView(state),
      identity: unboundIdentityResolution(),
      activeLineup: emptyActiveLineup(state.programSource.generation, state.map.epoch),
      nowMonotonicMs: defusing.receive.receivedMonotonicMs,
      continuityPolicy: policy,
    });
    expect(projection.bomb).toMatchObject({
      state: 'defusing',
      sourcePlayerId: '76561198164970560',
      explosion: {
        durationSeconds: null,
      },
      action: {
        kind: 'defuse',
        sourcePlayerId: '76561198164970560',
        remainingSeconds: 5.034,
        durationSeconds: 5,
        hasDefuseKit: true,
      },
    });
    expect(projection.bomb?.explosion?.remainingSeconds).toBeCloseTo(28.455814, 5);
  });

  it('observes bomb explode and round reset', async () => {
    const capture = await verifyCapture(semanticCapturePath('bomb/explode-reset'));
    const results = await replayResultsAt(capture, [1194, 1214]);

    const exploded = successfulObservation(resultAt(results, 1194), 1194);
    expect(exploded.telemetry.bomb?.state).toBe('exploded');
    expect(exploded.telemetry.round).toEqual({
      phase: 'over',
      bomb: { state: 'exploded' },
      winnerSide: 'T',
    });

    const freezetime = successfulObservation(resultAt(results, 1214), 1214);
    expect(freezetime.telemetry.round).toEqual({ phase: 'freezetime' });
    expect(freezetime.telemetry.round).not.toHaveProperty('bomb');
    expect(freezetime.telemetry.round).not.toHaveProperty('winnerSide');
    expect(freezetime.telemetry.bomb).toMatchObject({ state: 'carried' });
  });

  it.each([
    ['paused', 'match/paused', 3605],
    ['timeout_ct', 'match/timeout-ct', 2109],
    ['timeout_t', 'match/timeout-t', 4489],
  ] as const)('normalizes observed %s phase countdown', async (phase, fixtureName, sequence) => {
    const capture = await verifyCapture(semanticCapturePath(fixtureName));
    const results = await replayResultsAt(capture, [sequence]);
    const observation = successfulObservation(resultAt(results, sequence), sequence);
    expect(observation.telemetry.phaseCountdowns?.phase).toBe(phase);
  });

  it('preserves team identity across halftime side switch', async () => {
    const capture = await verifyCapture(semanticCapturePath('match/halftime-side-switch'));
    const results = await replayResultsAt(capture, [6145, 6147]);
    const before = successfulObservation(resultAt(results, 6145), 6145);
    const after = successfulObservation(resultAt(results, 6147), 6147);

    expect(sideNames(before)).toEqual({ ct: 'FURIA', t: 'G2.Esports' });
    expect(sideNames(after)).toEqual({ ct: 'G2.Esports', t: 'FURIA' });
  });

  it('observes regulation to overtime transition', async () => {
    const capture = await verifyCapture(semanticCapturePath('match/regulation-to-overtime'));
    const results = await replayResultsAt(capture, [13096, 13130]);
    const regulation = successfulObservation(resultAt(results, 13096), 13096);
    const overtime = successfulObservation(resultAt(results, 13130), 13130);

    expect(regulation.telemetry.map).toMatchObject({
      phase: 'intermission',
      roundNumber: 24,
      sides: { ct: { score: 12 }, t: { score: 12 } },
    });
    expect(overtime.telemetry.map).toMatchObject({
      phase: 'live',
      roundNumber: 24,
      sides: { ct: { score: 12 }, t: { score: 12 } },
    });
    expect(overtime.telemetry.round?.phase).toBe('freezetime');
  });

  it('preserves team identity across overtime side switch', async () => {
    const capture = await verifyCapture(semanticCapturePath('match/overtime-side-switch'));
    const results = await replayResultsAt(capture, [14461, 14463]);
    const before = successfulObservation(resultAt(results, 14461), 14461);
    const after = successfulObservation(resultAt(results, 14463), 14463);

    expect(sideNames(before)).toEqual({ ct: 'G2.Esports', t: 'FURIA' });
    expect(sideNames(after)).toEqual({ ct: 'FURIA', t: 'G2.Esports' });
  });

  it('observes final round to gameover', async () => {
    const capture = await verifyCapture(semanticCapturePath('match/gameover'));
    const results = await replayResultsAt(capture, [16260, 16261]);
    const finalRound = successfulObservation(resultAt(results, 16260), 16260);
    const gameover = successfulObservation(resultAt(results, 16261), 16261);

    expect(finalRound.telemetry.round?.bomb).toEqual({ state: 'planted' });
    expect(gameover.telemetry.map).toMatchObject({
      phase: 'gameover',
      roundNumber: 30,
      sides: { ct: { score: 14 }, t: { score: 16 } },
    });
    expect(gameover.telemetry.round).toEqual({ phase: 'freezetime', winnerSide: 'T' });
    expect(gameover.telemetry.bomb?.state).toBe('exploded');
  });

  it('accepts numeric local-BOT source player identifiers', async () => {
    const capture = await verifyCapture(semanticCapturePath('local-bot/numeric-player-id'));
    const results = await replayResultsAt(capture, [540]);
    const observation = successfulObservation(resultAt(results, 540), 540);
    const playerIds = observation.telemetry.allPlayers?.map((player) => player.sourcePlayerId);

    expect(playerIds).toEqual(
      expect.arrayContaining(['309', '313', '317', '321', '323', '333', '337']),
    );
  });

  it('accepts warmup observer evidence', async () => {
    const capture = await verifyCapture(semanticCapturePath('warmup/observer'));
    const results = await replayResultsAt(capture, [45]);
    const observation = successfulObservation(resultAt(results, 45), 45);

    expect(observation.telemetry.phaseCountdowns).toEqual({ phase: 'warmup', endsInSeconds: 7.4 });
    expect(observation.telemetry.allPlayers).toHaveLength(10);
  });

  it('preserves public identity and excludes secrets from committed semantic fixture bytes', async () => {
    for (const fixture of fixtureCases) {
      const dir = semanticCapturePath(fixture.name);
      const [manifest, frames] = await Promise.all([
        readFile(resolve(dir, 'manifest.json'), 'utf8'),
        readFile(resolve(dir, 'frames.jsonl'), 'utf8'),
      ]);
      const bytes = `${manifest}\n${frames}`;
      expect(bytes).not.toMatch(/fixture-player-|Fixture Player \d+|Fixture Team \d+/i);
      expect(bytes).not.toMatch(
        /"(?:auth|authorization|cookie|setcookie|token|password|passwd|secret|api[_-]?key)"\s*:/i,
      );
      expect(bytes).not.toMatch(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/i);
    }
    const publicMatch = await readFile(
      resolve(semanticCapturePath('observer/rich-live-state'), 'frames.jsonl'),
      'utf8',
    );
    expect(publicMatch).toContain('76561197960690195');
    expect(publicMatch).toContain('FalleN');
  });
});

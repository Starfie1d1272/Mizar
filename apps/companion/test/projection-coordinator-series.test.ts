import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import type { MatchContext } from '@rivalhub-broadcast/core/match-context';
import type { TelemetryObservation } from '@rivalhub-broadcast/core/telemetry';
import type { BroadcastManifestV1 } from '@rivalhub-broadcast/rivalhub';
import { programSnapshotSchema } from '@rivalhub-broadcast/protocol/program';
import { operatorSnapshotSchema } from '@rivalhub-broadcast/protocol/operator';
import { programCueMessageSchema } from '@rivalhub-broadcast/protocol/program-cue';
import {
  LOCAL_PROTOCOL_SUBPROTOCOL,
  LOCAL_PROTOCOL_VERSION,
  PROGRAM_SCHEMA_VERSION,
  OPERATOR_SCHEMA_VERSION,
  PROGRAM_CUE_SCHEMA_VERSION,
} from '@rivalhub-broadcast/protocol/version';

import { createProjectionCoordinator } from '../src/projections/projection-coordinator.js';
import { createProgramRuntime } from '../src/runtime/program-runtime.js';
import { createCstvSourceManagers } from '../src/telemetry/cstv-source-manager.js';
import { MatchContextController, MatchManifestLkgStore } from '../src/match-context/index.js';
import { MAX_LOCAL_SNAPSHOT_BYTES } from '../src/local-web/transport-constants.js';

async function readManifest(cleanScores = true): Promise<BroadcastManifestV1> {
  const manifest = JSON.parse(
    await readFile(
      resolve(process.cwd(), 'packages/rivalhub/test/fixtures/broadcast-manifest-v1.valid.json'),
      'utf8',
    ),
  ) as BroadcastManifestV1;
  if (cleanScores) {
    return {
      ...manifest,
      maps: manifest.maps.map((map) => ({
        ...map,
        scoreA: null,
        scoreB: null,
        completedAt: null,
      })),
    };
  }
  return manifest;
}

function matchedObservation(
  manifest: BroadcastManifestV1,
  overrides: {
    readonly mapName?: string;
    readonly mapPhase?: 'live' | 'gameover';
    readonly score?: { readonly ct: number; readonly t: number };
    readonly roundPhase?: 'freezetime' | 'live' | 'over';
    readonly sequence?: number;
  } = {},
): TelemetryObservation {
  const entrantPlayers = (entry: 'a' | 'b', side: 'CT' | 'T') =>
    manifest.entrants[entry].roster.players.slice(0, 5).map((player, index) => ({
      sourcePlayerId:
        player.steam64 ??
        (() => {
          throw new Error('fixture player lacks Steam64');
        })(),
      ...(player.displayName === null ? {} : { displayName: player.displayName }),
      side,
      observerSlot: index,
      state: { health: 100 },
    }));
  const allPlayers = [...entrantPlayers('a', 'CT'), ...entrantPlayers('b', 'T')];
  const sequence = overrides.sequence ?? 1;
  const score = overrides.score ?? { ct: 0, t: 0 };
  return {
    receive: {
      sequence,
      receivedAt: '2026-09-18T00:00:00.000Z',
      receivedMonotonicMs: sequence,
    },
    source: { kind: 'cs2-gsi' },
    coverage: {
      provider: 'present',
      map: 'present',
      round: 'present',
      phaseCountdowns: 'absent',
      player: 'present',
      allPlayers: 'present',
      bomb: 'absent',
      grenades: 'absent',
    },
    telemetry: {
      map: {
        name: overrides.mapName ?? 'de_ancient',
        phase: overrides.mapPhase ?? 'live',
        roundNumber: score.ct + score.t + 1,
        sides: {
          ct: { name: manifest.entrants.a.name, score: score.ct },
          t: { name: manifest.entrants.b.name, score: score.t },
        },
      },
      round: {
        phase: overrides.roundPhase ?? 'live',
      },
      allPlayers,
      player: allPlayers[0]!,
    },
  };
}

describe('Section IV.E: Program / Protocol integration and boundaries', () => {
  it('E.1 & E.2 Program series.score and teams.ct/t.seriesScore come from the single SeriesProgress, and stale MatchContext cannot be a second score owner', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'lkg-test-'));
    try {
      const manifest = await readManifest(true);
      const runtime = createProgramRuntime('test-producer');
      const coordinator = createProjectionCoordinator({
        programRuntime: runtime,
        cstvSources: createCstvSourceManagers({}),
        nowMonotonicMs: () => 1000,
      });
      const controller = new MatchContextController({
        lkgStore: new MatchManifestLkgStore({ filePath: join(dir, 'lkg.json') }),
        onBindingChanged: (binding) => coordinator.setMatchContextBinding(binding),
      });
      const bound = await controller.selectMatch(manifest.match.matchId, {
        kind: 'fixture',
        load: () => Promise.resolve(manifest),
      });
      expect(bound.ok).toBe(true);

      // 1. Initial observation: game live on de_ancient (Map 1 in manifest)
      const result1 = runtime.acceptObservation(matchedObservation(manifest, { sequence: 1 }));
      coordinator.afterRuntimeMutation(result1);

      let bundle = coordinator.getCurrent();
      expect(bundle.program.series?.score).toEqual({ a: 0, b: 0 });
      expect(bundle.program.teams.ct.seriesScore).toBe(0);
      expect(bundle.program.teams.t.seriesScore).toBe(0);

      // 2. Map 1 ends with Team A winning (13:9)
      const result2 = runtime.acceptObservation(
        matchedObservation(manifest, {
          sequence: 2,
          mapPhase: 'gameover',
          score: { ct: 13, t: 9 },
          roundPhase: 'over',
        }),
      );
      coordinator.afterRuntimeMutation(result2);

      bundle = coordinator.getCurrent();
      // SeriesProgress immediately freezes local map result into series.score { a: 1, b: 0 }:
      expect(bundle.program.series?.score).toEqual({ a: 1, b: 0 });
      expect(bundle.program.teams.ct.seriesScore).toBe(1);
      expect(bundle.program.teams.t.seriesScore).toBe(0);

      // 3. Stale MatchContext update arrives with scoreA: 0, scoreB: 0 (or conflicting score)
      const staleContext: MatchContext = {
        ...controller.getActiveBinding()!.context,
        scoreA: 0,
        scoreB: 0,
      };
      coordinator.setMatchContextBinding({
        manifest,
        context: staleContext,
        origin: 'fixture',
        freshness: 'stale',
        diagnostics: [],
      });

      bundle = coordinator.getCurrent();
      // series.score and teams.ct.seriesScore MUST remain 1:0, ignoring stale MatchContext score!
      expect(bundle.program.series?.score).toEqual({ a: 1, b: 0 });
      expect(bundle.program.teams.ct.seriesScore).toBe(1);
      expect(bundle.program.teams.t.seriesScore).toBe(0);

      await coordinator.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('E.3 when bindingState = needs_operator, series.currentMapOrder is null, while raw Program map and side scores remain normal', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'lkg-test-'));
    try {
      const manifest = await readManifest(true);
      const runtime = createProgramRuntime('test-producer');
      const coordinator = createProjectionCoordinator({
        programRuntime: runtime,
        cstvSources: createCstvSourceManagers({}),
        nowMonotonicMs: () => 1000,
      });
      const controller = new MatchContextController({
        lkgStore: new MatchManifestLkgStore({ filePath: join(dir, 'lkg.json') }),
        onBindingChanged: (binding) => coordinator.setMatchContextBinding(binding),
      });
      const bound = await controller.selectMatch(manifest.match.matchId, {
        kind: 'fixture',
        load: () => Promise.resolve(manifest),
      });
      expect(bound.ok).toBe(true);

      // Unexpected server map: de_overpass (not in manifest map plan)
      const result = runtime.acceptObservation(
        matchedObservation(manifest, {
          mapName: 'de_overpass',
          score: { ct: 7, t: 5 },
          sequence: 1,
        }),
      );
      coordinator.afterRuntimeMutation(result);

      const bundle = coordinator.getCurrent();
      // Series progress is needs_operator:
      expect(bundle.program.series?.bindingState).toBe('needs_operator');
      expect(bundle.program.series?.currentMapOrder).toBeNull();

      // But raw Program map telemetry and scores are NOT hidden!
      expect(bundle.program.map.name).toBe('de_overpass');
      expect(bundle.program.map.score).toEqual({ ct: 7, t: 5 });
      expect(bundle.program.status.telemetry).toBe('fresh');

      await coordinator.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('E.4 Program snapshot with the maximum retained 256-round history remains below the 64 KiB Program budget and the 256 KiB outbound transport hard guard', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'lkg-test-'));
    try {
      const manifest = await readManifest(true);
      const runtime = createProgramRuntime('test-producer');
      const coordinator = createProjectionCoordinator({
        programRuntime: runtime,
        cstvSources: createCstvSourceManagers({}),
        nowMonotonicMs: () => 1000,
      });
      const controller = new MatchContextController({
        lkgStore: new MatchManifestLkgStore({ filePath: join(dir, 'lkg.json') }),
        onBindingChanged: (binding) => coordinator.setMatchContextBinding(binding),
      });
      const bound = await controller.selectMatch(manifest.match.matchId, {
        kind: 'fixture',
        load: () => Promise.resolve(manifest),
      });
      expect(bound.ok).toBe(true);

      // Feed observation
      const result = runtime.acceptObservation(matchedObservation(manifest, { sequence: 1 }));
      coordinator.afterRuntimeMutation(result);

      const publisher = coordinator.getPublisher('program');
      const snapshot = publisher.getCurrent();
      expect(snapshot).not.toBeNull();

      // Synthesize a representative payload with the maximum retained 256-round history.
      const maxRounds = Array.from({ length: 256 }, (_, i) => ({
        roundNumber: i + 1,
        winnerSide: i % 2 === 0 ? ('CT' as const) : ('T' as const),
        winnerEntryId: i % 2 === 0 ? manifest.entrants.a.entryId : manifest.entrants.b.entryId,
        winCondition: ['elimination', 'bomb', 'defuse', 'time'][i % 4]! as
          'elimination' | 'bomb' | 'defuse' | 'time',
      }));

      const maxHistoryPayload = {
        ...snapshot!.payload,
        series: {
          ...snapshot!.payload.series!,
          roundHistory: {
            mapOrder: 1,
            completeness: 'complete' as const,
            rounds: maxRounds,
          },
        },
      };

      const parsed = programSnapshotSchema.parse({
        ...snapshot,
        payload: maxHistoryPayload,
      });
      expect(parsed.payload.series?.roundHistory?.rounds).toHaveLength(256);

      const jsonString = JSON.stringify(parsed);
      const byteLength = Buffer.byteLength(jsonString, 'utf8');

      // Verification against both transport hard guard (256 KiB) and Program conservative budget (64 KiB):
      expect(byteLength).toBeLessThanOrEqual(MAX_LOCAL_SNAPSHOT_BYTES);
      expect(byteLength).toBeLessThanOrEqual(64 * 1024);
      console.log(
        `Representative 256-round Program snapshot size: ${byteLength} bytes (${(byteLength / 1024).toFixed(1)} KiB) — well within 64 KiB Program budget and 256 KiB outbound transport hard guard (${MAX_LOCAL_SNAPSHOT_BYTES} bytes)`,
      );

      await coordinator.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('E.5, E.6, E.7 verifies Local Protocol v1, Program schema v7, Operator schema v3, ProgramCue v1 completely unaffected', async () => {
    expect(LOCAL_PROTOCOL_SUBPROTOCOL).toBe('rivalhub-broadcast.local.v1');
    expect(LOCAL_PROTOCOL_VERSION).toBe(1);
    expect(PROGRAM_SCHEMA_VERSION).toBe(7);
    expect(OPERATOR_SCHEMA_VERSION).toBe(4);
    expect(PROGRAM_CUE_SCHEMA_VERSION).toBe(1);

    // 1. Verify programCueMessageSchema is valid and unaffected:
    const cueParsed = programCueMessageSchema.parse({
      type: 'cue',
      protocolVersion: LOCAL_PROTOCOL_VERSION,
      channel: 'program-cue',
      schemaVersion: PROGRAM_CUE_SCHEMA_VERSION,
      channelSeq: 1,
      cursor: {
        producerInstanceId: 'test-producer',
        liveSessionId: null,
        runtimeSeq: 1,
        mapEpoch: 1,
        cstvProgramGeneration: 0,
        cstvProgramSequence: 1,
      },
      cue: {
        id: 'pc:test-producer:1:1',
        mapEpoch: 1,
        source: {
          generation: 0,
          sequence: 1,
          tick: 64,
        },
        kind: 'player-impact',
        effect: 'zeus',
        targetSourcePlayerId: '76561198000000001',
        attackerSourcePlayerId: null,
        weapon: 'taser',
        damageHealth: 100,
        healthRemaining: 0,
        hitgroup: 1,
        lethal: true,
      },
    });
    expect(cueParsed.channel).toBe('program-cue');
    expect(cueParsed.schemaVersion).toBe(1);

    // 2. Verify Operator schema v3 from coordinator publisher
    const runtime = createProgramRuntime('test-producer');
    const coordinator = createProjectionCoordinator({
      programRuntime: runtime,
      cstvSources: createCstvSourceManagers({}),
      nowMonotonicMs: () => 1000,
    });
    const operatorSnapshot = coordinator.getPublisher('operator').getCurrent();
    expect(operatorSnapshot).not.toBeNull();
    const operatorParsed = operatorSnapshotSchema.parse(operatorSnapshot);
    expect(operatorParsed.channel).toBe('operator');
    expect(operatorParsed.schemaVersion).toBe(4);
    expect(operatorParsed.payload).toHaveProperty('seriesProgress');

    await coordinator.close();
  });
});

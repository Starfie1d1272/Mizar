import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import type { TelemetryObservation } from '@mizar/core/telemetry';
import { toMatchContext, type BroadcastManifestV1 } from '@mizar/rivalhub';
import { expect, it } from 'vitest';

import type { MatchContextBinding } from '../src/match-context/index.js';
import { projectLiveSnapshotV1, transitionReliableEventsV1 } from '../src/output/projector.js';
import { ReliableOutbox } from '../src/output/reliable-outbox.js';
import { OutputService } from '../src/output/service.js';
import { createProjectionCoordinator } from '../src/projections/projection-coordinator.js';
import { createProgramRuntime } from '../src/runtime/program-runtime.js';
import { createCstvSourceManagers } from '../src/telemetry/cstv-source-manager.js';

function observation(
  manifest: BroadcastManifestV1,
  sequence: number,
  phase: 'live' | 'gameover',
): TelemetryObservation {
  const players = (side: 'a' | 'b', team: 'CT' | 'T') =>
    manifest.entrants[side].roster.players.slice(0, 5).map((player, index) => ({
      sourcePlayerId: player.steam64!,
      side: team,
      observerSlot: index,
      activity: 'playing',
      state: { health: 100, armor: 100, money: 800 },
      position: { x: index * 100, y: 200, z: 0 },
      forward: { x: 1, y: 0, z: 0 },
    }));
  const allPlayers = [...players('a', 'CT'), ...players('b', 'T')];
  return {
    receive: {
      sequence,
      receivedAt: `2026-09-28T00:00:0${sequence}.000Z`,
      receivedMonotonicMs: sequence * 1000,
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
        name: 'de_ancient',
        phase,
        roundNumber: 24,
        sides: {
          ct: { name: manifest.entrants.a.name, score: 13 },
          t: { name: manifest.entrants.b.name, score: 11 },
        },
      },
      round: { phase: phase === 'live' ? 'live' : 'over' },
      allPlayers,
      player: allPlayers[0]!,
    },
  };
}

it('projects bounded public-safe live data and transition-time reliable event', async () => {
  const manifest = JSON.parse(
    await readFile(
      resolve(process.cwd(), 'packages/rivalhub/test/fixtures/broadcast-manifest-v1.valid.json'),
      'utf8',
    ),
  ) as BroadcastManifestV1;
  const binding: MatchContextBinding = {
    manifest,
    context: toMatchContext(manifest),
    origin: 'fixture',
    freshness: 'fresh',
    diagnostics: [],
  };
  const runtime = createProgramRuntime('output-fixture');
  let now = 1000;
  const coordinator = createProjectionCoordinator({
    programRuntime: runtime,
    cstvSources: createCstvSourceManagers({}),
    matchContextBinding: binding,
    nowMonotonicMs: () => now,
  });
  try {
    coordinator.afterRuntimeMutation(runtime.acceptObservation(observation(manifest, 1, 'live')));
    const bundle = coordinator.getCurrent();
    const base = projectLiveSnapshotV1({ bundle, binding, producedAt: '2026-09-28T00:00:01.000Z' });
    expect(base?.players).toHaveLength(10);
    expect(base?.radar).toBeNull();
    expect(base?.capability.lineupComplete).toBe(true);
    expect(base).not.toHaveProperty('assist');
    expect(base).not.toHaveProperty('runtime');
    const withRadar = projectLiveSnapshotV1({
      bundle,
      binding,
      producedAt: '2026-09-28T00:00:01.000Z',
      includeRadar: true,
    });
    expect(withRadar?.radar?.players).toHaveLength(10);
    expect(
      projectLiveSnapshotV1({
        bundle,
        binding: { ...binding, freshness: 'stale' },
        producedAt: '2026-09-28T00:00:01.000Z',
      }),
    ).toBeNull();
    expect(
      projectLiveSnapshotV1({
        bundle: {
          ...bundle,
          program: {
            ...bundle.program,
            status: { ...bundle.program.status, identity: 'mismatch' },
          },
        },
        binding,
        producedAt: '2026-09-28T00:00:01.000Z',
      }),
    ).toBeNull();
    now = 2000;
    const result = runtime.acceptObservation(observation(manifest, 2, 'gameover'));
    const ended = coordinator.afterRuntimeMutation(result);
    const events = transitionReliableEventsV1({ result, bundle: ended, binding });
    expect(events.map((event) => event.kind)).toContain('map_ended');
    expect(events[0]?.observedAt).toBe('2026-09-28T00:00:02.000Z');
    expect(transitionReliableEventsV1({ result, bundle: ended, binding })[0]?.idempotencyKey).toBe(
      events[0]?.idempotencyKey,
    );
    const directory = await mkdtemp(join(tmpdir(), 'mizar-output-service-'));
    const outbox = new ReliableOutbox(join(directory, 'outbox.json'));
    const service = new OutputService({ outbox, now: () => new Date('2026-09-28T00:00:02.000Z') });
    try {
      await service.start();
      service.setCurrent(bundle, binding);
      service.beforeRuntimeMutation();
      service.afterRuntimeMutation(result, ended, binding);
      await outbox.flushPending();
      expect(outbox.getRecords().some((record) => record.event.kind === 'map_ended')).toBe(true);
      const received: string[] = [];
      const unsubscribe = service.subscribe({
        send: (snapshot) => {
          received.push(snapshot.matchId);
          return Promise.resolve();
        },
      });
      await new Promise<void>((resolveTick) => setImmediate(resolveTick));
      expect(received).toEqual([binding.context.matchId]);
      await unsubscribe();
    } finally {
      await service.close();
      await rm(directory, { recursive: true, force: true });
    }
    now = 30_000;
    const stale = coordinator.refresh();
    expect(
      projectLiveSnapshotV1({ bundle: stale, binding, producedAt: '2026-09-28T00:00:30.000Z' }),
    ).toBeNull();
  } finally {
    await coordinator.close();
  }
});

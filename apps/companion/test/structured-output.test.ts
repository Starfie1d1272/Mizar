import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import type { TelemetryObservation } from '@mizar/core/telemetry';
import { toMatchContext, type BroadcastManifestV1 } from '@mizar/rivalhub';
import { expect, it, vi } from 'vitest';

import { buildApp } from '../src/app.js';
import type { MatchContextBinding } from '../src/match-context/index.js';
import { projectLiveSnapshotV1, transitionReliableEventsV1 } from '../src/output/projector.js';
import { ReliableOutbox } from '../src/output/reliable-outbox.js';
import { configuredHttpOutputs } from '../src/output/http-sink.js';
import { OutputService } from '../src/output/service.js';
import * as outputProjector from '../src/output/projector.js';
import { createProjectionCoordinator } from '../src/projections/projection-coordinator.js';
import { createProgramRuntime } from '../src/runtime/program-runtime.js';
import { createCstvSourceManagers } from '../src/telemetry/cstv-source-manager.js';

function observation(
  manifest: BroadcastManifestV1,
  sequence: number,
  phase: 'live' | 'gameover',
  mapName = 'de_ancient',
  options: {
    readonly entryASide?: 'CT' | 'T';
    readonly scoreA?: number;
    readonly scoreB?: number;
    readonly roundNumber?: number;
  } = {},
): TelemetryObservation {
  const entryASide = options.entryASide ?? 'CT';
  const entryBSide = entryASide === 'CT' ? 'T' : 'CT';
  const scoreA = options.scoreA ?? 13;
  const scoreB = options.scoreB ?? 11;
  const players = (side: 'a' | 'b', team: 'CT' | 'T') =>
    manifest.entrants[side].roster.players.slice(0, 5).map((player, index) => ({
      sourcePlayerId: player.steam64!,
      side: team,
      observerSlot: index,
      activity: 'playing',
      state: { health: 100, armor: 100, money: 16000, equipValue: 5700 },
      position: { x: index * 100, y: 200, z: 0 },
      forward: { x: 1, y: 0, z: 0 },
    }));
  const allPlayers = [...players('a', entryASide), ...players('b', entryBSide)];
  const ctEntry = entryASide === 'CT' ? 'a' : 'b';
  const tEntry = entryASide === 'T' ? 'a' : 'b';
  return {
    receive: {
      sequence,
      receivedAt: new Date(Date.parse('2026-09-28T00:00:00.000Z') + sequence * 1000).toISOString(),
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
        name: mapName,
        phase,
        roundNumber: options.roundNumber ?? 24,
        sides: {
          ct: {
            name: manifest.entrants[ctEntry].name,
            score: entryASide === 'CT' ? scoreA : scoreB,
          },
          t: {
            name: manifest.entrants[tEntry].name,
            score: entryASide === 'T' ? scoreA : scoreB,
          },
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
  const sourceContext = toMatchContext(manifest);
  const binding: MatchContextBinding = {
    manifest,
    context: {
      ...sourceContext,
      stage: 'swiss',
      stageLabel: '瑞士赛',
      maps: sourceContext.maps.map((map) => ({
        ...map,
        scoreA: null,
        scoreB: null,
        completedAt: null,
      })),
    },
    origin: 'online',
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
    expect(bundle.program.match?.stage).toBe('瑞士赛');
    expect(base?.players).toHaveLength(10);
    expect(base?.players[0]).toMatchObject({ money: 16000, equipmentValue: 5700 });
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
    const mapEnded = events.find((event) => event.kind === 'map_ended');
    expect(mapEnded).toMatchObject({
      observedAt: '2026-09-28T00:00:02.000Z',
      mapId: binding.context.maps[0]?.mapId,
      payload: { scoreA: 13, scoreB: 11, scoreCT: 13, scoreT: 11 },
    });
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

async function bindingFixture(): Promise<MatchContextBinding> {
  const manifest = JSON.parse(
    await readFile(
      resolve(process.cwd(), 'packages/rivalhub/test/fixtures/broadcast-manifest-v1.valid.json'),
      'utf8',
    ),
  ) as BroadcastManifestV1;
  const context = toMatchContext(manifest);
  return {
    manifest,
    context: {
      ...context,
      maps: context.maps.map((map) => ({
        ...map,
        scoreA: null,
        scoreB: null,
        completedAt: null,
      })),
    },
    origin: 'online',
    freshness: 'fresh',
    diagnostics: [],
  };
}

it.each([
  { format: 'bo1' as const, scoreA: 13, scoreB: 9, label: 'regulation' },
  { format: 'bo3' as const, scoreA: 13, scoreB: 11, label: 'side switch' },
  { format: 'bo5' as const, scoreA: 16, scoreB: 14, label: 'overtime' },
])(
  'projects entrant-relative map_ended result for $format after $label',
  async ({ format, scoreA, scoreB }) => {
    const original = await bindingFixture();
    const binding: MatchContextBinding = {
      ...original,
      manifest: { ...original.manifest, match: { ...original.manifest.match, format } },
      context: { ...original.context, format },
    };
    const runtime = createProgramRuntime(`map-result-${format}`);
    const coordinator = createProjectionCoordinator({
      programRuntime: runtime,
      cstvSources: createCstvSourceManagers({}),
      matchContextBinding: binding,
      nowMonotonicMs: () => 2000,
    });
    try {
      coordinator.afterRuntimeMutation(
        runtime.acceptObservation(
          observation(binding.manifest, 1, 'live', 'de_ancient', {
            entryASide: 'CT',
            scoreA: 6,
            scoreB: 5,
            roundNumber: 11,
          }),
        ),
      );
      const result = runtime.acceptObservation(
        observation(binding.manifest, 2, 'gameover', 'de_ancient', {
          entryASide: 'T',
          scoreA,
          scoreB,
          roundNumber: scoreA + scoreB,
        }),
      );
      const ended = coordinator.afterRuntimeMutation(result);
      const event = transitionReliableEventsV1({ result, bundle: ended, binding }).find(
        (candidate) => candidate.kind === 'map_ended',
      );
      expect(ended.program.series?.maps[0]).toMatchObject({
        status: 'completed',
        finalScore: { a: scoreA, b: scoreB },
      });
      expect(event).toMatchObject({
        mapId: binding.context.maps[0]?.mapId,
        mapName: 'de_ancient',
        payload: {
          scoreA,
          scoreB,
          scoreCT: scoreB,
          scoreT: scoreA,
        },
      });
    } finally {
      await coordinator.close();
    }
  },
);

it.each(['bo3', 'bo5'] as const)(
  'emits each evidenced map start in %s, including a reset only after fresh telemetry',
  async (format) => {
    const original = await bindingFixture();
    const binding = {
      ...original,
      manifest: { ...original.manifest, match: { ...original.manifest.match, format } },
      context: { ...original.context, format },
    };
    const directory = await mkdtemp(join(tmpdir(), 'mizar-map-events-'));
    const runtime = createProgramRuntime('maps');
    let now = 1000;
    const coordinator = createProjectionCoordinator({
      programRuntime: runtime,
      cstvSources: createCstvSourceManagers({}),
      matchContextBinding: binding,
      nowMonotonicMs: () => now,
    });
    const outbox = new ReliableOutbox(join(directory, 'outbox.json'));
    const service = new OutputService({ outbox, now: () => new Date('2026-09-28T00:00:05.000Z') });
    const apply = (sequence: number, phase: 'live' | 'gameover', name: string) => {
      now = sequence * 1000;
      service.beforeRuntimeMutation();
      const result = runtime.acceptObservation(
        observation(binding.manifest, sequence, phase, name),
      );
      service.afterRuntimeMutation(result, coordinator.afterRuntimeMutation(result), binding);
    };
    try {
      await service.start();
      service.setCurrent(coordinator.getCurrent(), binding);
      apply(1, 'live', 'de_ancient');
      await outbox.flushPending();
      const firstBoundaryKinds = outbox
        .getRecords()
        .filter((record) => record.event.cursor.runtimeSeq === 1)
        .map((record) => record.event.kind);
      expect(firstBoundaryKinds.indexOf('match_started')).toBeGreaterThanOrEqual(0);
      expect(firstBoundaryKinds.indexOf('map_started')).toBeGreaterThan(
        firstBoundaryKinds.indexOf('match_started'),
      );
      apply(2, 'gameover', 'de_ancient');
      apply(3, 'live', 'de_mirage');
      apply(4, 'gameover', 'de_mirage');
      await outbox.flushPending();
      expect(
        outbox
          .getRecords()
          .filter((record) => record.event.kind === 'map_started')
          .map((record) => record.event.mapName),
      ).toEqual(['de_ancient', 'de_mirage']);
      expect(
        outbox.getRecords().filter((record) => record.event.kind === 'map_ended'),
      ).toHaveLength(2);
      expect(
        outbox.getRecords().filter((record) => record.event.kind === 'map_epoch_changed'),
      ).toHaveLength(1);
      service.beforeRuntimeMutation();
      const reset = runtime.resetMapExecution('same-map-restart', {
        monotonicMs: 5000,
        utc: '2026-09-28T00:00:05.000Z',
      });
      service.afterRuntimeMutation(reset, coordinator.afterRuntimeMutation(reset), binding);
      await outbox.flushPending();
      expect(
        outbox.getRecords().filter((record) => record.event.kind === 'map_started'),
      ).toHaveLength(2);
      apply(6, 'live', 'de_mirage');
      apply(7, 'live', 'de_mirage');
      await outbox.flushPending();
      expect(
        outbox.getRecords().filter((record) => record.event.kind === 'map_started'),
      ).toHaveLength(3);
    } finally {
      await service.close();
      await coordinator.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);

it('restores pending events into a new Runtime process without rewriting producer evidence', async () => {
  const binding = await bindingFixture();
  const directory = await mkdtemp(join(tmpdir(), 'mizar-runtime-restart-'));
  const path = join(directory, 'outbox.json');
  const runtimeA = createProgramRuntime('process-A', {
    liveSession: { kind: 'bound', liveSessionId: 'durable-session' },
  });
  const coordinatorA = createProjectionCoordinator({
    programRuntime: runtimeA,
    cstvSources: createCstvSourceManagers({}),
    matchContextBinding: binding,
    nowMonotonicMs: () => 3000,
  });
  const outboxA = new ReliableOutbox(path);
  const serviceA = new OutputService({
    outbox: outboxA,
    now: () => new Date('2026-09-28T00:00:02.000Z'),
  });
  let originalEvent;
  try {
    await serviceA.start();
    runtimeA.advanceProgramSourceGeneration({ monotonicMs: 0, utc: '2026-09-28T00:00:00.000Z' });
    runtimeA.acceptObservation(observation(binding.manifest, 1, 'live'));
    runtimeA.resetMapExecution('same-map-restart', {
      monotonicMs: 1500,
      utc: '2026-09-28T00:00:01.500Z',
    });
    const first = runtimeA.acceptObservation(observation(binding.manifest, 2, 'live'));
    serviceA.setCurrent(coordinatorA.afterRuntimeMutation(first), binding);
    serviceA.beforeRuntimeMutation();
    const ended = runtimeA.acceptObservation(observation(binding.manifest, 3, 'gameover'));
    serviceA.afterRuntimeMutation(ended, coordinatorA.afterRuntimeMutation(ended), binding);
    await outboxA.flushPending();
    originalEvent = outboxA.getRecords().find((record) => record.event.kind === 'map_ended')!.event;
  } finally {
    await serviceA.close();
    await coordinatorA.close();
  }
  const runtimeB = createProgramRuntime('process-B');
  const coordinatorB = createProjectionCoordinator({
    programRuntime: runtimeB,
    cstvSources: createCstvSourceManagers({}),
    matchContextBinding: binding,
    nowMonotonicMs: () => 4000,
  });
  const sink = { send: vi.fn(() => Promise.resolve('accepted' as const)) };
  const outboxB = new ReliableOutbox(path);
  const serviceB = new OutputService({
    outbox: outboxB,
    sink,
    now: () => new Date('2026-09-28T00:00:03.000Z'),
    restoreContinuity: (checkpoint) => {
      runtimeB.restoreDeliveryContinuity({ ...checkpoint.cursor, mapName: checkpoint.mapName });
      return coordinatorB.refresh();
    },
  });
  try {
    serviceB.setCurrent(coordinatorB.getCurrent(), binding);
    await serviceB.start();
    expect(sink.send).not.toHaveBeenCalled();
    expect(outboxB.getRecords().find((record) => record.event.kind === 'map_ended')?.status).toBe(
      'pending',
    );
    const baseline = runtimeB.acceptObservation(observation(binding.manifest, 4, 'gameover'));
    serviceB.setCurrent(coordinatorB.afterRuntimeMutation(baseline), binding);
    await serviceB.retry();
    expect(runtimeB.getCurrentState().producerInstanceId).toBe('process-B');
    expect(sink.send).toHaveBeenCalledWith(originalEvent);
    expect(outboxB.getRecords().find((record) => record.event.kind === 'map_ended')?.status).toBe(
      'accepted',
    );
  } finally {
    await serviceB.close();
    await coordinatorB.close();
    await rm(directory, { recursive: true, force: true });
  }
});

it.each(['match', 'revision', 'session', 'generation', 'epoch', 'stale', 'score'] as const)(
  'guards reliable delivery against changed %s',
  async (changed) => {
    const binding = await bindingFixture();
    const directory = await mkdtemp(join(tmpdir(), 'mizar-retry-guard-'));
    const runtime = createProgramRuntime('guard-process');
    const coordinator = createProjectionCoordinator({
      programRuntime: runtime,
      cstvSources: createCstvSourceManagers({}),
      matchContextBinding: binding,
      nowMonotonicMs: () => 2000,
    });
    const outbox = new ReliableOutbox(join(directory, 'outbox.json'));
    const send = vi.fn(() => Promise.resolve('accepted' as const));
    const service = new OutputService({
      outbox,
      sink: { send },
      now: () => new Date('2026-09-28T00:00:02.000Z'),
    });
    try {
      await service.start();
      coordinator.afterRuntimeMutation(
        runtime.acceptObservation(observation(binding.manifest, 1, 'live')),
      );
      const result = runtime.acceptObservation(observation(binding.manifest, 2, 'gameover'));
      const bundle = coordinator.afterRuntimeMutation(result);
      const event = transitionReliableEventsV1({ result, bundle, binding }).find(
        (candidate) => candidate.kind === 'map_ended',
      )!;
      await outbox.enqueue(event, new Date(event.observedAt));
      const nextBinding = {
        ...binding,
        context: {
          ...binding.context,
          matchId: changed === 'match' ? 'another-match' : binding.context.matchId,
        },
        manifest: {
          ...binding.manifest,
          revision: changed === 'revision' ? 'another-revision' : binding.manifest.revision,
        },
        freshness: changed === 'stale' ? ('stale' as const) : ('fresh' as const),
      };
      service.setCurrent(
        {
          ...bundle,
          program: {
            ...bundle.program,
            cursor: {
              ...bundle.program.cursor,
              liveSessionId:
                changed === 'session' ? 'another-session' : bundle.program.cursor.liveSessionId,
              programSourceGeneration:
                bundle.program.cursor.programSourceGeneration + (changed === 'generation' ? 1 : 0),
              mapEpoch: bundle.program.cursor.mapEpoch + (changed === 'epoch' ? 1 : 0),
            },
            map: {
              ...bundle.program.map,
              score: {
                ...bundle.program.map.score,
                ct: changed === 'score' ? 0 : bundle.program.map.score.ct,
              },
            },
          },
        },
        nextBinding,
      );
      await service.retry();
      expect(send).not.toHaveBeenCalled();
      expect(outbox.getRecords()[0]?.status).toBe(
        changed === 'stale' || changed === 'score' ? 'pending' : 'superseded',
      );
    } finally {
      await service.close();
      await coordinator.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);

it('coalesces outbound snapshots and drops pending data after context becomes stale', async () => {
  const binding = await bindingFixture();
  const runtime = createProgramRuntime('slow-output');
  const coordinator = createProjectionCoordinator({
    programRuntime: runtime,
    cstvSources: createCstvSourceManagers({}),
    matchContextBinding: binding,
    nowMonotonicMs: () => 1000,
  });
  const bundle = coordinator.afterRuntimeMutation(
    runtime.acceptObservation(observation(binding.manifest, 1, 'live')),
  );
  const delivered: number[] = [];
  let finish: (() => void) | undefined;
  const service = new OutputService({
    liveSink: {
      send: (snapshot) => {
        delivered.push(snapshot.cursor.runtimeSeq);
        return new Promise<void>((resolveSend) => {
          finish = resolveSend;
        });
      },
    },
  });
  try {
    service.setCurrent(bundle, binding);
    await service.start();
    await new Promise<void>((resolveTick) => setTimeout(resolveTick, 550));
    expect(delivered).toEqual([1]);
    for (let seq = 2; seq <= 100; seq++)
      service.setCurrent(
        {
          ...bundle,
          program: { ...bundle.program, cursor: { ...bundle.program.cursor, runtimeSeq: seq } },
        },
        binding,
      );
    await new Promise<void>((resolveTick) => setTimeout(resolveTick, 550));
    expect(delivered).toEqual([1]);
    finish!();
    await new Promise<void>((resolveTick) => setImmediate(resolveTick));
    expect(delivered).toEqual([1, 100]);
    service.setCurrent(bundle, binding);
    service.setCurrent(bundle, { ...binding, freshness: 'stale' });
    finish!();
    await new Promise<void>((resolveTick) => setImmediate(resolveTick));
    expect(delivered).toEqual([1, 100]);
  } finally {
    await service.close();
    await coordinator.close();
  }
});

it('wires restart recovery through production app composition and GSI ingress', async () => {
  const binding = await bindingFixture();
  const directory = await mkdtemp(join(tmpdir(), 'mizar-app-restart-'));
  const path = join(directory, 'outbox.json');
  const frame = (phase: 'live' | 'gameover') => {
    const allplayers = Object.fromEntries(
      ['a', 'b'].flatMap((side, sideIndex) =>
        binding.manifest.entrants[side as 'a' | 'b'].roster.players
          .slice(0, 5)
          .map((player, index) => [
            player.steam64!,
            {
              steamid: player.steam64,
              name: player.displayName,
              team: sideIndex === 0 ? 'CT' : 'T',
              observer_slot: sideIndex * 5 + index,
              state: { health: 100, armor: 100, money: 16000, equip_value: 5700 },
            },
          ]),
      ),
    );
    return {
      auth: { token: 'test-gsi-token' },
      provider: { appid: 730 },
      map: {
        name: 'de_ancient',
        phase,
        round: 24,
        team_ct: { name: binding.manifest.entrants.a.name, score: 13 },
        team_t: { name: binding.manifest.entrants.b.name, score: 11 },
      },
      round: { phase: phase === 'live' ? 'live' : 'over' },
      allplayers,
    };
  };
  const appA = buildApp({
    producerInstanceId: 'app-A',
    gsiToken: 'test-gsi-token',
    matchContextBinding: binding,
    reliableOutboxPath: path,
  });
  try {
    expect(
      (await appA.inject({ method: 'POST', url: '/gsi', payload: frame('live') })).statusCode,
    ).toBe(204);
    expect(
      (await appA.inject({ method: 'POST', url: '/gsi', payload: frame('gameover') })).statusCode,
    ).toBe(204);
  } finally {
    await appA.close();
  }
  const persisted = new ReliableOutbox(path);
  await persisted.load();
  const event = persisted.getRecords().find((record) => record.event.kind === 'map_ended')!.event;
  expect(event.cursor.producerInstanceId).toBe('app-A');
  const send = vi.fn(() => Promise.resolve('accepted' as const));
  const appB = buildApp({
    producerInstanceId: 'app-B',
    gsiToken: 'test-gsi-token',
    matchContextBinding: binding,
    reliableOutboxPath: path,
    reliableSink: { send },
  });
  try {
    await appB.ready();
    expect(send).not.toHaveBeenCalled();
    expect(
      (await appB.inject({ method: 'POST', url: '/gsi', payload: frame('gameover') })).statusCode,
    ).toBe(204);
    const snapshot = (await appB.inject({ url: '/local/v1/live-snapshot' })).json<{
      cursor: typeof event.cursor;
    }>();
    expect(snapshot.cursor).toMatchObject({
      producerInstanceId: 'app-B',
      liveSessionId: event.cursor.liveSessionId,
      mapEpoch: event.cursor.mapEpoch,
    });
    await vi.waitFor(() => expect(send).toHaveBeenCalledWith(event), { timeout: 2500 });
  } finally {
    await appB.close();
    await rm(directory, { recursive: true, force: true });
  }
});

async function liveFixture() {
  const binding = await bindingFixture();
  const runtime = createProgramRuntime('public-live');
  const coordinator = createProjectionCoordinator({
    programRuntime: runtime,
    cstvSources: createCstvSourceManagers({}),
    matchContextBinding: binding,
    nowMonotonicMs: () => 1000,
  });
  const bundle = coordinator.afterRuntimeMutation(
    runtime.acceptObservation(observation(binding.manifest, 1, 'live')),
  );
  const project = (input = bundle) =>
    projectLiveSnapshotV1({
      bundle: input,
      binding,
      producedAt: '2026-09-28T00:00:01.000Z',
      includeRadar: true,
    });
  return { binding, runtime, coordinator, bundle, project };
}

it.each([
  'stale',
  'generation',
  'epoch',
  'sequence',
  'producer',
  'session',
  'map',
  'unsupported',
] as const)(
  'keeps the rest of LiveSnapshot available when Radar is invalid: %s',
  async (changed) => {
    const { coordinator, bundle, project } = await liveFixture();
    try {
      const radar = {
        ...bundle.radar,
        telemetryFreshness:
          changed === 'stale' ? ('stale' as const) : bundle.radar.telemetryFreshness,
        mapName:
          changed === 'map'
            ? 'de_nuke'
            : changed === 'unsupported'
              ? 'unsupported'
              : bundle.radar.mapName,
        cursor: {
          ...bundle.radar.cursor,
          programSourceGeneration:
            bundle.radar.cursor.programSourceGeneration + (changed === 'generation' ? 1 : 0),
          mapEpoch: bundle.radar.cursor.mapEpoch + (changed === 'epoch' ? 1 : 0),
          programReceiveSequence:
            changed === 'sequence' ? 99 : bundle.radar.cursor.programReceiveSequence,
          producerInstanceId:
            changed === 'producer' ? 'old' : bundle.radar.cursor.producerInstanceId,
          liveSessionId: changed === 'session' ? 'old' : bundle.radar.cursor.liveSessionId,
        },
      };
      const candidate = {
        ...bundle,
        radar,
        program:
          changed === 'unsupported'
            ? { ...bundle.program, map: { ...bundle.program.map, name: 'unsupported' } }
            : bundle.program,
      };
      expect(project(candidate)).toMatchObject({
        radar: null,
        capability: { radarCurrent: false },
      });
      expect(project(candidate)?.players).toHaveLength(10);
    } finally {
      await coordinator.close();
    }
  },
);

it('uses only Program-safe inputs, stable Program identity, and no Assist/Lookahead fields', async () => {
  const { coordinator, bundle, project } = await liveFixture();
  try {
    const trapped = new Proxy(bundle, {
      get(target, key, receiver): unknown {
        if (key === 'assist' || key === 'identity') throw new Error('private_timeline_access');
        const value: unknown = Reflect.get(target, key, receiver);
        return value;
      },
    });
    const result = project(trapped)!;
    expect(result.radar?.players[0]?.canonicalPlayerId).toBe(
      bundle.program.players[0]?.canonicalPlayerId,
    );
    expect(JSON.stringify(result)).not.toMatch(
      /"(?:assist|lookahead|future|rawGsi|forward|velocity|trail|world)"\s*:/,
    );
    const noProof = {
      ...bundle,
      program: {
        ...bundle.program,
        players: bundle.program.players.map((p) => ({
          ...p,
          identityEvidence: 'observed' as const,
          canonicalPlayerId: null,
        })),
      },
    };
    expect(project(noProof)?.radar?.players.every((p) => p.canonicalPlayerId === null)).toBe(true);
  } finally {
    await coordinator.close();
  }
});

it('copies complete/partial/unavailable/null Round History without score inference', async () => {
  const { coordinator, bundle, project } = await liveFixture();
  try {
    for (const completeness of ['complete', 'partial', 'unavailable'] as const) {
      const roundHistory = {
        mapOrder: 1,
        completeness,
        rounds:
          completeness === 'unavailable'
            ? []
            : [
                {
                  roundNumber: 1,
                  winnerSide: 'CT' as const,
                  winnerEntryId: 'entry-a',
                  winCondition: 'bomb' as const,
                },
                {
                  roundNumber: 26,
                  winnerSide: 'T' as const,
                  winnerEntryId: 'entry-a',
                  winCondition: 'unknown' as const,
                },
              ],
      };
      const result = project({
        ...bundle,
        program: { ...bundle.program, series: { ...bundle.program.series!, roundHistory } },
      });
      expect(result?.roundHistory).toEqual(roundHistory);
    }
    expect(
      project({ ...bundle, program: { ...bundle.program, series: null } })?.roundHistory,
    ).toBeNull();
  } finally {
    await coordinator.close();
  }
});

it.each([24, 30])(
  'projects production SeriesProgress history through regulation/overtime (%s rounds) and map transition',
  async (rounds) => {
    const binding = await bindingFixture();
    const runtime = createProgramRuntime('live-round-history');
    let now = 0;
    const coordinator = createProjectionCoordinator({
      programRuntime: runtime,
      cstvSources: createCstvSourceManagers({}),
      matchContextBinding: binding,
      nowMonotonicMs: () => now,
    });
    let sequence = 0;
    const winnerA = (round: number) => round % 2 === 1 || round === rounds;
    const accept = (
      roundNumber: number,
      phase: 'live' | 'over',
      side: 'CT' | 'T',
      mapName = 'de_ancient',
      mapPhase: 'live' | 'gameover' = 'live',
    ) => {
      const completed = mapName === 'de_ancient' ? roundNumber - (phase === 'live' ? 1 : 0) : 0;
      const scoreA = Array.from({ length: completed }, (_, i) => i + 1).filter(winnerA).length;
      const frame = observation(binding.manifest, ++sequence, mapPhase, mapName, {
        entryASide: side,
        scoreA,
        scoreB: completed - scoreA,
        roundNumber,
      });
      now = frame.receive.receivedMonotonicMs;
      const winnerSide = winnerA(roundNumber) ? side : side === 'CT' ? 'T' : 'CT';
      return coordinator.afterRuntimeMutation(
        runtime.acceptObservation({
          ...frame,
          telemetry: {
            ...frame.telemetry,
            round: { phase, ...(phase === 'over' ? { winnerSide } : {}) },
          },
        }),
      );
    };
    try {
      let bundle = accept(1, 'live', 'CT');
      for (let round = 1; round <= rounds; round++) {
        const side = round <= 12 || round >= 28 ? 'CT' : 'T';
        if (round > 1) accept(round, 'live', side);
        bundle = accept(round, 'over', side);
      }
      const snapshot = projectLiveSnapshotV1({
        bundle,
        binding,
        producedAt: '2026-09-28T00:00:01.000Z',
      })!;
      expect(snapshot.roundHistory).toEqual(bundle.program.series?.roundHistory);
      expect(snapshot.roundHistory?.rounds).toHaveLength(rounds);
      expect(snapshot.roundHistory?.rounds[0]?.winnerSide).toBe('CT');
      expect(snapshot.roundHistory?.rounds[12]).toMatchObject({
        winnerSide: 'T',
        winnerEntryId: binding.context.entrants.a.entryId,
      });
      expect(snapshot.roundHistory?.completeness).toBe('complete');
      accept(rounds, 'over', rounds >= 28 ? 'CT' : 'T', 'de_ancient', 'gameover');
      const nextMap = binding.context.maps[1]!.mapName;
      const changed = accept(1, 'live', 'CT', nextMap);
      const next = projectLiveSnapshotV1({
        bundle: changed,
        binding,
        producedAt: '2026-09-28T00:00:02.000Z',
      })!;
      expect(next.roundHistory).toEqual(changed.program.series?.roundHistory);
      expect(next.roundHistory?.rounds).toEqual([]);
      expect(next.roundHistory?.mapOrder).toBe(2);
    } finally {
      await coordinator.close();
    }
  },
);

it('production HTTP liveSink includes Radar by default, drops failed delivery, and reconnects to current baseline', async () => {
  const { coordinator, binding, bundle } = await liveFixture();
  const directory = await mkdtemp(join(tmpdir(), 'mizar-live-http-'));
  const outbox = new ReliableOutbox(join(directory, 'outbox.json'));
  const bodies: unknown[] = [];
  const fetchMock = vi.fn<typeof fetch>((_url, init) => {
    bodies.push(JSON.parse(init!.body as string));
    return Promise.resolve(new Response(null, { status: bodies.length === 1 ? 503 : 204 }));
  });
  vi.stubGlobal('fetch', fetchMock);
  const outputs = configuredHttpOutputs({
    MIZAR_LIVE_OUTPUT_URL: 'https://sink.example/live',
    MIZAR_OUTPUT_TOKEN: 'test-token',
  });
  const service = new OutputService({ ...outputs, outbox });
  try {
    service.setCurrent(bundle, binding);
    await service.start();
    await vi.waitFor(() => expect(bodies).toHaveLength(1));
    expect(bodies[0]).toMatchObject({
      radar: { mapName: 'de_ancient' },
      capability: { radarCurrent: true },
    });
    await outbox.flushPending();
    expect(outbox.getRecords()).toEqual([]);
    service.setCurrent(
      {
        ...bundle,
        program: {
          ...bundle.program,
          players: bundle.program.players.map((player) => ({
            ...player,
            displayName: 'x'.repeat(300_000),
          })),
        },
      },
      binding,
    );
    expect(service.current(true)).toBeNull();
    expect(bodies).toHaveLength(1);
    expect(outbox.getRecords()).toEqual([]);
    const current = {
      ...bundle,
      program: { ...bundle.program, cursor: { ...bundle.program.cursor, runtimeSeq: 100 } },
    };
    service.setCurrent(current, binding);
    await vi.waitFor(() => expect(bodies).toHaveLength(2));
    expect(bodies[1]).toMatchObject({ cursor: { runtimeSeq: 100 } });
    const received: number[] = [];
    const stop = service.subscribe(
      {
        send: (snapshot) => {
          received.push(snapshot.cursor.runtimeSeq);
          return Promise.resolve();
        },
      },
      true,
    );
    await vi.waitFor(() => expect(received).toEqual([100]));
    await stop();
  } finally {
    await service.close();
    await coordinator.close();
    vi.unstubAllGlobals();
    await rm(directory, { recursive: true, force: true });
  }
});

async function recoveryFixture() {
  let binding = await bindingFixture();
  const directory = await mkdtemp(join(tmpdir(), 'mizar-start-recovery-'));
  const runtime = createProgramRuntime('start-recovery');
  let time = 0;
  let authority: string | null = null;
  const coordinator = createProjectionCoordinator({
    programRuntime: runtime,
    cstvSources: createCstvSourceManagers({}),
    matchContextBinding: binding,
    nowMonotonicMs: () => time,
  });
  const outbox = new ReliableOutbox(join(directory, 'outbox.json'));
  const diagnostics: string[] = [];
  const service = new OutputService({
    outbox,
    authorityScope: () => authority,
    now: () => new Date('2026-09-28T00:00:00.000Z'),
    onDiagnostic: (code) => diagnostics.push(code),
  });
  await service.start();
  service.setCurrent(coordinator.getCurrent(), binding);
  const apply = (
    sequence: number,
    transform?: (frame: TelemetryObservation) => TelemetryObservation,
  ) => {
    time = sequence * 1000;
    service.beforeRuntimeMutation();
    const frame = observation(binding.manifest, sequence, 'live');
    const result = runtime.acceptObservation(transform?.(frame) ?? frame);
    const bundle = coordinator.afterRuntimeMutation(result);
    service.afterRuntimeMutation(result, bundle, binding);
    return { result, bundle };
  };
  const settle = async () => {
    await outbox.flushPending();
    await new Promise<void>((done) => setImmediate(done));
  };
  return {
    directory,
    runtime,
    coordinator,
    outbox,
    service,
    diagnostics,
    apply,
    settle,
    starts: () => outbox.getRecords().filter((record) => record.event.kind === 'map_started'),
    authority: (value: string | null) => {
      authority = value;
    },
    binding: () => binding,
    context: (next: MatchContextBinding) => {
      binding = next;
      service.setBinding(binding);
      coordinator.setMatchContextBinding(binding);
      service.setCurrent(coordinator.refresh(), binding);
    },
    advanceGeneration: () => {
      service.beforeRuntimeMutation();
      const result = runtime.advanceProgramSourceGeneration({
        monotonicMs: time,
        utc: '2026-09-28T00:00:00.000Z',
      });
      service.afterRuntimeMutation(result, coordinator.afterRuntimeMutation(result), binding);
    },
    close: async () => {
      await service.close();
      await coordinator.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

it('revalidates one same-epoch generation recovery with a new cursor/key, while normal frames and old cursors stay bounded', async () => {
  const f = await recoveryFixture();
  try {
    const first = f.apply(1);
    await f.settle();
    expect(f.starts()).toHaveLength(1);
    f.advanceGeneration();
    await f.settle();
    expect(f.starts()).toHaveLength(1);
    f.apply(2);
    await f.settle();
    expect(f.starts()).toHaveLength(2);
    const [before, after] = f.starts().map((record) => record.event);
    expect(after!.cursor.mapEpoch).toBe(before!.cursor.mapEpoch);
    expect(after!.cursor.programSourceGeneration).toBe(before!.cursor.programSourceGeneration + 1);
    expect(after!.cursor.runtimeSeq).toBeGreaterThan(before!.cursor.runtimeSeq);
    expect(after!.idempotencyKey).not.toBe(before!.idempotencyKey);
    // Duplicate/out-of-order telemetry is rejected by the production runtime.
    f.apply(2);
    for (let sequence = 3; sequence < 25; sequence++) f.apply(sequence);
    await f.settle();
    expect(f.starts()).toHaveLength(2);
    f.service.afterRuntimeMutation(first.result, first.bundle, f.binding());
    await f.settle();
    expect(f.starts()).toHaveLength(2);
  } finally {
    await f.close();
  }
});

it('waits for current ten-player identity after wrong-room/lineup repair and never starts from retained evidence', async () => {
  const f = await recoveryFixture();
  try {
    const wrong = (frame: TelemetryObservation): TelemetryObservation => ({
      ...frame,
      telemetry: {
        ...frame.telemetry,
        allPlayers: frame.telemetry.allPlayers!.map((player, index) =>
          index === 0 ? { ...player, sourcePlayerId: '76561190000009999' } : player,
        ),
      },
    });
    f.apply(1, wrong);
    await f.settle();
    expect(f.starts()).toHaveLength(0);
    f.apply(2);
    await f.settle();
    expect(f.starts()).toHaveLength(1);
    f.apply(3, wrong);
    await f.settle();
    expect(f.starts()).toHaveLength(1);
    f.apply(4);
    await f.settle();
    expect(f.starts()).toHaveLength(2);
    f.apply(5, (frame) => ({
      ...frame,
      coverage: { ...frame.coverage, allPlayers: 'absent' },
      telemetry: {
        map: frame.telemetry.map!,
        round: frame.telemetry.round!,
        player: frame.telemetry.player!,
      },
    }));
    await f.settle();
    expect(f.starts()).toHaveLength(2);
    f.apply(6);
    await f.settle();
    expect(f.starts()).toHaveLength(3);
  } finally {
    await f.close();
  }
});

it('context freshness/revision and authority reclaim need a new accepted frame before a same-epoch proof', async () => {
  const f = await recoveryFixture();
  try {
    f.apply(1);
    await f.settle();
    const epoch = f.starts()[0]!.event.cursor.mapEpoch;
    f.context({ ...f.binding(), freshness: 'stale' });
    f.apply(2);
    await f.settle();
    expect(f.starts()).toHaveLength(1);
    f.context({
      ...f.binding(),
      freshness: 'fresh',
      manifest: { ...f.binding().manifest, revision: 'new-context' },
    });
    await f.settle();
    expect(f.starts()).toHaveLength(1);
    f.apply(3);
    await f.settle();
    expect(f.starts()).toHaveLength(2);
    expect(f.starts()[1]!.event.contextRevision).toBe('new-context');
    f.authority('authority-1');
    f.service.setCurrent(f.coordinator.getCurrent(), f.binding());
    await f.service.retry();
    await f.settle();
    expect(f.starts()).toHaveLength(2);
    f.apply(4);
    await f.settle();
    f.authority('authority-2');
    f.apply(5);
    await f.settle();
    expect(f.starts()).toHaveLength(4);
    expect(f.starts().every((record) => record.event.cursor.mapEpoch === epoch)).toBe(true);
    f.apply(6);
    await f.settle();
    expect(f.starts()).toHaveLength(4);
  } finally {
    await f.close();
  }
});

it('reopens late attachment after a fresh context without inventing a map epoch', async () => {
  const f = await recoveryFixture();
  try {
    const active = f.binding();
    f.context({ ...active, freshness: 'stale' });
    f.apply(10);
    await f.settle();
    expect(f.starts()).toHaveLength(0);
    f.context(active);
    await f.settle();
    expect(f.starts()).toHaveLength(0);
    f.apply(11);
    await f.settle();
    expect(f.starts()).toHaveLength(1);
    expect(f.starts()[0]!.event.cursor.mapEpoch).toBe(1);
  } finally {
    await f.close();
  }
});

it('does not consume map start publication after a failed durable enqueue', async () => {
  const f = await recoveryFixture();
  const enqueue = f.outbox.enqueue.bind(f.outbox);
  let fail = true;
  vi.spyOn(f.outbox, 'enqueue').mockImplementation((event, now, continuity) => {
    if (event.kind === 'map_started' && fail) {
      fail = false;
      return Promise.reject(new Error('disk-unavailable'));
    }
    return enqueue(event, now, continuity);
  });
  try {
    f.apply(1);
    await f.settle();
    expect(f.starts()).toHaveLength(0);
    expect(f.diagnostics).toContain('outbox_enqueue_failed');
    f.apply(2);
    await f.settle();
    expect(f.starts()).toHaveLength(1);
    f.apply(3);
    await f.settle();
    expect(f.starts()).toHaveLength(1);
  } finally {
    await f.close();
  }
});

it('bounds in-flight persistence and ignores a late old-scope publication after recovery', async () => {
  const f = await recoveryFixture();
  const enqueue = f.outbox.enqueue.bind(f.outbox);
  let release!: () => void;
  const pending = new Promise<void>((done) => {
    release = done;
  });
  let startEnqueues = 0;
  vi.spyOn(f.outbox, 'enqueue').mockImplementation(async (event, now, continuity) => {
    if (event.kind === 'map_started') {
      startEnqueues++;
      await pending;
    }
    return enqueue(event, now, continuity);
  });
  try {
    f.apply(1);
    for (let sequence = 2; sequence < 30; sequence++) f.apply(sequence);
    expect(startEnqueues).toBe(1);
    f.advanceGeneration();
    f.apply(30);
    expect(startEnqueues).toBe(2);
    release();
    await new Promise<void>((done) => setImmediate(done));
    await f.settle();
    f.apply(31);
    await f.settle();
    expect(startEnqueues).toBe(2);
    await vi.waitFor(() => expect(f.starts()).toHaveLength(2));
    f.apply(32);
    await f.settle();
    expect(startEnqueues).toBe(2);
  } finally {
    release();
    await f.close();
  }
});

it('ordinary map-start delivery retries keep the exact durable event and key', async () => {
  const f = await recoveryFixture();
  try {
    f.apply(1);
    await f.settle();
    const event = f.starts()[0]!.event;
    const sent: unknown[] = [];
    const sink = {
      send: (candidate: typeof event) => {
        sent.push(candidate);
        return Promise.resolve('retry' as const);
      },
    };
    await f.outbox.flush({
      sink,
      isCurrent: () => true,
      now: new Date('2026-09-28T00:00:01.000Z'),
    });
    await f.outbox.flush({
      sink,
      isCurrent: () => true,
      now: new Date('2026-09-28T00:01:00.000Z'),
    });
    expect(sent.filter((item) => (item as typeof event).kind === 'map_started')).toEqual([
      event,
      event,
    ]);
    expect(f.starts()[0]!.event.idempotencyKey).toBe(event.idempotencyKey);
  } finally {
    await f.close();
  }
});

it.each(['null', 'throw'] as const)(
  'keeps a new-frame start opportunity after %s event projection failure',
  async (mode) => {
    const f = await recoveryFixture();
    const build = outputProjector.buildReliableEventV1;
    let fail = true;
    const spy = vi.spyOn(outputProjector, 'buildReliableEventV1').mockImplementation((input) => {
      if (input.kind === 'map_started' && fail) {
        fail = false;
        if (mode === 'throw') throw new Error('invalid-projection');
        return null;
      }
      return build(input);
    });
    try {
      f.apply(1);
      await f.settle();
      expect(f.starts()).toHaveLength(0);
      f.apply(2);
      await f.settle();
      expect(f.starts()).toHaveLength(1);
      f.apply(3);
      await f.settle();
      expect(f.starts()).toHaveLength(1);
    } finally {
      spy.mockRestore();
      await f.close();
    }
  },
);

it.each(['durable', 'failed'] as const)(
  'restart treats %s start/checkpoint as continuity, then publishes a new producer proof',
  async (publication) => {
    const f = await recoveryFixture();
    const enqueue = f.outbox.enqueue.bind(f.outbox);
    if (publication === 'failed')
      vi.spyOn(f.outbox, 'enqueue').mockImplementation((event, now, continuity) =>
        event.kind === 'map_started'
          ? Promise.reject(new Error('disk-failed'))
          : enqueue(event, now, continuity),
      );
    let restarted: OutputService | undefined;
    let coordinatorB: ReturnType<typeof createProjectionCoordinator> | undefined;
    try {
      f.apply(1);
      await f.settle();
      const checkpoint = f.outbox.getContinuity()!;
      await f.service.close();
      const runtimeB = createProgramRuntime('restarted-producer');
      coordinatorB = createProjectionCoordinator({
        programRuntime: runtimeB,
        cstvSources: createCstvSourceManagers({}),
        matchContextBinding: f.binding(),
        nowMonotonicMs: () => 2000,
      });
      const outboxB = new ReliableOutbox(join(f.directory, 'outbox.json'));
      restarted = new OutputService({
        outbox: outboxB,
        now: () => new Date('2026-09-28T00:00:02.000Z'),
        restoreContinuity: (saved) => {
          runtimeB.restoreDeliveryContinuity({ ...saved.cursor, mapName: saved.mapName });
          return coordinatorB!.refresh();
        },
      });
      restarted.setCurrent(coordinatorB.getCurrent(), f.binding());
      await restarted.start();
      expect(
        outboxB
          .getRecords()
          .filter((record) => record.event.kind === 'map_started' && record.status === 'pending'),
      ).toHaveLength(0);
      restarted.beforeRuntimeMutation();
      const result = runtimeB.acceptObservation(observation(f.binding().manifest, 2, 'live'));
      restarted.afterRuntimeMutation(
        result,
        coordinatorB.afterRuntimeMutation(result),
        f.binding(),
      );
      await outboxB.flushPending();
      const current = outboxB
        .getRecords()
        .filter((record) => record.event.kind === 'map_started' && record.status === 'pending');
      expect(current).toHaveLength(1);
      expect(current[0]!.event.cursor).toMatchObject({
        producerInstanceId: 'restarted-producer',
        liveSessionId: checkpoint.cursor.liveSessionId,
        mapEpoch: checkpoint.cursor.mapEpoch,
      });
      expect(current[0]!.event.cursor.programReceiveSequence).toBe(2);
    } finally {
      await restarted?.close();
      await coordinatorB?.close();
      await f.close();
    }
  },
);

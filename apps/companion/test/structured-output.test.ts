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
import { OutputService } from '../src/output/service.js';
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
    origin: 'fixture',
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
      expect(ended.operator.seriesProgress?.maps[0]).toMatchObject({
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
    for (let seq = 2; seq <= 100; seq++)
      service.setCurrent(
        {
          ...bundle,
          program: { ...bundle.program, cursor: { ...bundle.program.cursor, runtimeSeq: seq } },
        },
        binding,
      );
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

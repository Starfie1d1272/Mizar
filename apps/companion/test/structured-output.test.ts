import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import type { ReliableEventV1 } from '@mizar/protocol/output';
import type { TelemetryObservation } from '@mizar/core/telemetry';
import { toMatchContext, type BroadcastManifest } from '@mizar/rivalhub';
import { expect, it, vi } from 'vitest';

import { buildApp } from '../src/app.js';
import type { MatchContextBinding } from '../src/match-context/index.js';
import { hasLineupMismatchOnly } from '../src/output/lineup-mismatch.js';
import { projectLiveSnapshotV1 } from '../src/output/projector.js';
import { ReliableOutbox } from '../src/output/reliable-outbox.js';
import { readBusinessHistory, BUSINESS_HISTORY_FILE } from '../src/support/business-history.js';
import { failedObsNativeEvidence } from '../src/obs/native-evidence.js';
import { OutputService } from '../src/output/service.js';
import { createProjectionCoordinator } from '../src/projections/projection-coordinator.js';
import { createProgramRuntime } from '../src/runtime/program-runtime.js';
import { createCstvSourceManagers } from '../src/telemetry/cstv-source-manager.js';

function observation(
  manifest: BroadcastManifest,
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

async function bindingFixture(): Promise<MatchContextBinding> {
  const manifest = JSON.parse(
    await readFile(
      resolve(process.cwd(), 'packages/rivalhub/test/fixtures/broadcast-manifest-v1.valid.json'),
      'utf8',
    ),
  ) as BroadcastManifest;
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
    supportLogsDirectory: directory,
    producerInstanceId: 'app-A',
    gsiToken: 'test-gsi-token',
    matchContextBinding: binding,
    reliableOutboxPath: path,
  });
  try {
    expect(
      (await appA.inject({ method: 'POST', url: '/gsi', payload: frame('live') })).statusCode,
    ).toBe(204);
    const incomplete = frame('live');
    await appA.inject({ method: 'POST', url: '/gsi', payload: { ...incomplete, map: undefined } });
    const missingMap = readBusinessHistory(directory)
      .groups.flatMap((g) => g.events)
      .find(
        (e) =>
          e.stage === 'business_runtime' &&
          e.evidence.coverage.map === 'absent' &&
          e.evidence.observed.length === 10,
      );
    expect(missingMap?.evidence.expected.filter((p) => p.isStarter)).toHaveLength(10);
    expect(missingMap?.evidence.missing).toEqual([]);
    expect(missingMap?.evidence.extra).toEqual([]);
    // An actual lineup contradiction is independently visible from incomplete map telemetry.
    const different = frame('live');
    const originalId = Object.keys(different.allplayers)[0]!;
    const player = different.allplayers[originalId]!;
    delete different.allplayers[originalId];
    different.allplayers['76561199999999999'] = { ...player, steamid: '76561199999999999' };
    await appA.inject({ method: 'POST', url: '/gsi', payload: different });
    const mismatch = readBusinessHistory(directory)
      .groups.flatMap((g) => g.events)
      .find((e) => e.evidence.extra.includes('76561199999999999'));
    expect(mismatch?.evidence.missing).toContain(originalId);
    expect(mismatch?.evidence.issues).toContain('unexpected_human_steam64');
    await appA.inject({ method: 'POST', url: '/gsi', payload: frame('live') });
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
    supportLogsDirectory: directory,
    readObsCaptureEvidence: () =>
      Promise.resolve(
        failedObsNativeEvidence(new Error('synthetic native collection unavailable')),
      ),
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
      readBusinessHistory(directory)
        .groups.flatMap((g) => g.events)
        .some(
          (e) =>
            e.stage === 'business_guard' && e.evidence.blockers.includes('telemetry_not_fresh'),
        ),
    ).toBe(true);
    const restoredHistory = readBusinessHistory(directory)
      .groups.flatMap((g) => g.events)
      .filter((e) => e.evidence.idempotencyKey === event.idempotencyKey);
    expect(
      restoredHistory.some(
        (e) =>
          e.evidence.reason === 'restored' &&
          e.evidence.producerInstanceId === 'app-A' &&
          e.evidence.originalObservedAt === event.observedAt,
      ),
    ).toBe(true);
    expect(
      restoredHistory.every(
        (e) =>
          e.evidence.matchId === binding.context.matchId &&
          e.evidence.liveSessionId === event.cursor.liveSessionId,
      ),
    ).toBe(true);
    expect(
      restoredHistory.find((e) => e.evidence.reason === 'restored')?.evidence.sentAt,
    ).toBeNull();
    for (let i = 0; i < 2; i++) {
      const response = await appB.inject({
        method: 'POST',
        url: '/debug/support-bundle',
        headers: { origin: 'http://127.0.0.1:3000' },
        payload: {},
      });
      expect(response.statusCode).toBe(200);
      const exported = response.json<{ businessHistory: ReturnType<typeof readBusinessHistory> }>()
        .businessHistory;
      expect(
        exported.groups
          .flatMap((g) => g.events)
          .some(
            (e) =>
              e.evidence.idempotencyKey === event.idempotencyKey &&
              e.evidence.originalObservedAt === event.observedAt &&
              e.evidence.matchId === event.matchId,
          ),
      ).toBe(true);
    }
    expect(await readFile(join(directory, BUSINESS_HISTORY_FILE), 'utf8')).not.toContain(
      'test-gsi-token',
    );

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
    await vi.waitFor(() => expect(send).toHaveBeenCalledWith(event, expect.any(AbortSignal)), {
      timeout: 2500,
    });
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

it('recovers the complete terminal enqueue from the real runtime, projection and OutputService owner chain', async () => {
  const original = await bindingFixture();
  const binding: MatchContextBinding = {
    ...original,
    manifest: { ...original.manifest, match: { ...original.manifest.match, format: 'bo1' } },
    context: { ...original.context, format: 'bo1', maps: original.context.maps.slice(0, 1) },
  };
  const dir = await mkdtemp(join(tmpdir(), 'mizar-terminal-owner-'));
  const path = join(dir, 'outbox.json');
  const runtime = createProgramRuntime('terminal-owner');
  let time = 1000;
  const coordinator = createProjectionCoordinator({
    programRuntime: runtime,
    cstvSources: createCstvSourceManagers({}),
    matchContextBinding: binding,
    nowMonotonicMs: () => time,
  });
  const box = new ReliableOutbox(path);
  const service = new OutputService({
    outbox: box,
    sink: { send: () => Promise.resolve('accepted' as const) },
    now: () => new Date('2026-09-28T00:00:02Z'),
  });
  let restored: OutputService | undefined;
  try {
    // Keep periodic delivery under test control while durable file I/O remains real.
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    await service.start();
    service.setCurrent(coordinator.getCurrent(), binding);
    for (const [seq, phase] of [
      [1, 'live'],
      [2, 'gameover'],
    ] as const) {
      time = seq * 1000;
      service.beforeRuntimeMutation();
      const result = runtime.acceptObservation(observation(binding.manifest, seq, phase));
      service.afterRuntimeMutation(result, coordinator.afterRuntimeMutation(result), binding);
      await box.flushPending();
      if (seq === 1) await service.retry();
    }
    const terminal = box
      .getRecords()
      .filter((r) => ['map_ended', 'series_ended'].includes(r.event.kind));
    expect(terminal.map((r) => r.event.kind)).toEqual(['map_ended', 'series_ended']);
    await service.close();
    const damaged = JSON.parse(await readFile(path, 'utf8')) as {
      records: { event: { kind: string }; status: unknown; attempts: unknown }[];
    };
    expect(
      damaged.records.filter((r) => ['map_ended', 'series_ended'].includes(r.event.kind)),
    ).toMatchObject([
      { event: { kind: 'map_ended' }, status: 'pending', attempts: 0 },
      { event: { kind: 'series_ended' }, status: 'pending', attempts: 0 },
    ]);
    damaged.records.find((r) => r.event.kind === 'series_ended')!.status = ['pending'];
    await writeFile(path, JSON.stringify(damaged));
    const recovered = new ReliableOutbox(path);
    const sent: unknown[] = [];
    restored = new OutputService({
      outbox: recovered,
      now: () => new Date('2026-09-28T00:00:02Z'),
      sink: {
        send: (event) => {
          sent.push(event);
          return Promise.resolve('accepted' as const);
        },
      },
    });
    restored.setCurrent(coordinator.getCurrent(), binding);
    await restored.start();
    expect(sent).toEqual(terminal.map((r) => r.event));
    expect(
      recovered
        .getRecords()
        .filter((r) => ['map_ended', 'series_ended'].includes(r.event.kind))
        .map((r) => r.status),
    ).toEqual(['accepted', 'accepted']);
    await restored.retry();
    expect(sent).toHaveLength(2);
  } finally {
    try {
      await restored?.close();
      await service.close();
      await coordinator.close();
      await rm(dir, { recursive: true, force: true });
    } finally {
      vi.useRealTimers();
    }
  }
});

it('allows only current roster differences with both entrants and the planned map proved', async () => {
  const binding = await bindingFixture();
  const baseline = observation(binding.manifest, 1, 'live');
  const current = baseline.telemetry.allPlayers!;
  const different = current.map((player, i) =>
    i === 4 || i === 9
      ? {
          ...player,
          sourcePlayerId: i === 4 ? '76561198099999991' : '76561198099999992',
          displayName: i === 4 ? '广州老头乐' : '卡油兔克',
        }
      : player,
  );
  const cases = [
    { name: 'two accounts differ', players: different, mapName: 'de_ancient', allowed: true },
    {
      name: 'one entrant has no account proof',
      players: different.map((p, i) =>
        i < 5
          ? {
              ...p,
              sourcePlayerId: `7656119809999990${i}`,
            }
          : p,
      ),
      mapName: 'de_ancient',
      allowed: false,
    },
    {
      name: 'entrant accounts span both sides',
      players: different.map((p, i) =>
        i === 0
          ? {
              ...p,
              side: 'T' as const,
            }
          : i === 5
            ? { ...p, side: 'CT' as const }
            : p,
      ),
      mapName: 'de_ancient',
      allowed: false,
    },
    { name: 'wrong map', players: different, mapName: 'de_inferno', allowed: false },
    {
      name: 'incomplete observation',
      players: different.slice(0, 9),
      mapName: 'de_ancient',
      allowed: false,
    },
    {
      name: 'duplicate observed identity',
      players: different.map((p, i) =>
        i === 4
          ? {
              ...p,
              sourcePlayerId: different[0]!.sourcePlayerId,
            }
          : p,
      ),
      mapName: 'de_ancient',
      allowed: false,
    },
  ];
  for (const scenario of cases) {
    const runtime = createProgramRuntime(`roster-${scenario.name}`, {
      liveSession: { kind: 'bound', liveSessionId: 'roster-test-session' },
    });
    const coordinator = createProjectionCoordinator({
      programRuntime: runtime,
      cstvSources: createCstvSourceManagers({}),
      matchContextBinding: binding,
      nowMonotonicMs: () => 1000,
    });
    try {
      const input = {
        ...baseline,
        telemetry: {
          ...baseline.telemetry,
          map: { ...baseline.telemetry.map!, name: scenario.mapName },
          allPlayers: scenario.players,
        },
      };
      const result = runtime.acceptObservation(input);
      const bundle = coordinator.afterRuntimeMutation(result);
      expect(hasLineupMismatchOnly(bundle, binding), scenario.name).toBe(scenario.allowed);
      const snapshot = projectLiveSnapshotV1({
        bundle,
        binding,
        producedAt: '2026-09-28T00:00:01Z',
      });
      expect(snapshot?.capability.lineupMismatchOnly === true, scenario.name).toBe(
        scenario.allowed,
      );
      if (scenario.allowed) {
        expect(bundle.identity.capabilities.identityDependentResult).toBe(false);
        expect(
          snapshot?.players.filter((p) => p.sourcePlayerId.startsWith('7656119809999999')),
        ).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ canonicalPlayerId: null, identityEvidence: 'observed' }),
          ]),
        );
        expect(hasLineupMismatchOnly(bundle, { ...binding, freshness: 'stale' })).toBe(false);
        expect(
          hasLineupMismatchOnly(bundle, {
            ...binding,
            context: { ...binding.context, matchId: 'other' },
          }),
        ).toBe(false);
      }
    } finally {
      await coordinator.close();
    }
  }
});

it('delivers display end and execution continuity under a persistent account difference without a formal result', async () => {
  const binding = await bindingFixture();
  const directory = await mkdtemp(join(tmpdir(), 'mizar-display-continuity-'));
  const runtime = createProgramRuntime('display-continuity', {
    liveSession: { kind: 'bound', liveSessionId: 'display-continuity-session' },
  });
  let time = 1000;
  const coordinator = createProjectionCoordinator({
    programRuntime: runtime,
    cstvSources: createCstvSourceManagers({}),
    matchContextBinding: binding,
    nowMonotonicMs: () => time,
  });
  const box = new ReliableOutbox(join(directory, 'outbox.json'));
  const sent: ReliableEventV1[] = [];
  const service = new OutputService({
    outbox: box,
    sink: {
      send: (event) => {
        sent.push(event);
        return Promise.resolve('accepted' as const);
      },
    },
    now: () => new Date(Date.parse('2026-09-28T00:00:00Z') + time),
    authorityScope: () => 'test-authority',
  });
  try {
    await service.start();
    for (const [sequence, phase, mapName] of [
      [1, 'live', 'de_ancient'],
      [2, 'gameover', 'de_ancient'],
      [3, 'live', 'de_mirage'],
    ] as const) {
      time = sequence * 1000;
      const base = observation(binding.manifest, sequence, phase, mapName);
      const allPlayers = base.telemetry.allPlayers!.map((player, index) =>
        index === 4 || index === 9
          ? { ...player, sourcePlayerId: index === 4 ? '76561198099999991' : '76561198099999992' }
          : player,
      );
      service.beforeRuntimeMutation();
      const result = runtime.acceptObservation({
        ...base,
        telemetry: { ...base.telemetry, allPlayers },
      });
      const bundle = coordinator.afterRuntimeMutation(result);
      service.afterRuntimeMutation(result, bundle, binding);
      await box.flushPending();
      await service.retry();
    }
    time = 3500;
    service.beforeRuntimeMutation();
    const advanced = runtime.advanceProgramSourceGeneration({
      monotonicMs: time,
      utc: '2026-09-28T00:00:03.500Z',
    });
    service.afterRuntimeMutation(advanced, coordinator.afterRuntimeMutation(advanced), binding);
    time = 4000;
    const refreshed = observation(binding.manifest, 4, 'live', 'de_mirage');
    const allPlayers = refreshed.telemetry.allPlayers!.map((player, index) =>
      index === 4 || index === 9
        ? { ...player, sourcePlayerId: index === 4 ? '76561198099999991' : '76561198099999992' }
        : player,
    );
    service.beforeRuntimeMutation();
    const accepted = runtime.acceptObservation({
      ...refreshed,
      telemetry: { ...refreshed.telemetry, allPlayers },
    });
    service.afterRuntimeMutation(accepted, coordinator.afterRuntimeMutation(accepted), binding);
    await box.flushPending();
    await service.retry();
    expect(
      sent
        .filter((event) =>
          ['map_started', 'map_ended', 'map_epoch_changed', 'source_generation_changed'].includes(
            event.kind,
          ),
        )
        .map((event) => event.kind),
    ).toEqual([
      'map_started',
      'map_ended',
      'map_epoch_changed',
      'map_started',
      'source_generation_changed',
      'map_started',
    ]);
    const ended = sent.filter((event) => event.kind === 'map_ended');
    expect(ended).toHaveLength(1);
    expect(ended[0]?.evidence).toMatchObject({ identity: 'degraded', lineupMismatchOnly: true });
    expect(ended[0]?.payload).toEqual({ scoreA: 13, scoreB: 11, scoreCT: 13, scoreT: 11 });
    expect(coordinator.getCurrent().program.series).toMatchObject({
      currentMapOrder: 2,
      score: { a: 0, b: 0 },
    });
    expect(coordinator.getCurrent().program.series?.maps[0]).toMatchObject({
      finalScore: null,
      winnerEntryId: null,
    });
    expect(service.current()?.capability.lineupMismatchOnly).toBe(true);
  } finally {
    await service.close();
    await coordinator.close();
    await rm(directory, { recursive: true, force: true });
  }
});

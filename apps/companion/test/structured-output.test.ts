import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import type { TelemetryObservation } from '@mizar/core/telemetry';
import { toMatchContext, type BroadcastManifest } from '@mizar/rivalhub';
import { expect, it, vi } from 'vitest';

import { buildApp } from '../src/app.js';
import type { MatchContextBinding } from '../src/match-context/index.js';
import { projectLiveSnapshotV1 } from '../src/output/projector.js';
import { ReliableOutbox } from '../src/output/reliable-outbox.js';
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
      records: { event: { kind: string }; status: unknown }[];
    };
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
    await restored?.close();
    await service.close();
    await coordinator.close();
    await rm(dir, { recursive: true, force: true });
  }
});

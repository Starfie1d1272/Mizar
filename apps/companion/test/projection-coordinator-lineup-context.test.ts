import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { toMatchContext, type BroadcastManifest } from '@mizar/rivalhub';
import type { TelemetryObservation } from '@mizar/core/telemetry';
import { expect, it } from 'vitest';

import type { MatchContextBinding } from '../src/match-context/index.js';
import { createProjectionCoordinator } from '../src/projections/projection-coordinator.js';
import { createProgramRuntime } from '../src/runtime/program-runtime.js';
import { createCstvSourceManagers } from '../src/telemetry/cstv-source-manager.js';

async function readManifest(): Promise<BroadcastManifest> {
  return JSON.parse(
    await readFile(
      resolve(process.cwd(), 'packages/rivalhub/test/fixtures/broadcast-manifest-v1.valid.json'),
      'utf8',
    ),
  ) as BroadcastManifest;
}

function bindingFor(manifest: BroadcastManifest): MatchContextBinding {
  return {
    manifest,
    context: toMatchContext(manifest),
    origin: 'fixture',
    freshness: 'fresh',
    diagnostics: [],
  };
}

function matchedObservation(manifest: BroadcastManifest): TelemetryObservation {
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
      activity: 'playing',
      state: { health: 100 },
    }));
  const allPlayers = [...entrantPlayers('a', 'CT'), ...entrantPlayers('b', 'T')];
  return {
    receive: {
      sequence: 1,
      receivedAt: '2026-09-17T00:00:00.000Z',
      receivedMonotonicMs: 0,
    },
    source: { kind: 'cs2-gsi' },
    coverage: {
      provider: 'present',
      map: 'present',
      round: 'absent',
      phaseCountdowns: 'absent',
      player: 'present',
      allPlayers: 'present',
      bomb: 'absent',
      grenades: 'absent',
    },
    telemetry: {
      map: {
        name: 'de_ancient',
        phase: 'live',
        sides: {
          ct: { name: manifest.entrants.a.name },
          t: { name: manifest.entrants.b.name },
        },
      },
      allPlayers,
      player: allPlayers[0]!,
    },
  };
}

it('retains lineup across same-match context rebind during GSI reconnect', async () => {
  const manifest = await readManifest();
  const runtime = createProgramRuntime('context-rebind-lineup');
  const coordinator = createProjectionCoordinator({
    programRuntime: runtime,
    cstvSources: createCstvSourceManagers({}),
    matchContextBinding: bindingFor(manifest),
    nowMonotonicMs: () => 0,
  });

  coordinator.afterRuntimeMutation(runtime.acceptObservation(matchedObservation(manifest)));
  expect(coordinator.getCurrent().program.players).toHaveLength(10);

  coordinator.afterRuntimeMutation(
    runtime.advanceProgramSourceGeneration({
      monotonicMs: 1,
      utc: '2026-09-17T00:00:00.001Z',
    }),
  );
  const afterReconnect = coordinator.getCurrent().program.players;
  expect(afterReconnect).toHaveLength(10);
  expect(afterReconnect.every(({ lineupEvidence }) => lineupEvidence === 'retained')).toBe(true);

  coordinator.setMatchContextBinding(bindingFor(manifest));
  const afterRebind = coordinator.getCurrent().program.players;
  expect(afterRebind).toHaveLength(10);
  expect(afterRebind.every(({ lineupEvidence }) => lineupEvidence === 'retained')).toBe(true);

  await coordinator.close();
});

import { describe, expect, it } from 'vitest';
import type { RoleScopedGameEventObservation } from '@mizar/core/game-events';
import type { TelemetryObservation } from '@mizar/core/telemetry';

import { createProgramCueCoordinator } from '../src/projections/program-cue-coordinator.js';
import { createProgramRuntime } from '../src/runtime/program-runtime.js';
import type { CstvSourceHealth, CstvSourceManager } from '../src/telemetry/cstv-source-manager.js';

type ProgramPlayerHurt = Extract<
  RoleScopedGameEventObservation<'program'>,
  { readonly kind: 'player-hurt' }
>;

const sourceCursor = {
  kind: 'cs2-cstv' as const,
  role: 'program' as const,
  generation: 0,
  sequence: 7,
  tick: 700,
  observedAt: '2026-09-18T00:00:00.000Z',
  observedMonotonicMs: 10,
  mapName: 'de_mirage',
};

function programObservation(): TelemetryObservation {
  return {
    receive: {
      sequence: 1,
      receivedAt: '2026-09-18T00:00:00.000Z',
      receivedMonotonicMs: 0,
    },
    source: { kind: 'cs2-gsi' },
    coverage: {
      provider: 'present',
      map: 'present',
      round: 'absent',
      phaseCountdowns: 'absent',
      player: 'absent',
      allPlayers: 'absent',
      bomb: 'absent',
      grenades: 'absent',
    },
    telemetry: { map: { name: 'de_mirage', phase: 'live' } },
  };
}

function gameEvent(
  overrides: Partial<Omit<ProgramPlayerHurt, 'kind' | 'cursor'>> & {
    readonly cursor?: ProgramPlayerHurt['cursor'];
  } = {},
): RoleScopedGameEventObservation<'program'> {
  return {
    kind: 'player-hurt',
    cursor: sourceCursor,
    victim: { sourceUserId: 1, sourcePlayerId: '76561198000000001' },
    attacker: { sourceUserId: 2, sourcePlayerId: '76561198000000002' },
    weapon: 'taser',
    healthRemaining: 0,
    armorRemaining: 0,
    damageHealth: 100,
    damageArmor: 0,
    hitgroup: 1,
    ...overrides,
  };
}

function source(): CstvSourceManager<'program'> & {
  emit(event: RoleScopedGameEventObservation<'program'>): void;
  setHealth(next: Partial<CstvSourceHealth<'program'>>): void;
} {
  let health: CstvSourceHealth<'program'> = {
    role: 'program',
    state: 'live',
    generation: 0,
    reconnectAttempt: 0,
  };
  const healthListeners = new Set<() => void>();
  const eventListeners = new Set<(event: RoleScopedGameEventObservation<'program'>) => void>();
  return {
    role: 'program',
    start: () => {},
    stop: async () => {},
    getHealth: () => health,
    getRecentGameEvents: () => [],
    getRecentDiagnostics: () => [],
    getSnapshot: () => ({ health, recentGameEvents: [], recentDiagnostics: [] }),
    subscribe: (listener) => {
      healthListeners.add(listener);
      return () => healthListeners.delete(listener);
    },
    subscribeLiveGameEvents: (listener) => {
      eventListeners.add(listener);
      return () => eventListeners.delete(listener);
    },
    emit: (event) => {
      for (const listener of [...eventListeners]) listener(event);
    },
    setHealth: (next) => {
      health = { ...health, ...next };
      for (const listener of [...healthListeners]) listener();
    },
  };
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('ProgramCueCoordinator', () => {
  it('emits only eligible Program events, preserves source order, and dedupes source sequence', async () => {
    const programSource = source();
    const runtime = createProgramRuntime('producer-a', {
      liveSession: { kind: 'bound', liveSessionId: 'session-a' },
    });
    runtime.acceptObservation(programObservation());
    const coordinator = createProgramCueCoordinator({
      programSource,
      programRuntime: runtime,
      nowMonotonicMs: () => 0,
    });
    const messages: Array<{ readonly type: string; readonly sequence?: number }> = [];
    const subscription = coordinator.getPublisher().subscribe((message) => {
      messages.push({
        type: message.type,
        ...(message.type === 'cue' ? { sequence: message.cue.source.sequence } : {}),
      });
      return Promise.resolve();
    });
    await flush();

    programSource.emit(gameEvent());
    programSource.emit(gameEvent());
    programSource.emit(
      gameEvent({ cursor: { ...sourceCursor, sequence: sourceCursor.sequence + 1 } }),
    );
    await flush();

    expect(messages).toEqual([
      { type: 'cue-baseline' },
      { type: 'cue', sequence: 7 },
      { type: 'cue', sequence: 8 },
    ]);
    expect(messages.filter(({ type }) => type === 'cue')).toHaveLength(2);

    await subscription.close();
    await coordinator.close();
  });

  it('drops stale, wrong-map, and non-live events without queuing them', async () => {
    const programSource = source();
    const runtime = createProgramRuntime('producer-a');
    runtime.acceptObservation(programObservation());
    let now = 0;
    const diagnostics: string[] = [];
    const coordinator = createProgramCueCoordinator({
      programSource,
      programRuntime: runtime,
      nowMonotonicMs: () => now,
      onDiagnostic: ({ code }) => diagnostics.push(code),
    });
    const messages: string[] = [];
    const subscription = coordinator.getPublisher().subscribe((message) => {
      messages.push(message.type);
      return Promise.resolve();
    });
    await flush();

    programSource.emit(gameEvent({ cursor: { ...sourceCursor, mapName: 'de_inferno' } }));
    now = 20_001;
    programSource.emit(
      gameEvent({ cursor: { ...sourceCursor, sequence: sourceCursor.sequence + 1 } }),
    );
    programSource.setHealth({ state: 'reconnecting' });
    programSource.emit(gameEvent());
    await flush();

    expect(messages).toEqual(['cue-baseline', 'cue-baseline']);
    expect(diagnostics).toEqual(
      expect.arrayContaining([
        'program-cue-telemetry-stale',
        'program-cue-map-mismatch',
        'program-cue-source-not-live',
      ]),
    );

    await subscription.close();
    await coordinator.close();
  });

  it('keeps CSTV generation separate from GSI generation and publishes reset barriers', async () => {
    const programSource = source();
    const runtime = createProgramRuntime('producer-a');
    runtime.acceptObservation(programObservation());
    const coordinator = createProgramCueCoordinator({
      programSource,
      programRuntime: runtime,
      nowMonotonicMs: () => 0,
    });
    const baselines: Array<{ mapEpoch: number; cstvGeneration: number }> = [];
    const subscription = coordinator.getPublisher().subscribe((message) => {
      if (message.type === 'cue-baseline') {
        baselines.push({
          mapEpoch: message.cursor.mapEpoch,
          cstvGeneration: message.cursor.cstvProgramGeneration,
        });
      }
      return Promise.resolve();
    });
    await flush();

    runtime.advanceProgramSourceGeneration({ monotonicMs: 1, utc: '2026-09-18T00:00:00.001Z' });
    coordinator.afterRuntimeMutation();
    await flush();
    programSource.setHealth({ generation: 1, state: 'live' });
    await flush();

    expect(baselines).toEqual([
      { mapEpoch: 1, cstvGeneration: 0 },
      { mapEpoch: 1, cstvGeneration: 0 },
      { mapEpoch: 1, cstvGeneration: 1 },
    ]);

    await subscription.close();
    await coordinator.close();
  });
});

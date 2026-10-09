import { describe, expect, it } from 'vitest';
import type { TelemetryObservation } from '@mizar/core/telemetry';

import {
  DEBUG_RECENT_DIAGNOSTICS_MAX,
  DEBUG_RECENT_TRANSITIONS_MAX,
  DebugEvidenceStore,
} from '../src/runtime/debug-state.js';
import { createProgramRuntime } from '../src/runtime/program-runtime.js';

const recorderHealth = {
  state: 'recording' as const,
  pendingFrames: 0,
  pendingBytes: 0,
  maxPendingFrames: 128,
  maxPendingBytes: 2 * 1024 * 1024,
  frameCount: 1,
  droppedFrames: 0,
  incomplete: false,
};

const emptyDeliveryHealth = [] as const;

function observation(
  sequence: number,
  receivedMonotonicMs: number,
  mapName = 'de_ancient',
): TelemetryObservation {
  return {
    receive: {
      sequence,
      receivedAt: new Date(
        Date.parse('2026-09-15T00:00:00.000Z') + receivedMonotonicMs,
      ).toISOString(),
      receivedMonotonicMs,
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
      map: { name: mapName, phase: 'live' },
      round: { phase: 'live' },
      player: {
        sourcePlayerId: '76561198000000001',
        displayName: 'Observer One',
      },
      allPlayers: [
        {
          sourcePlayerId: '76561198000000001',
          displayName: 'Observer One',
          side: 'CT',
        },
      ],
    },
  };
}

describe('DebugEvidenceStore', () => {
  it('keeps raw and latest adapter diagnostics visible when no observation is produced', () => {
    const store = new DebugEvidenceStore();
    store.recordAcceptedRaw({
      sequence: 7,
      receivedAt: '2026-09-15T00:00:00.007Z',
      receivedMonotonicMs: 7,
      payload: {
        allplayers: {
          '76561198000000001': { name: 'Observer One' },
        },
        auth: { token: 'secret-token' },
      },
    });
    store.recordGsiDiagnostics({
      entries: [
        {
          code: 'INVALID_ROOT',
          severity: 'fatal',
          path: '$.allplayers.76561198000000001.name',
          rawValue: 'Observer One',
        },
      ],
      suppressedCount: 0,
    });

    const response = store.getResponse({
      nowMonotonicMs: 7,
      recorderHealth,
      deliveryHealth: emptyDeliveryHealth,
    });

    expect(response).toMatchObject({
      freshness: 'awaiting',
      raw: { current: { sequence: 7 } },
      normalized: { current: null },
      latestGsiDiagnostics: {
        entries: [
          {
            path: '$.allplayers.[REDACTED].name',
            rawValue: '[REDACTED]',
          },
        ],
      },
    });
    expect(JSON.stringify(response)).not.toContain('secret-token');
    expect(JSON.stringify(response)).not.toContain('76561198000000001');
    expect(JSON.stringify(response)).not.toContain('Observer One');
  });

  it('redacts raw, normalized, transition diagnostics, and runtime identity at read time', () => {
    const runtime = createProgramRuntime('debug-producer');
    const store = new DebugEvidenceStore(runtime.getSnapshot());
    const payload = {
      provider: {
        name: 'CS2',
        steamid: '76561198000000001',
      },
      player: {
        steamid: '76561198000000001',
        name: 'Observer One',
      },
      allplayers: {
        '76561198000000001': {
          steamid: '76561198000000001',
          name: 'Observer One',
        },
      },
      nested: { auth: { token: 'secret-token' } },
      map: { name: 'de_ancient' },
    } satisfies Record<string, unknown>;
    const raw = {
      sequence: 4,
      receivedAt: '2026-09-15T00:00:00.004Z',
      receivedMonotonicMs: 4,
      payload,
    };
    const currentObservation = observation(4, 4);
    runtime.acceptObservation(currentObservation);
    store.recordAcceptedRaw(raw);
    store.recordNormalizedObservation(currentObservation);
    store.recordGsiDiagnostics({
      entries: [
        {
          code: 'INVALID_FIELD',
          severity: 'error',
          path: '$.allplayers.76561198000000001.name',
          rawValue: 'Observer One',
        },
      ],
      suppressedCount: 0,
    });
    store.recordRuntime(runtime.getSnapshot());

    const response = store.getResponse({
      nowMonotonicMs: 4,
      recorderHealth,
      deliveryHealth: [
        {
          id: 'program',
          state: 'idle',
          inFlight: false,
          hasPendingLatest: false,
          offered: 2,
          sent: 2,
          coalesced: 0,
          failed: 0,
        },
      ],
    });
    const serialized = JSON.stringify(response);

    expect(serialized).not.toContain('secret-token');
    expect(serialized).not.toContain('76561198000000001');
    expect(serialized).not.toContain('Observer One');
    expect(response.raw.current?.payload).toMatchObject({
      provider: { name: 'CS2', steamid: '[REDACTED]' },
      player: { steamid: '[REDACTED]', name: '[REDACTED]' },
      allplayers: {
        'player-1': { steamid: '[REDACTED]', name: '[REDACTED]' },
      },
      map: { name: 'de_ancient' },
    });
    expect(response.latestGsiDiagnostics?.entries[0]).toMatchObject({
      path: '$.allplayers.[REDACTED].name',
      rawValue: '[REDACTED]',
    });
    expect(payload.allplayers['76561198000000001']).toEqual({
      steamid: '76561198000000001',
      name: 'Observer One',
    });
  });

  it('keeps transition and runtime diagnostic evidence bounded', () => {
    const runtime = createProgramRuntime('debug-producer');
    runtime.acceptObservation(observation(0, 0));
    for (let index = 1; index <= 40; index += 1) {
      runtime.acceptObservation(observation(index, index, `de_map_${index}`));
    }

    const store = new DebugEvidenceStore(runtime.getSnapshot());
    for (let index = 0; index < 40; index += 1) {
      store.recordRuntimeDiagnostic(`diagnostic-${index}`);
    }
    const response = store.getResponse({
      nowMonotonicMs: 40,
      recorderHealth,
      deliveryHealth: emptyDeliveryHealth,
    });

    expect(response.recentTransitions).toHaveLength(DEBUG_RECENT_TRANSITIONS_MAX);
    expect(response.recentRuntimeDiagnostics).toHaveLength(DEBUG_RECENT_DIAGNOSTICS_MAX);
    expect(response.recentRuntimeDiagnostics[0]).toEqual({ code: 'diagnostic-8' });
  });

  it('uses the runtime-injected freshness threshold when deriving the read response', () => {
    const runtime = createProgramRuntime('debug-producer', {
      continuityPolicy: { staleAfterMs: 50 },
    });
    runtime.acceptObservation(observation(0, 100));
    const store = new DebugEvidenceStore(runtime.getSnapshot());

    expect(
      store.getResponse({
        nowMonotonicMs: 150,
        recorderHealth,
        deliveryHealth: emptyDeliveryHealth,
      }).freshness,
    ).toBe('fresh');
    expect(
      store.getResponse({
        nowMonotonicMs: 151,
        recorderHealth,
        deliveryHealth: emptyDeliveryHealth,
      }).freshness,
    ).toBe('stale');
  });
});

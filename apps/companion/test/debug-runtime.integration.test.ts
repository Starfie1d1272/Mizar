import { resolve } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { iterateCaptureFrames, verifyCapture, type CaptureFrameV1 } from '@mizar/testkit';

import { buildApp, type DeliveryHealthSource } from '../src/app.js';
import type {
  CaptureFrameInput,
  CaptureRecorder,
  RecorderHealth,
} from '../src/telemetry/capture-recorder.js';

const TOKEN = 'debug-runtime-token';
const RICH_OBSERVER_FIXTURE = resolve(
  process.cwd(),
  'fixtures/gsi/semantic/observer/rich-live-state',
);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

class FakeRecorder implements CaptureRecorder {
  readonly captureId = 'debug-capture';
  readonly inputs: CaptureFrameInput[] = [];

  tryRecord(input: CaptureFrameInput): boolean {
    this.inputs.push(input);
    return true;
  }

  getHealth(): RecorderHealth {
    return {
      state: 'recording',
      pendingFrames: 0,
      pendingBytes: 0,
      maxPendingFrames: 128,
      maxPendingBytes: 2 * 1024 * 1024,
      frameCount: this.inputs.length,
      droppedFrames: 0,
      incomplete: false,
    };
  }

  async finalize(): Promise<void> {}
}

function createClock(sampleCount = 1): {
  now: () => { receivedAt: string; receivedMonotonicMs: number };
} {
  let index = 0;
  return {
    now: () => {
      if (index >= sampleCount) throw new Error('unexpected clock sample');
      const sampleIndex = index++;
      return {
        receivedAt: new Date(
          Date.parse('2026-09-15T00:00:00.100Z') + sampleIndex * 100,
        ).toISOString(),
        receivedMonotonicMs: 100 + sampleIndex * 100,
      };
    },
  };
}

async function readFixtureFrames(path: string): Promise<CaptureFrameV1[]> {
  const capture = await verifyCapture(path);
  const frames: CaptureFrameV1[] = [];
  for await (const frame of iterateCaptureFrames(capture)) frames.push(frame);
  return frames;
}

async function postGsi(app: FastifyInstance, payload: Record<string, unknown>) {
  return app.inject({
    method: 'POST',
    url: '/gsi',
    payload: { auth: { token: TOKEN }, ...payload },
  });
}

describe('Companion debug runtime composition', () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    if (app) {
      await app.close();
      app = undefined;
    }
  });

  it('returns a valid awaiting debug response and exposes delivery health', async () => {
    const recorder = new FakeRecorder();
    const delivery: DeliveryHealthSource = {
      getHealth: () => ({
        id: 'debug-consumer',
        state: 'idle',
        inFlight: false,
        hasPendingLatest: false,
        offered: 0,
        sent: 0,
        coalesced: 0,
        failed: 0,
      }),
      close: async () => {},
    };
    app = buildApp({
      gsiToken: TOKEN,
      recorder,
      producerInstanceId: 'debug-producer',
      debugClock: { nowMonotonicMs: () => 0 },
      deliveryConsumers: [delivery],
      clock: createClock(),
    });

    const response = await app.inject({ method: 'GET', url: '/debug/runtime' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      producerInstanceId: 'debug-producer',
      sourceGeneration: 0,
      freshness: 'awaiting',
      raw: { current: null },
      normalized: { current: null },
      runtime: { lastDisposition: null },
      latestGsiDiagnostics: null,
      deliveryHealth: [{ id: 'debug-consumer', state: 'idle' }],
    });
  });

  it('takes an authenticated raw frame through adapter and ProgramRuntime into debug', async () => {
    const recorder = new FakeRecorder();
    const acceptedRaw: CaptureFrameInput[] = [];
    app = buildApp({
      gsiToken: TOKEN,
      recorder,
      producerInstanceId: 'debug-producer',
      debugClock: { nowMonotonicMs: () => 100 },
      clock: createClock(),
      onAcceptedRaw: (input) => acceptedRaw.push(input),
    });

    const payload = {
      provider: { name: 'CS2', steamid: '76561198000000001' },
      map: { name: 'de_ancient', phase: 'live' },
      round: { phase: 'freezetime' },
      player: { steamid: '76561198000000001', name: 'Observer One', team: 'CT' },
      allplayers: {
        '76561198000000001': {
          name: 'Observer One',
          team: 'CT',
          observer_slot: 1,
        },
      },
    };
    expect((await postGsi(app, payload)).statusCode).toBe(204);
    expect(acceptedRaw).toHaveLength(1);
    expect(recorder.inputs[0]?.payload).toBe(acceptedRaw[0]?.payload);

    const response = await app.inject({ method: 'GET', url: '/debug/runtime' });
    const body: unknown = response.json();
    const parsedBody = body;
    const serialized = JSON.stringify(parsedBody);

    expect(response.statusCode).toBe(200);
    expect(parsedBody).toMatchObject({
      producerInstanceId: 'debug-producer',
      sourceGeneration: 0,
      freshness: 'fresh',
      raw: { current: { sequence: 0, receivedMonotonicMs: 100 } },
      normalized: { current: { receive: { sequence: 0, receivedMonotonicMs: 100 } } },
      runtime: {
        current: {
          runtimeSeq: 1,
          map: { epoch: 1, name: 'de_ancient' },
        },
        lastDisposition: { kind: 'accepted', reason: 'baseline' },
      },
      latestGsiDiagnostics: { entries: [], suppressedCount: 0 },
      recentTransitions: [],
    });
    expect(serialized).not.toContain(TOKEN);
    expect(serialized).not.toContain('76561198000000001');
    expect(serialized).not.toContain('Observer One');
    if (!isRecord(parsedBody) || !isRecord(parsedBody.raw)) {
      throw new Error('debug response raw object is missing');
    }
    const rawCurrent = parsedBody.raw.current;
    if (!isRecord(rawCurrent) || !isRecord(rawCurrent.payload)) {
      throw new Error('debug response raw payload is missing');
    }
    expect(rawCurrent.payload.allplayers).toEqual({
      'player-1': {
        name: '[REDACTED]',
        team: 'CT',
        observer_slot: 1,
      },
    });
  });

  it('takes a canonical real semantic fixture through the full debug runtime path', async () => {
    const frames = await readFixtureFrames(RICH_OBSERVER_FIXTURE);
    expect(frames).toHaveLength(1);
    const frame = frames[0];
    if (frame === undefined) throw new Error('rich observer fixture is empty');

    const recorder = new FakeRecorder();
    app = buildApp({
      gsiToken: TOKEN,
      recorder,
      producerInstanceId: 'fixture-producer',
      debugClock: { nowMonotonicMs: () => 100 },
      clock: createClock(),
    });

    expect((await postGsi(app, frame.payload)).statusCode).toBe(204);

    const response = await app.inject({ method: 'GET', url: '/debug/runtime' });
    const body: unknown = response.json();
    expect(body).toMatchObject({
      producerInstanceId: 'fixture-producer',
      freshness: 'fresh',
      raw: { current: { sequence: 0 } },
      normalized: { current: { telemetry: {} } },
      runtime: { current: { map: { epoch: 1, name: 'de_ancient' } } },
    });
    if (!isRecord(body) || !isRecord(body.normalized) || !isRecord(body.normalized.current)) {
      throw new Error('debug response normalized object is missing');
    }
    const telemetry = body.normalized.current.telemetry;
    if (!isRecord(telemetry) || !Array.isArray(telemetry.allPlayers)) {
      throw new Error('debug response allPlayers evidence is missing');
    }
    expect(telemetry.allPlayers).toHaveLength(10);
  });

  it('keeps a real round transition visible through the production runtime path', async () => {
    const frames = await readFixtureFrames(
      resolve(process.cwd(), 'fixtures/gsi/semantic/bomb/explode-reset'),
    );
    expect(frames.length).toBeGreaterThanOrEqual(2);

    const recorder = new FakeRecorder();
    app = buildApp({
      gsiToken: TOKEN,
      recorder,
      producerInstanceId: 'round-transition-producer',
      debugClock: { nowMonotonicMs: () => 200 },
      clock: createClock(2),
    });

    for (const frame of frames.slice(0, 2)) {
      expect((await postGsi(app, frame.payload)).statusCode).toBe(204);
    }

    const response = await app.inject({ method: 'GET', url: '/debug/runtime' });
    expect(response.json()).toMatchObject({
      runtime: {
        current: { programSource: { lastAccepted: { sequence: 1 } } },
      },
      recentTransitions: [expect.objectContaining({ kind: 'round_ended' })],
    });
  });

  it('takes an ingress sequence gap through Runtime and exposes resync without a cross-gap transition', async () => {
    const sequence = [0, 2];
    let sequenceIndex = 0;
    const recorder = new FakeRecorder();
    app = buildApp({
      gsiToken: TOKEN,
      recorder,
      producerInstanceId: 'gap-resync-producer',
      gsiSequenceSource: () => {
        const value = sequence[sequenceIndex];
        sequenceIndex += 1;
        if (value === undefined) throw new Error('unexpected sequence fault sample');
        return value;
      },
      debugClock: { nowMonotonicMs: () => 200 },
      clock: createClock(2),
    });

    expect(
      (
        await postGsi(app, {
          map: { name: 'de_ancient', phase: 'live' },
          round: { phase: 'freezetime' },
        })
      ).statusCode,
    ).toBe(204);
    expect(
      (
        await postGsi(app, {
          map: { name: 'de_ancient', phase: 'live' },
          round: { phase: 'live' },
        })
      ).statusCode,
    ).toBe(204);

    const response = await app.inject({ method: 'GET', url: '/debug/runtime' });
    expect(response.json()).toMatchObject({
      raw: { current: { sequence: 2 } },
      normalized: { current: { receive: { sequence: 2 } } },
      runtime: {
        current: {
          runtimeSeq: 2,
          programSource: { lastAccepted: { sequence: 2 } },
        },
        lastDisposition: {
          kind: 'accepted',
          reason: 'gap-resync',
          missingSequenceRange: { from: 1, to: 1 },
        },
      },
      recentTransitions: [],
    });
  });

  it.each([
    ['halftime', 'match/halftime-side-switch', 'G2.Esports', 'FURIA'],
    ['overtime', 'match/overtime-side-switch', 'FURIA', 'G2.Esports'],
  ] as const)(
    'keeps %s team identity continuity in the full debug path',
    async (_, path, ct, t) => {
      const frames = await readFixtureFrames(resolve(process.cwd(), 'fixtures/gsi/semantic', path));
      expect(frames).toHaveLength(3);

      const recorder = new FakeRecorder();
      app = buildApp({
        gsiToken: TOKEN,
        recorder,
        producerInstanceId: 'continuity-producer',
        debugClock: { nowMonotonicMs: () => 400 },
        clock: createClock(frames.length),
      });

      for (const frame of frames) {
        expect((await postGsi(app, frame.payload)).statusCode).toBe(204);
      }

      const response = await app.inject({ method: 'GET', url: '/debug/runtime' });
      expect(response.json()).toMatchObject({
        runtime: { current: { map: { epoch: 1, name: 'de_ancient' } } },
        recentTransitions: [],
        normalized: {
          current: {
            telemetry: {
              map: { sides: { ct: { name: ct }, t: { name: t } } },
            },
          },
        },
      });
    },
  );

  it('keeps 204 and records a bounded diagnostic when the accepted-raw seam fails', async () => {
    const recorder = new FakeRecorder();
    app = buildApp({
      gsiToken: TOKEN,
      recorder,
      producerInstanceId: 'debug-producer',
      debugClock: { nowMonotonicMs: () => 100 },
      clock: createClock(),
      onAcceptedRaw: () => {
        throw new Error('debug sink failure');
      },
    });

    expect(
      (
        await postGsi(app, {
          map: { name: 'de_ancient', phase: 'live' },
          round: { phase: 'freezetime' },
        })
      ).statusCode,
    ).toBe(204);

    const response = await app.inject({ method: 'GET', url: '/debug/runtime' });
    expect(response.json()).toMatchObject({
      raw: { current: { sequence: 0 } },
      recentRuntimeDiagnostics: [{ code: 'accepted_raw_sink_failed' }],
    });
  });
});

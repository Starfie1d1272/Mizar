import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app.js';
import {
  GSI_BODY_LIMIT_BYTES,
  PRODUCTION_GSI_CONFIG,
  type ObservationSink,
  type GsiClock,
} from '../src/telemetry/gsi-ingress.js';
import type {
  CaptureFrameInput,
  CaptureRecorder,
  RecorderHealth,
} from '../src/telemetry/capture-recorder.js';

const TOKEN = 'test-gsi-token';

class FakeRecorder implements CaptureRecorder {
  readonly captureId = 'fake-capture';
  readonly inputs: CaptureFrameInput[] = [];
  readonly offered: Buffer[] = [];

  constructor(private readonly admissionResult = true) {}

  tryRecord(input: CaptureFrameInput): boolean {
    this.inputs.push(input);
    this.offered.push(Buffer.from(`${JSON.stringify(input)}\n`, 'utf8'));
    return this.admissionResult;
  }

  getHealth(): RecorderHealth {
    return {
      state: this.admissionResult ? 'recording' : 'degraded',
      pendingFrames: 0,
      pendingBytes: 0,
      maxPendingFrames: 128,
      maxPendingBytes: 2 * 1024 * 1024,
      frameCount: 0,
      droppedFrames: this.admissionResult ? 0 : this.offered.length,
      incomplete: !this.admissionResult,
      ...(this.admissionResult ? {} : { lastErrorCode: 'recorder_overflow' }),
    };
  }

  async finalize(): Promise<void> {}
}

function makeBodyOfSize(size: number): string {
  const empty = JSON.stringify({ auth: { token: TOKEN }, filler: '' });
  const fillerLength = size - Buffer.byteLength(empty);
  if (fillerLength < 0) throw new Error('requested body is smaller than its fixed prefix');
  const body = JSON.stringify({ auth: { token: TOKEN }, filler: 'x'.repeat(fillerLength) });
  if (Buffer.byteLength(body) !== size) throw new Error('failed to construct exact body size');
  return body;
}

function createClock(
  samples: Array<{ receivedAt: string; receivedMonotonicMs: number }>,
): GsiClock {
  let index = 0;
  return {
    now: () => {
      const sample = samples[index];
      index += 1;
      if (sample === undefined) throw new Error('unexpected clock sample');
      return sample;
    },
  };
}

function parseConfigBlock(config: string, blockName: string): Array<[string, string]> {
  const match = config.match(new RegExp(`"${blockName}"\\s*\\{([\\s\\S]*?)\\n\\s*\\}`));
  if (match?.[1] === undefined) throw new Error(`missing cfg block: ${blockName}`);
  return [...match[1].matchAll(/"([^"]+)"\s+"([^"]+)"/g)].map((entry) => [
    entry[1] ?? '',
    entry[2] ?? '',
  ]);
}

describe('Companion GSI ingress', () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    if (app) {
      await app.close();
      app = undefined;
    }
  });

  it('accepts authenticated objects, shares one receive sample, and strips top-level auth', async () => {
    const recorder = new FakeRecorder();
    const received: Array<{ sequence: number; receivedAt: string; receivedMonotonicMs: number }> =
      [];
    const sink: ObservationSink = (observation) => received.push(observation.receive);
    let diagnosticsCallbacks = 0;
    app = buildApp({
      gsiToken: TOKEN,
      recorder,
      clock: createClock([{ receivedAt: '2026-09-14T06:00:00.000Z', receivedMonotonicMs: 10 }]),
      onObservation: sink,
      onGsiDiagnostics: (diagnostics) => {
        diagnosticsCallbacks += 1;
        expect(diagnostics.entries).toEqual([]);
      },
    });

    const response = await app.inject({
      method: 'POST',
      url: '/gsi',
      payload: {
        auth: { token: TOKEN },
        provider: { name: 'Counter-Strike: Global Offensive', appid: 730 },
        nested: { auth: { token: 'nested-value' } },
      },
    });

    expect(response.statusCode).toBe(204);
    expect(recorder.inputs).toHaveLength(1);
    expect(recorder.inputs[0]).toMatchObject({
      sequence: 0,
      receivedAt: '2026-09-14T06:00:00.000Z',
      receivedMonotonicMs: 10,
    });
    expect(recorder.inputs[0]?.payload).toEqual({
      provider: { name: 'Counter-Strike: Global Offensive', appid: 730 },
      nested: { auth: { token: 'nested-value' } },
    });
    expect(JSON.stringify(recorder.inputs[0])).not.toContain(TOKEN);
    expect(received).toEqual([
      { sequence: 0, receivedAt: '2026-09-14T06:00:00.000Z', receivedMonotonicMs: 10 },
    ]);
    expect(diagnosticsCallbacks).toBe(1);
  });

  it('does not consume accepted sequence for rejected requests', async () => {
    const recorder = new FakeRecorder();
    app = buildApp({
      gsiToken: TOKEN,
      recorder,
      clock: createClock([
        { receivedAt: '2026-09-14T06:00:00.000Z', receivedMonotonicMs: 10 },
        { receivedAt: '2026-09-14T06:00:01.000Z', receivedMonotonicMs: 20 },
      ]),
    });

    expect(
      (await app.inject({ method: 'POST', url: '/gsi', payload: { provider: {} } })).statusCode,
    ).toBe(401);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/gsi',
          payload: { auth: { token: 'wrong' }, provider: {} },
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/gsi',
          headers: { 'content-type': 'application/json' },
          payload: '{"auth":',
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/gsi',
          headers: { 'content-type': 'text/plain' },
          payload: '{}',
        })
      ).statusCode,
    ).toBe(415);
    expect(
      (await app.inject({ method: 'POST', url: '/gsi', payload: { auth: { token: TOKEN } } }))
        .statusCode,
    ).toBe(204);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/gsi',
          payload: { auth: { token: TOKEN }, provider: {} },
        })
      ).statusCode,
    ).toBe(204);

    expect(recorder.inputs.map((input) => input.sequence)).toEqual([0, 1]);
  });

  it('rejects non-object roots and enforces the 64 KiB route body limit', async () => {
    const recorder = new FakeRecorder();
    app = buildApp({
      gsiToken: TOKEN,
      recorder,
      clock: createClock([{ receivedAt: '2026-09-14T06:00:00.000Z', receivedMonotonicMs: 10 }]),
    });

    expect((await app.inject({ method: 'POST', url: '/gsi', payload: [] })).statusCode).toBe(400);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/gsi',
          headers: { 'content-type': 'application/json' },
          payload: 'null',
        })
      ).statusCode,
    ).toBe(400);

    const atLimit = await app.inject({
      method: 'POST',
      url: '/gsi',
      headers: { 'content-type': 'application/json' },
      payload: makeBodyOfSize(GSI_BODY_LIMIT_BYTES),
    });
    expect(atLimit.statusCode).toBe(204);

    const overLimit = await app.inject({
      method: 'POST',
      url: '/gsi',
      headers: { 'content-type': 'application/json' },
      payload: makeBodyOfSize(GSI_BODY_LIMIT_BYTES + 1),
    });
    expect(overLimit.statusCode).toBe(413);
  });

  it('keeps accepted HTTP and sink delivery alive when recorder admission or sink fails', async () => {
    const recorder = new FakeRecorder(false);
    let sinkCalls = 0;
    app = buildApp({
      gsiToken: TOKEN,
      recorder,
      onObservation: () => {
        sinkCalls += 1;
        throw new Error('sink failure');
      },
      clock: createClock([{ receivedAt: '2026-09-14T06:00:00.000Z', receivedMonotonicMs: 10 }]),
    });

    const response = await app.inject({
      method: 'POST',
      url: '/gsi',
      payload: { auth: { token: TOKEN }, map: { name: 'de_nuke' } },
    });

    expect(response.statusCode).toBe(204);
    expect(sinkCalls).toBe(1);
    expect((await app.inject({ method: 'GET', url: '/health' })).json()).toMatchObject({
      status: 'degraded',
      recorder: { state: 'degraded', droppedFrames: 1, incomplete: true },
    });
  });

  it('keeps the shipped production cfg aligned with the frozen metadata profile', async () => {
    const config = await readFile(
      resolve(process.cwd(), 'config/gamestate_integration_mizar.cfg.example'),
      'utf8',
    );
    const expectedRootLines: Array<[string, string]> = [
      ['uri', String(PRODUCTION_GSI_CONFIG.uri)],
      ['timeout', String(PRODUCTION_GSI_CONFIG.timeout)],
      ['buffer', String(PRODUCTION_GSI_CONFIG.buffer)],
      ['throttle', String(PRODUCTION_GSI_CONFIG.throttle)],
      ['heartbeat', `${String(PRODUCTION_GSI_CONFIG.heartbeat)}.0`],
    ];

    for (const [key, value] of expectedRootLines) {
      expect(config).toMatch(new RegExp(`"${key}"\\s+"${value}"`));
    }

    const components = PRODUCTION_GSI_CONFIG.components;
    expect(Array.isArray(components)).toBe(true);
    if (!Array.isArray(components)) throw new Error('production components must be an array');
    const expectedComponents = components.map((component) => {
      if (typeof component !== 'string') throw new Error('production component must be a string');
      return [component, '1'] as [string, string];
    });
    expect(parseConfigBlock(config, 'output')).toEqual([
      ['precision_time', String(PRODUCTION_GSI_CONFIG.precision_time)],
      ['precision_position', String(PRODUCTION_GSI_CONFIG.precision_position)],
      ['precision_vector', String(PRODUCTION_GSI_CONFIG.precision_vector)],
    ]);
    expect(parseConfigBlock(config, 'data')).toEqual(expectedComponents);
  });

  it('rejects an empty token at the reusable ingress boundary', () => {
    expect(() => buildApp({ gsiToken: ' ' })).toThrow('gsiToken must be a non-empty value');
  });
});

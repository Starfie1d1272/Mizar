import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app.js';
import type {
  CaptureFrameInput,
  CaptureRecorder,
  RecorderHealth,
} from '../src/telemetry/capture-recorder.js';

const GSI_TOKEN = 'qualification-gsi-token';
const CONTROL_TOKEN = 'qualification-control-token';

class FakeRecorder implements CaptureRecorder {
  readonly captureId: string;
  readonly inputs: CaptureFrameInput[] = [];
  private closed = false;

  constructor(captureId = 'qualification-test-capture') {
    this.captureId = captureId;
  }

  tryRecord(input: CaptureFrameInput): boolean {
    this.inputs.push(input);
    return true;
  }

  getHealth(): RecorderHealth {
    return {
      state: this.closed ? 'closed' : 'recording',
      pendingFrames: 0,
      pendingBytes: 0,
      maxPendingFrames: 128,
      maxPendingBytes: 2 * 1024 * 1024,
      frameCount: this.inputs.length,
      droppedFrames: 0,
      incomplete: false,
    };
  }

  finalize(): Promise<void> {
    this.closed = true;
    return Promise.resolve();
  }
}

class ClockedFakeRecorder extends FakeRecorder {
  captureElapsedUsAt(monotonicMs: number): number {
    return monotonicMs * 1_000;
  }
}

function payload(mapName = 'de_ancient'): Record<string, unknown> {
  return {
    map: { name: mapName, phase: 'live' },
    round: { phase: 'freezetime' },
  };
}

function plantedPayload(mapName = 'de_ancient'): Record<string, unknown> {
  return {
    ...payload(mapName),
    bomb: { state: 'planted', countdown: '30' },
    phase_countdowns: { phase: 'bomb', phase_ends_in: '30' },
    round: { phase: 'live', bomb: 'planted' },
  };
}

async function closeApp(app: FastifyInstance | undefined): Promise<void> {
  if (app !== undefined) await app.close();
}

describe('qualification-only Companion surface', () => {
  let app: FastifyInstance | undefined;
  let temporaryDirectory: string | undefined;

  afterEach(async () => {
    await closeApp(app);
    app = undefined;
    if (temporaryDirectory !== undefined)
      await rm(temporaryDirectory, { recursive: true, force: true });
    temporaryDirectory = undefined;
  });

  it('keeps qualification controls absent unless qualification mode is explicitly enabled', async () => {
    app = buildApp({ gsiToken: GSI_TOKEN, recorder: new FakeRecorder() });

    expect((await app.inject({ method: 'GET', url: '/qualification/status' })).statusCode).toBe(
      404,
    );
    expect(
      (await app.inject({ method: 'POST', url: '/qualification/next-map-execution' })).statusCode,
    ).toBe(404);
  });

  it('authenticates the local control surface and rejects unbounded markers', async () => {
    app = buildApp({
      gsiToken: GSI_TOKEN,
      recorder: new FakeRecorder(),
      qualificationMode: true,
      qualificationControlToken: CONTROL_TOKEN,
      qualificationRunId: 'qualification-test-run',
    });

    expect((await app.inject({ method: 'GET', url: '/qualification' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/qualification/status' })).statusCode).toBe(
      401,
    );
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/qualification/marker',
          headers: { 'x-qualification-token': CONTROL_TOKEN },
          payload: { kind: 'free-form-not-allowed' },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/qualification/marker',
          headers: { 'x-qualification-token': CONTROL_TOKEN },
          payload: { kind: 'runtime-stale' },
        })
      ).statusCode,
    ).toBe(409);
  });

  it('requires explicit objective scenario phases and a recorder-bound capture clock', async () => {
    app = buildApp({
      gsiToken: GSI_TOKEN,
      recorder: new FakeRecorder(),
      qualificationMode: true,
      qualificationControlToken: CONTROL_TOKEN,
      qualificationRunId: 'qualification-objective-run',
    });
    const headers = { 'x-qualification-token': CONTROL_TOKEN };
    const missingPhase = await app.inject({
      method: 'POST',
      url: '/qualification/marker',
      headers,
      payload: { kind: 'objective-plant-abort' },
    });
    expect(missingPhase.statusCode).toBe(400);
    expect(missingPhase.json()).toMatchObject({ error: 'invalid_objective_scenario_phase' });

    const missingClock = await app.inject({
      method: 'POST',
      url: '/qualification/marker',
      headers,
      payload: { kind: 'objective-plant-abort', phase: 'before' },
    });
    expect(missingClock.statusCode).toBe(409);
    expect(missingClock.json()).toMatchObject({ error: 'objective_scenario_capture_unavailable' });
  });

  it('keeps objective timing live status separate from the base Demo A/B result', async () => {
    app = buildApp({
      gsiToken: GSI_TOKEN,
      recorder: new ClockedFakeRecorder(),
      qualificationMode: true,
      qualificationProfile: 'objective-timing',
      qualificationControlToken: CONTROL_TOKEN,
      qualificationRunId: 'qualification-objective-profile-run',
    });
    const headers = { 'x-qualification-token': CONTROL_TOKEN };

    const status = await app.inject({
      method: 'GET',
      url: '/qualification/status',
      headers,
    });
    expect(status.json()).toMatchObject({
      profile: 'objective-timing',
      result: 'INCONCLUSIVE',
      objectiveScenarioProgress: { required: 8, completed: 0, complete: false },
    });

    const page = await app.inject({ method: 'GET', url: '/qualification' });
    expect(page.body).toContain('目标时钟专项验收');
    expect(page.body).toContain('const qualificationProfile = "objective-timing"');
  });

  it('rotates Capture V1 identity inside one qualification run for reconnect evidence', async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), 'rivalhub-qualification-rotation-'));
    const first = new ClockedFakeRecorder('capture-a');
    const second = new ClockedFakeRecorder('capture-b');
    let monotonicMs = 100;
    let sequence = 0;
    app = buildApp({
      gsiToken: GSI_TOKEN,
      recorder: first,
      gsiSequenceSource: () => sequence++,
      qualificationMode: true,
      qualificationControlToken: CONTROL_TOKEN,
      qualificationRunId: 'qualification-rotation-run',
      qualificationScenarioPath: join(temporaryDirectory, 'scenario.jsonl'),
      onQualificationRecorderRotate: (current) => {
        expect(current).toBe(first);
        return Promise.resolve({
          previousCaptureId: current.captureId,
          captureId: second.captureId,
          nextRecorder: second,
        });
      },
      qualificationClock: {
        now: () => ({
          monotonicMs,
          utc: `2026-09-21T00:00:00.${String(monotonicMs).padStart(3, '0')}Z`,
        }),
      },
      clock: {
        now: () => ({
          receivedAt: `2026-09-21T00:00:00.${String(monotonicMs).padStart(3, '0')}Z`,
          receivedMonotonicMs: monotonicMs,
        }),
      },
    });
    const headers = { 'x-qualification-token': CONTROL_TOKEN };

    for (const now of [100, 110, 120]) {
      monotonicMs = now;
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/gsi',
            payload: { auth: { token: GSI_TOKEN }, ...plantedPayload() },
          })
        ).statusCode,
      ).toBe(204);
    }

    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/qualification/marker',
          headers,
          payload: { kind: 'objective-reconnect-restart', phase: 'before' },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/qualification/recorder/rotate',
          headers,
        })
      ).json(),
    ).toMatchObject({
      ok: true,
      previousCaptureId: 'capture-a',
      captureId: 'capture-b',
    });
    expect(first.getHealth().state).toBe('closed');
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/qualification/status',
          headers,
        })
      ).json(),
    ).toMatchObject({ sourceGeneration: 1, freshness: 'awaiting' });
    const missingRecoveryObservation = await app.inject({
      method: 'POST',
      url: '/qualification/marker',
      headers,
      payload: { kind: 'objective-reconnect-restart', phase: 'after' },
    });
    expect(missingRecoveryObservation.statusCode).toBe(409);
    expect(missingRecoveryObservation.json()).toMatchObject({
      error: 'objective_recovery_observation_required',
    });
    monotonicMs = 200;
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/gsi',
          payload: { auth: { token: GSI_TOKEN }, ...plantedPayload() },
        })
      ).statusCode,
    ).toBe(204);
    expect((await app.inject({ method: 'GET', url: '/debug/runtime' })).json()).toMatchObject({
      sourceGeneration: 1,
      freshness: 'fresh',
      runtime: {
        lastDisposition: { kind: 'accepted', reason: 'contiguous' },
      },
    });
    expect(second.inputs.map((input) => input.sequence)).toEqual([3]);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/qualification/marker',
          headers,
          payload: { kind: 'objective-reconnect-restart', phase: 'after' },
        })
      ).statusCode,
    ).toBe(200);

    const markers = (await readFile(join(temporaryDirectory, 'scenario.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map(
        (line) =>
          JSON.parse(line) as {
            captureId: string;
            phase: string;
            sourceGeneration: number;
            observation: { sourceGeneration: number };
          },
      );
    expect(
      markers.map(({ captureId, phase, sourceGeneration, observation }) => ({
        captureId,
        phase,
        sourceGeneration,
        observationSourceGeneration: observation.sourceGeneration,
      })),
    ).toEqual([
      {
        captureId: 'capture-a',
        phase: 'before',
        sourceGeneration: 0,
        observationSourceGeneration: 0,
      },
      {
        captureId: 'capture-b',
        phase: 'after',
        sourceGeneration: 1,
        observationSourceGeneration: 1,
      },
    ]);
  });

  it('hands the final runtime snapshot to the qualification launcher before shutdown', async () => {
    let finishDebug: unknown;
    app = buildApp({
      gsiToken: GSI_TOKEN,
      recorder: new FakeRecorder(),
      qualificationMode: true,
      qualificationControlToken: CONTROL_TOKEN,
      qualificationRunId: 'qualification-finish-run',
      onQualificationFinish: ({ debug }) => {
        finishDebug = debug;
      },
    });

    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/gsi',
          payload: { auth: { token: GSI_TOKEN }, ...payload() },
        })
      ).statusCode,
    ).toBe(204);
    const response = await app.inject({
      method: 'POST',
      url: '/qualification/finish',
      headers: { 'x-qualification-token': CONTROL_TOKEN },
    });
    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({
      status: 'stopping',
      finalizationPath: '/qualification/finalization',
    });

    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(finishDebug).toMatchObject({ freshness: 'fresh', raw: { current: { sequence: 0 } } });
  });

  it('allows the operator exit confirmation after runtime freshness becomes stale', async () => {
    let monotonicMs = 100;
    app = buildApp({
      gsiToken: GSI_TOKEN,
      recorder: new FakeRecorder(),
      qualificationMode: true,
      qualificationControlToken: CONTROL_TOKEN,
      qualificationRunId: 'qualification-stop-run',
      qualificationClock: {
        now: () => ({
          monotonicMs,
          utc: new Date(Date.parse('2026-09-15T00:00:00.000Z') + monotonicMs).toISOString(),
        }),
      },
      debugClock: { nowMonotonicMs: () => monotonicMs },
      clock: {
        now: () => ({
          receivedAt: new Date(Date.parse('2026-09-15T00:00:00.000Z') + monotonicMs).toISOString(),
          receivedMonotonicMs: monotonicMs,
        }),
      },
    });

    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/gsi',
          payload: { auth: { token: GSI_TOKEN }, ...payload() },
        })
      ).statusCode,
    ).toBe(204);
    const headers = { 'x-qualification-token': CONTROL_TOKEN };
    await app.inject({
      method: 'POST',
      url: '/qualification/marker',
      headers,
      payload: { kind: 'demo-a-live' },
    });

    monotonicMs = 20_101;
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/qualification/status',
          headers,
        })
      ).json(),
    ).toMatchObject({ freshness: 'stale', markers: ['demo-a-live', 'runtime-stale'] });

    monotonicMs = 20_200;
    const stopped = await app.inject({
      method: 'POST',
      url: '/qualification/stop',
      headers,
    });
    expect(stopped.statusCode).toBe(200);
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/qualification/status',
          headers,
        })
      ).json(),
    ).toMatchObject({
      markers: ['demo-a-live', 'runtime-stale', 'cs2-closed'],
      freshness: 'stale',
    });
  });

  it('accepts bodyless stop, reset, and finish requests from the browser flow', async () => {
    let monotonicMs = 100;
    app = buildApp({
      gsiToken: GSI_TOKEN,
      recorder: new FakeRecorder(),
      qualificationMode: true,
      qualificationControlToken: CONTROL_TOKEN,
      qualificationRunId: 'qualification-bodyless-post-run',
      qualificationClock: {
        now: () => ({
          monotonicMs,
          utc: new Date(Date.parse('2026-09-15T00:00:00.000Z') + monotonicMs).toISOString(),
        }),
      },
      debugClock: { nowMonotonicMs: () => monotonicMs },
      clock: {
        now: () => ({
          receivedAt: new Date(Date.parse('2026-09-15T00:00:00.000Z') + monotonicMs).toISOString(),
          receivedMonotonicMs: monotonicMs,
        }),
      },
    });

    const headers = { 'x-qualification-token': CONTROL_TOKEN };
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/gsi',
          payload: { auth: { token: GSI_TOKEN }, ...payload() },
        })
      ).statusCode,
    ).toBe(204);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/qualification/marker',
          headers,
          payload: { kind: 'demo-a-live' },
        })
      ).statusCode,
    ).toBe(200);

    monotonicMs = 20_101;
    await app.inject({ method: 'GET', url: '/qualification/status', headers });

    expect(
      (await app.inject({ method: 'POST', url: '/qualification/stop', headers })).statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/qualification/next-map-execution',
          headers,
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (await app.inject({ method: 'POST', url: '/qualification/finish', headers })).statusCode,
    ).toBe(202);
  });

  it('records the explicit reset and clears old debug telemetry without changing identity', async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), 'rivalhub-qualification-'));
    let monotonicMs = 100;
    const recorder = new FakeRecorder();
    app = buildApp({
      gsiToken: GSI_TOKEN,
      recorder,
      producerInstanceId: 'qualification-producer',
      qualificationMode: true,
      qualificationControlToken: CONTROL_TOKEN,
      qualificationRunId: 'qualification-test-run',
      qualificationScenarioPath: join(temporaryDirectory, 'scenario.jsonl'),
      qualificationClock: {
        now: () => ({
          monotonicMs,
          utc: new Date(Date.parse('2026-09-15T00:00:00.000Z') + monotonicMs).toISOString(),
        }),
      },
      debugClock: { nowMonotonicMs: () => monotonicMs },
      clock: {
        now: () => {
          return {
            receivedAt: new Date(
              Date.parse('2026-09-15T00:00:00.000Z') + monotonicMs,
            ).toISOString(),
            receivedMonotonicMs: monotonicMs,
          };
        },
      },
    });

    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/gsi',
          payload: { auth: { token: GSI_TOKEN }, ...payload() },
        })
      ).statusCode,
    ).toBe(204);

    monotonicMs = 20_101;
    const stale = await app.inject({
      method: 'GET',
      url: '/qualification/status',
      headers: { 'x-qualification-token': CONTROL_TOKEN },
    });
    expect(stale.json()).toMatchObject({
      runId: 'qualification-test-run',
      gsi: 'silent',
      freshness: 'stale',
      markers: ['runtime-stale'],
    });

    monotonicMs = 20_200;
    const reset = await app.inject({
      method: 'POST',
      url: '/qualification/next-map-execution',
      headers: { 'x-qualification-token': CONTROL_TOKEN },
    });
    expect(reset.statusCode).toBe(200);
    expect(reset.json()).toMatchObject({
      ok: true,
      reason: 'operator-correction',
      producerInstanceId: 'qualification-producer',
      sourceGeneration: 0,
      previousMapEpoch: 1,
      mapEpoch: 2,
      runtimeSeq: 2,
      programTelemetryCleared: true,
      disposition: { kind: 'accepted', reason: 'map-execution-reset' },
    });

    const debug = await app.inject({ method: 'GET', url: '/debug/runtime' });
    const debugBody = debug.json<{
      readonly raw: { readonly current: unknown };
      readonly normalized: { readonly current: unknown };
      readonly runtime: { readonly current: Record<string, unknown> };
    }>();
    expect(debugBody).toMatchObject({
      producerInstanceId: 'qualification-producer',
      sourceGeneration: 0,
      raw: { current: null },
      normalized: { current: null },
      runtime: { current: { map: { epoch: 2 } } },
    });
    expect(debugBody.runtime.current.programTelemetry).toBeUndefined();

    const scenario = await readFile(join(temporaryDirectory, 'scenario.jsonl'), 'utf8');
    const markers = scenario
      .trim()
      .split('\n')
      .map(
        (line) =>
          JSON.parse(line) as {
            kind: string;
            phase?: string;
            mapEpoch: number;
            reset?: { programTelemetryCleared?: boolean };
          },
      );
    expect(markers).toEqual([
      expect.objectContaining({ kind: 'runtime-stale' }),
      expect.objectContaining({ kind: 'next-execution', phase: 'before', mapEpoch: 1 }),
      expect.objectContaining({
        kind: 'next-execution',
        phase: 'after',
        mapEpoch: 2,
      }),
    ]);
    expect(markers[2]?.reset?.programTelemetryCleared).toBe(true);
  });

  it('accepts Demo B after Core observes a real map-name boundary', async () => {
    let monotonicMs = 100;
    app = buildApp({
      gsiToken: GSI_TOKEN,
      recorder: new FakeRecorder(),
      producerInstanceId: 'qualification-producer',
      qualificationMode: true,
      qualificationControlToken: CONTROL_TOKEN,
      qualificationRunId: 'qualification-observed-boundary-run',
      qualificationClock: {
        now: () => ({
          monotonicMs,
          utc: new Date(Date.parse('2026-09-15T00:00:00.000Z') + monotonicMs).toISOString(),
        }),
      },
      debugClock: { nowMonotonicMs: () => monotonicMs },
      clock: {
        now: () => ({
          receivedAt: new Date(Date.parse('2026-09-15T00:00:00.000Z') + monotonicMs).toISOString(),
          receivedMonotonicMs: monotonicMs,
        }),
      },
    });

    const headers = { 'x-qualification-token': CONTROL_TOKEN };
    const postGsi = async (mapName: string) =>
      app?.inject({
        method: 'POST',
        url: '/gsi',
        payload: { auth: { token: GSI_TOKEN }, ...payload(mapName) },
      });

    expect((await postGsi('de_ancient'))?.statusCode).toBe(204);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/qualification/marker',
          headers,
          payload: { kind: 'demo-a-live' },
        })
      ).statusCode,
    ).toBe(200);

    monotonicMs = 20_101;
    await app.inject({ method: 'GET', url: '/qualification/status', headers });
    expect(
      (await app.inject({ method: 'POST', url: '/qualification/stop', headers })).statusCode,
    ).toBe(200);

    monotonicMs = 20_200;
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/qualification/next-map-execution',
          headers,
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/qualification/marker',
          headers,
          payload: { kind: 'cs2-reopened' },
        })
      ).statusCode,
    ).toBe(200);

    monotonicMs = 20_300;
    expect((await postGsi('de_ancient'))?.statusCode).toBe(204);
    monotonicMs = 20_400;
    expect((await postGsi('de_dust2'))?.statusCode).toBe(204);
    monotonicMs = 20_500;
    expect((await postGsi('de_dust2'))?.statusCode).toBe(204);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/qualification/marker',
          headers,
          payload: { kind: 'demo-b-live' },
        })
      ).statusCode,
    ).toBe(200);

    const status = await app.inject({
      method: 'GET',
      url: '/qualification/status',
      headers,
    });
    expect(status.json()).toMatchObject({
      mapEpoch: 3,
      checks: {
        productionChain: { status: 'PASS' },
        realSilenceToStale: { status: 'PASS' },
        explicitNextExecution: { status: 'PASS' },
        demoBRecovery: { status: 'PASS' },
      },
    });
  });

  it('supports host checkpoints, controlled restart, and release profile finish gate', async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), 'rivalhub-qualification-release-'));
    const scenarioPath = join(temporaryDirectory, 'scenario.jsonl');
    const hostCheckpointsPath = join(temporaryDirectory, 'host-checkpoints.jsonl');

    let restarted = false;

    app = buildApp({
      gsiToken: GSI_TOKEN,
      recorder: new FakeRecorder(),
      qualificationMode: true,
      qualificationControlToken: CONTROL_TOKEN,
      qualificationRunId: 'release-test-run',
      qualificationScenarioPath: scenarioPath,
      qualificationHostCheckpointsPath: hostCheckpointsPath,
      qualificationProfile: 'release',
      onQualificationRestart: () => {
        restarted = true;
      },
    });

    const headers = { 'x-qualification-token': CONTROL_TOKEN };

    // Initial finish attempt fails with 409 because workflow is incomplete
    const earlyFinish = await app.inject({
      method: 'POST',
      url: '/qualification/finish',
      headers,
    });
    expect(earlyFinish.statusCode).toBe(409);
    expect(earlyFinish.json()).toMatchObject({ error: 'qualification_release_incomplete' });

    // Record host checkpoint: browser-reload before
    const bBefore = await app.inject({
      method: 'POST',
      url: '/qualification/host-checkpoint',
      headers,
      payload: { scenario: 'browser-reload', phase: 'before' },
    });
    expect(bBefore.statusCode).toBe(200);

    // Record host checkpoint: browser-reload after with programVisible
    const bAfter = await app.inject({
      method: 'POST',
      url: '/qualification/host-checkpoint',
      headers,
      payload: { scenario: 'browser-reload', phase: 'after', programVisible: true },
    });
    expect(bAfter.statusCode).toBe(200);

    // Call restart-companion
    const restartRes = await app.inject({
      method: 'POST',
      url: '/qualification/restart-companion',
      headers,
    });
    expect(restartRes.statusCode).toBe(200);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(restarted).toBe(true);

    // Verify host-checkpoints.jsonl contains both checkpoints plus companion-restart before
    const lines = (await readFile(hostCheckpointsPath, 'utf8')).trim().split('\n');
    expect(lines.length).toBe(3);
    const parsed = lines.map(
      (l) => JSON.parse(l) as { scenario: string; phase: string; programVisible?: boolean },
    );
    expect(parsed[0]?.scenario).toBe('browser-reload');
    expect(parsed[0]?.phase).toBe('before');
    expect(parsed[1]?.scenario).toBe('browser-reload');
    expect(parsed[1]?.phase).toBe('after');
    expect(parsed[1]?.programVisible).toBe(true);
    expect(parsed[2]?.scenario).toBe('companion-restart');
    expect(parsed[2]?.phase).toBe('before');
  });
});

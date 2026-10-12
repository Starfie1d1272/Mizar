import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { describe, it, expect, afterEach } from 'vitest';
import { toMatchContext, type BroadcastManifest } from '@mizar/rivalhub';
import type { TelemetryObservation } from '@mizar/core/telemetry';
import type { ReliableEventV1 } from '@mizar/protocol/output';

import { JsonSeriesProgressCheckpointStore } from '../src/series-progress/checkpoint-store.js';
import { ReliableOutbox, type DeliveryContinuity } from '../src/output/reliable-outbox.js';
import { OutputService } from '../src/output/service.js';
import {
  MatchContextController,
  MatchManifestLkgStore,
  type MatchContextBinding,
} from '../src/match-context/index.js';
import { RivalsRehearsal } from '../src/match-context/rivals-rehearsal.js';
import { createProgramRuntime } from '../src/runtime/program-runtime.js';
import { createProjectionCoordinator } from '../src/projections/projection-coordinator.js';
import { createCstvSourceManagers } from '../src/telemetry/cstv-source-manager.js';
import { ProgramSceneController } from '../src/program-scenes/controller.js';
import type { BpSession } from '../src/bp/controller.js';

const fixturePath = resolve(
  process.cwd(),
  'fixtures/rivals-rehearsal/rivals-rehearsal.generated.json',
);

describe('Fixture durable isolation & lifecycle', () => {
  const temporaryDirs: string[] = [];
  const cleanups: (() => Promise<void>)[] = [];

  afterEach(async () => {
    while (cleanups.length > 0) {
      const cleanup = cleanups.pop();
      if (cleanup) await cleanup();
    }
    while (temporaryDirs.length > 0) {
      const dir = temporaryDirs.pop();
      if (dir) await rm(dir, { recursive: true, force: true });
    }
  });

  async function createFixtureHarness(
    options: {
      readonly checkpointStore?: JsonSeriesProgressCheckpointStore;
      readonly outbox?: ReliableOutbox;
      readonly outputServiceNow?: () => Date;
    } = {},
  ) {
    const dir = await mkdtemp(join(tmpdir(), 'mizar-fixture-isolation-'));
    temporaryDirs.push(dir);

    const lkgStore = new MatchManifestLkgStore({ filePath: join(dir, 'lkg.json') });
    let outputBinding: MatchContextBinding | undefined;
    const runtime = createProgramRuntime('test-producer', {
      ...(options.checkpointStore
        ? { seriesProgressCheckpointStore: options.checkpointStore }
        : {}),
    });

    const coordinator = createProjectionCoordinator({
      programRuntime: runtime,
      cstvSources: createCstvSourceManagers({}),
      nowMonotonicMs: () => performance.now(),
    });

    const outbox = options.outbox ?? new ReliableOutbox(join(dir, 'reliable-outbox.json'));
    const outputService = new OutputService({
      outbox,
      now: options.outputServiceNow ?? (() => new Date('2026-09-28T00:00:00.000Z')),
    });
    await outputService.start();

    const controller = new MatchContextController({
      lkgStore,
      onBindingChanged: (binding) => {
        const previousOrigin = outputBinding?.origin;
        outputBinding = binding;
        outputService.setBinding(binding);
        coordinator.setMatchContextBinding(binding);

        if (previousOrigin === 'fixture' && binding?.origin !== 'fixture') {
          rehearsal?.exitFixtureRuntimeState();
        }
      },
    });

    const bpSession = {
      get: () => ({ projection: null, state: 'hidden' }),
    } as unknown as BpSession;
    const sceneController = new ProgramSceneController(coordinator, bpSession);

    const dispatchObservation = (
      observation: TelemetryObservation,
      sampleStageBinding?: { mapOrder: number },
    ): void => {
      outputService.beforeRuntimeMutation();
      const result = runtime.acceptObservation(observation);
      if (sampleStageBinding) {
        runtime.executeOperatorCommand({
          kind: 'bind-current-map-execution-to-series-map',
          mapOrder: sampleStageBinding.mapOrder,
          reason: `Rivals 示例第 ${sampleStageBinding.mapOrder} 图执行绑定`,
        });
      }
      const bundle = coordinator.afterRuntimeMutation(result);
      outputService.afterRuntimeMutation(result, bundle, outputBinding);
    };

    const rehearsal = new RivalsRehearsal(
      fixturePath,
      controller,
      sceneController,
      dispatchObservation,
      {
        activateFixtureSeriesProgress: (context) => {
          runtime.activateFixtureSeriesProgress(context);
          coordinator.refresh();
        },
        clearFixtureSeriesProgress: () => {
          runtime.clearFixtureSeriesProgress();
          coordinator.refresh();
        },
      },
    );

    cleanups.push(async () => {
      await outputService.close();
      await coordinator.close();
      await runtime.close();
    });

    return {
      dir,
      controller,
      runtime,
      coordinator,
      sceneController,
      outputService,
      outbox,
      rehearsal,
      dispatchObservation,
    };
  }

  it('1. running rehearsal to Stage 5/14 does not modify production checkpoint; selecting same focus matchId online restores zero score', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mizar-checkpoint-iso-'));
    temporaryDirs.push(dir);
    const checkpointPath = join(dir, 'series-progress.checkpoint.json');
    const checkpointStore = new JsonSeriesProgressCheckpointStore({ filePath: checkpointPath });

    const { rehearsal, controller, runtime, coordinator } = await createFixtureHarness({
      checkpointStore,
    });

    expect(checkpointStore.load()).toBeUndefined();
    expect(existsSync(checkpointPath)).toBe(false);

    // Enter rehearsal and progress to Map Result (Stage 5)
    await rehearsal.load();
    await rehearsal.stage(3);
    await rehearsal.stage(5);

    // Fixture series progress in memory shows map 1 finished with score 0:1
    expect(runtime.getSeriesProgress()?.score).toEqual({ a: 0, b: 1 });
    expect(coordinator.getCurrent().program.series?.score).toEqual({ a: 0, b: 1 });

    // Progress further to Match Result (Stage 14)
    await rehearsal.stage(7);
    await rehearsal.stage(9);
    await rehearsal.stage(11);
    await rehearsal.stage(13);
    await rehearsal.stage(14);
    expect(runtime.getSeriesProgress()?.score).toEqual({ a: 2, b: 1 });

    // CRITICAL: Production checkpoint file MUST NOT exist or have been written!
    expect(existsSync(checkpointPath)).toBe(false);
    expect(checkpointStore.load()).toBeUndefined();

    // Now stop rehearsal
    rehearsal.stop();
    expect(runtime.getSeriesProgress()).toBeNull();

    // Select the EXACT SAME focus matchId as a real online match context
    const rawFixture = JSON.parse(await readFile(fixturePath, 'utf8')) as {
      focusMatchId: string;
      manifests: Record<string, BroadcastManifest>;
    };
    const focusManifest = rawFixture.manifests[rawFixture.focusMatchId]!;
    if (!focusManifest.match.competition) throw new Error('event fixture required');
    const onlineManifest: BroadcastManifest = {
      ...focusManifest,
      match: {
        ...focusManifest.match,
        competition: { ...focusManifest.match.competition, competitionId: 'prod-competition' },
        scoreA: null,
        scoreB: null,
        completedAt: null,
      },
      maps: focusManifest.maps.map((map) => ({
        ...map,
        scoreA: null,
        scoreB: null,
        completedAt: null,
      })),
    };

    const selectResult = await controller.selectMatch(rawFixture.focusMatchId, {
      kind: 'online',
      load: () => Promise.resolve(onlineManifest),
    });
    expect(selectResult.ok).toBe(true);
    expect(controller.getActiveBinding()?.origin).toBe('online');

    const freshContext = toMatchContext(onlineManifest);
    const prodSeries = runtime.synchronizeSeriesProgress(freshContext, null);

    // CRITICAL: Does NOT restore any fixture score! Clean match starts at 0-0
    expect(prodSeries).toBeDefined();
    expect(prodSeries?.score).toEqual({ a: 0, b: 0 });
    expect(prodSeries?.maps[0]?.status).toBe('pending');
    expect(prodSeries?.maps[0]?.finalScore).toBeNull();
    expect(prodSeries?.maps[1]?.status).toBe('pending');
    expect(prodSeries?.maps[1]?.finalScore).toBeNull();
    expect(prodSeries?.maps[2]?.status).toBe('pending');
    expect(prodSeries?.maps[2]?.finalScore).toBeNull();
  });

  it('2. preserves pre-existing production pending ReliableEvent and continuity across rehearsal execution and retry', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mizar-outbox-iso-'));
    temporaryDirs.push(dir);
    const outboxPath = join(dir, 'reliable-outbox.json');
    const outbox = new ReliableOutbox(outboxPath);

    const productionContinuity: DeliveryContinuity = {
      matchId: '11111111-1111-4111-8111-111111111111',
      contextRevision: 'rev-prod-100',
      cursor: {
        producerInstanceId: 'prod-app',
        liveSessionId: 'sess-prod',
        programSourceGeneration: 1,
        programReceiveSequence: 10,
        mapEpoch: 1,
        runtimeSeq: 10,
      },
      mapName: 'de_mirage',
      savedAt: '2026-09-28T00:00:00.000Z',
    };

    const productionEvent: ReliableEventV1 = {
      schemaVersion: 'mizar.reliable-event.v1',
      idempotencyKey: 'idem-prod-1',
      matchId: '11111111-1111-4111-8111-111111111111',
      competitionId: 'comp-100',
      contextRevision: 'rev-prod-100',
      mapId: 'map-100',
      mapName: 'de_mirage',
      entryAId: 'entry-a',
      entryBId: 'entry-b',
      observedAt: '2026-09-28T00:00:00.000Z',
      cursor: {
        producerInstanceId: 'prod-app',
        liveSessionId: 'sess-prod',
        programSourceGeneration: 1,
        programReceiveSequence: 10,
        mapEpoch: 1,
        runtimeSeq: 10,
      },
      evidence: {
        identity: 'matched',
        telemetryFresh: true,
        contextFresh: true,
        source: 'runtime-transition',
      },
      kind: 'map_started',
      payload: {},
    };

    // Pre-seed production outbox with one pending event and continuity
    await outbox.enqueue(
      productionEvent,
      new Date('2026-09-28T00:00:00.000Z'),
      productionContinuity,
    );
    await outbox.flushPending();

    expect(outbox.getRecords()).toHaveLength(1);
    expect(outbox.getRecords()[0]?.status).toBe('pending');
    expect(outbox.getContinuity()).toEqual(productionContinuity);

    let nowMs = Date.parse('2026-09-28T00:00:00.000Z');
    const { rehearsal, outputService } = await createFixtureHarness({
      outbox,
      outputServiceNow: () => new Date(nowMs),
    });

    // Enter rehearsal and progress through stages
    await rehearsal.load();
    await rehearsal.stage(3);
    await rehearsal.stage(5);

    // Push the clock past the retention window: production retention and delivery
    // processing must stay frozen for as long as the sample owns the session.
    nowMs += 25 * 60 * 60 * 1000;
    await outputService.retry();
    await outbox.flushPending();

    // CRITICAL:
    // 1) The pre-seeded event is STILL 'pending' (not superseded, not expired)
    // 2) The continuity was NOT overwritten by the fixture
    // 3) No fixture events were enqueued into production outbox
    const records = outbox.getRecords();
    expect(records).toHaveLength(1);
    expect(records[0]?.event.idempotencyKey).toBe(productionEvent.idempotencyKey);
    expect(records[0]?.status).toBe('pending');
    expect(outbox.getContinuity()).toEqual(productionContinuity);

    // Leaving the sample resumes normal retention and delivery processing.
    rehearsal.stop();
    await outputService.retry();
    expect(outbox.getRecords()[0]?.status).toBe('expired');
  });
});

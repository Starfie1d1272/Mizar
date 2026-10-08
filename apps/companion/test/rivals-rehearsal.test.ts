import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import type { TelemetryObservation } from '@mizar/core/telemetry';
import type { ProgramProjection } from '@mizar/core/projection';
import type { ProgramSceneId } from '@mizar/protocol/program-scenes';
import { toMatchContext, type BroadcastManifest } from '@mizar/rivalhub';
import { MatchContextController, MatchManifestLkgStore } from '../src/match-context/index.js';
import {
  RivalsRehearsal,
  registerRivalsRehearsalRoutes,
} from '../src/match-context/rivals-rehearsal.js';
import { ProgramSceneController } from '../src/program-scenes/controller.js';
import type { BpSession } from '../src/bp/controller.js';
import { createProgramRuntime } from '../src/runtime/program-runtime.js';
import { createProjectionCoordinator } from '../src/projections/projection-coordinator.js';
import type { OperatorProjection } from '../src/projections/operator-projection.js';
import { createCstvSourceManagers } from '../src/telemetry/cstv-source-manager.js';

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

const fixturePath = resolve(
  import.meta.dirname,
  '../../../fixtures/rivals-rehearsal/rivals-rehearsal.generated.json',
);

describe('RivalsRehearsal', () => {
  it('uses EPL map-specific recordings and hides unsupported telemetry stages', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mizar-epl-rehearsal-'));
    temporary.push(dir);
    const runtime = createProgramRuntime('test-epl-rehearsal');
    const coordinator = createProjectionCoordinator({
      programRuntime: runtime,
      cstvSources: createCstvSourceManagers({}),
      nowMonotonicMs: () => performance.now(),
    });
    const controller = new MatchContextController({
      lkgStore: new MatchManifestLkgStore({ filePath: join(dir, 'lkg.json') }),
      onBindingChanged: (binding) => coordinator.setMatchContextBinding(binding),
    });
    const observations: TelemetryObservation[] = [];
    const scene = new ProgramSceneController(coordinator, {
      get: () => ({ projection: null, state: 'hidden' }),
    } as unknown as BpSession);
    const rehearsal = new RivalsRehearsal(
      resolve(import.meta.dirname, '../../../fixtures/epl-s24/rehearsal.generated.json'),
      controller,
      scene,
      (observation, binding) => {
        observations.push(observation);
        const result = runtime.acceptObservation(observation);
        if (binding)
          runtime.executeOperatorCommand({
            kind: 'bind-current-map-execution-to-series-map',
            mapOrder: binding.mapOrder,
            reason: 'EPL 示例地图执行绑定',
          });
        coordinator.afterRuntimeMutation(result);
      },
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
    const schedule = await rehearsal.schedule();
    expect(schedule.competition.name).toBe('ESL Pro League Season 24');
    expect(schedule.matches).toHaveLength(4);
    expect(schedule.matches.find((match) => match.matchId === 'hltv-2398745')?.scoreA).toBeNull();
    const loaded = await rehearsal.load();
    expect(controller.getActiveBinding()?.manifest.match.scheduledAt).toBe(
      '2026-10-06T19:00:00.000Z',
    );
    expect(loaded.stages.some((stage) => stage.label === '第二图 · 比赛中')).toBe(false);
    for (const [label, mapName] of [
      ['第一图 · 比赛中', 'de_inferno'],
      ['第一图 · 半场', 'de_inferno'],
      ['决胜图 · 比赛中', 'de_mirage'],
    ]) {
      const index = loaded.stages.findIndex((stage) => stage.label === label);
      await rehearsal.stage(index);
      expect(observations.at(-1)?.telemetry.map?.name).toBe(mapName);
      expect(observations.at(-1)?.telemetry.allPlayers).toHaveLength(10);
      const program = coordinator.getCurrent().program;
      expect(program.status.telemetry).toBe('fresh');
      expect(program.series?.bindingState).toBe('bound');
      expect(program.series?.currentMapOrder).toBe(mapName === 'de_mirage' ? 3 : 1);
      expect(scene.get().active).toBe(loaded.stages[index]!.scene);
    }
    await rehearsal.stage(loaded.stages.length - 1);
    expect(controller.getActiveBinding()?.manifest.match).toMatchObject({
      status: 'finished',
      scoreA: 2,
      scoreB: 1,
    });
    expect(scene.get().active).toBe('match_result');
    expect(coordinator.getCurrent().program.series?.score).toEqual({ a: 2, b: 1 });
    rehearsal.stop();
    expect(controller.getActiveBinding()).toBeUndefined();
    expect(runtime.getSeriesProgress()).toBeNull();
    expect(scene.get().active).toBe('waiting');
  });

  it('rejects a recording from the wrong map before activating a fixture', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mizar-epl-wrong-map-'));
    temporary.push(dir);
    const input = JSON.parse(
      await readFile(
        resolve(import.meta.dirname, '../../../fixtures/epl-s24/rehearsal.generated.json'),
        'utf8',
      ),
    ) as { observations: Record<string, { map: { name: string } }> };
    input.observations['11']!.map.name = 'de_ancient';
    const path = join(dir, 'fixture.json');
    await writeFile(path, JSON.stringify(input));
    const controller = new MatchContextController({
      lkgStore: new MatchManifestLkgStore({ filePath: join(dir, 'lkg.json') }),
    });
    const rehearsal = new RivalsRehearsal(path, controller);
    await expect(rehearsal.load()).rejects.toThrow('遥测与地图不匹配');
    expect(controller.getActiveBinding()).toBeUndefined();
  });

  it('browses schedule window, switches matches, and advances stages', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mizar-rehearsal-test-'));
    temporary.push(dir);

    const lkgStore = new MatchManifestLkgStore({ filePath: join(dir, 'lkg.json') });
    const controller = new MatchContextController({ lkgStore });
    const forceSceneMock = vi.fn();
    const sceneController = {
      forceScene: forceSceneMock,
    } as unknown as ProgramSceneController;
    const observations: TelemetryObservation[] = [];
    const onObservation = (obs: TelemetryObservation) => {
      observations.push(obs);
    };

    const rehearsal = new RivalsRehearsal(fixturePath, controller, sceneController, onObservation);

    // 1. Browse schedule window
    const schedule = await rehearsal.schedule();
    expect(schedule.matches.length).toBeGreaterThanOrEqual(3);
    const focusMatch = schedule.matches.find((m) => m.matchId === rehearsal.view().focusMatchId);
    expect(focusMatch).toBeDefined();

    // 2. Load focus match
    const loadedView = await rehearsal.load();
    expect(loadedView.loaded).toBe(true);
    expect(loadedView.selectedMatchId).toBe(loadedView.focusMatchId);
    expect(loadedView.stageIndex).toBe(0);
    expect(controller.getActiveBinding()?.origin).toBe('fixture');
    expect(controller.getActiveBinding()?.manifest.match.matchId).toBe(loadedView.focusMatchId);
    expect(forceSceneMock).toHaveBeenCalledWith('waiting');

    // 3. Switch to another match in the schedule window
    const otherMatch = schedule.matches.find((m) => m.matchId !== loadedView.focusMatchId)!;
    expect(otherMatch).toBeDefined();
    const otherView = await rehearsal.select(otherMatch.matchId);
    expect(otherView.selectedMatchId).toBe(otherMatch.matchId);
    expect(controller.getActiveBinding()?.manifest.match.matchId).toBe(otherMatch.matchId);

    // Cannot advance stages when not on focus match
    await expect(rehearsal.stage(1)).rejects.toThrow('请先加载焦点比赛，再选择示例阶段。');

    // 4. Switch back to focus match
    const backView = await rehearsal.select(loadedView.focusMatchId!);
    expect(backView.selectedMatchId).toBe(loadedView.focusMatchId);

    // 5. Stage 3 (Gameplay): produces replay telemetry from ancient-round-03
    observations.length = 0;
    const stage3View = await rehearsal.stage(3);
    expect(stage3View.stageIndex).toBe(3);
    expect(stage3View.stages[3]!.scene).toBe('gameplay');
    expect(forceSceneMock).toHaveBeenCalledWith('gameplay');
    expect(observations.length).toBe(1);
    const gameplayObs = observations[0]!;
    expect(gameplayObs.telemetry.map?.name).toBe('de_ancient');
    expect(gameplayObs.telemetry.allPlayers?.length).toBe(10);
    expect(gameplayObs.telemetry.bomb).toBeDefined();

    // 6. Stage 4 (Halftime): produces authentic halftime intermission observation
    observations.length = 0;
    const stage4View = await rehearsal.stage(4);
    expect(stage4View.stageIndex).toBe(4);
    expect(stage4View.stages[4]!.scene).toBe('halftime');
    expect(forceSceneMock).toHaveBeenCalledWith('halftime');
    expect(observations.length).toBe(1);
    const halftimeObs = observations[0]!;
    expect(halftimeObs.telemetry.map?.name).toBe('de_ancient');
    expect(halftimeObs.telemetry.map?.phase).toBe('intermission');
    expect(halftimeObs.telemetry.allPlayers?.length).toBe(10);

    // 7. Stop returns to idle
    const stoppedView = rehearsal.stop();
    expect(stoppedView.loaded).toBe(false);
    expect(stoppedView.selectedMatchId).toBeNull();
    expect(controller.getActiveBinding()).toBeUndefined();
  });

  it('exposes schedule and select endpoints over HTTP', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mizar-rehearsal-http-'));
    temporary.push(dir);

    const lkgStore = new MatchManifestLkgStore({ filePath: join(dir, 'lkg.json') });
    const controller = new MatchContextController({ lkgStore });
    const rehearsal = new RivalsRehearsal(fixturePath, controller);

    const app = Fastify();
    registerRivalsRehearsalRoutes(app, {
      rehearsal,
      originPolicy: { mode: 'loopback', bindHost: '127.0.0.1', allowedOrigins: [] },
    });

    await rehearsal.load();

    // GET /local/v1/rivals-rehearsal/schedule
    const scheduleRes = await app.inject({
      method: 'GET',
      url: '/local/v1/rivals-rehearsal/schedule',
    });
    expect(scheduleRes.statusCode).toBe(200);
    const scheduleData = JSON.parse(scheduleRes.body) as {
      matches: { matchId: string }[];
    };
    expect(scheduleData.matches.length).toBeGreaterThanOrEqual(3);

    // POST /operator/rivals-rehearsal/select
    const otherMatch = scheduleData.matches.find(
      (m) => m.matchId !== rehearsal.view().focusMatchId,
    )!;
    const selectRes = await app.inject({
      method: 'POST',
      url: '/operator/rivals-rehearsal/select',
      headers: { origin: 'http://127.0.0.1:4173' },
      payload: { matchId: otherMatch.matchId },
    });
    expect(selectRes.statusCode).toBe(200);
    const selectData = JSON.parse(selectRes.body) as { selectedMatchId: string };
    expect(selectData.selectedMatchId).toBe(otherMatch.matchId);
  });

  it('table-driven post-runtime verification: drives all 15 stages with real snapshots and scene controller without needs_operator', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mizar-rehearsal-series-'));
    temporary.push(dir);

    const lkgStore = new MatchManifestLkgStore({ filePath: join(dir, 'lkg.json') });
    const programRuntime = createProgramRuntime('test-rehearsal');
    const projectionCoordinator = createProjectionCoordinator({
      programRuntime,
      cstvSources: createCstvSourceManagers({}),
      nowMonotonicMs: () => performance.now(),
    });
    const matchController = new MatchContextController({
      lkgStore,
      onBindingChanged: (binding) => {
        projectionCoordinator.setMatchContextBinding(binding);
      },
    });

    const dispatchObservation = (
      obs: TelemetryObservation,
      sampleBinding?: { mapOrder: number },
    ) => {
      const result = programRuntime.acceptObservation(obs);
      if (sampleBinding) {
        programRuntime.executeOperatorCommand({
          kind: 'bind-current-map-execution-to-series-map',
          mapOrder: sampleBinding.mapOrder,
          reason: `Rivals 示例第 ${sampleBinding.mapOrder} 图执行绑定`,
        });
      }
      projectionCoordinator.afterRuntimeMutation(result);
    };

    const bpSession = {
      get: () => ({ projection: null, state: 'hidden' }),
    } as unknown as BpSession;
    const sceneController = new ProgramSceneController(projectionCoordinator, bpSession);

    const rehearsal = new RivalsRehearsal(
      fixturePath,
      matchController,
      sceneController,
      dispatchObservation,
      {
        activateFixtureSeriesProgress: (context) => {
          programRuntime.activateFixtureSeriesProgress(context);
          projectionCoordinator.refresh();
        },
        clearFixtureSeriesProgress: () => {
          programRuntime.clearFixtureSeriesProgress();
          projectionCoordinator.refresh();
        },
      },
    );

    await rehearsal.load();

    interface StageExpectation {
      readonly index: number;
      readonly label: string;
      readonly expectedScene: ProgramSceneId;
      readonly assert: (
        pSnap: ProgramProjection,
        opSnap: OperatorProjection,
        sceneActive: ProgramSceneId,
      ) => void;
    }

    const stageExpectations: StageExpectation[] = [
      {
        index: 0,
        label: '赛前等待',
        expectedScene: 'waiting',
        assert: (p, op, scene) => {
          expect(scene).toBe('waiting');
          expect(p.series?.status).toBe('planned');
          expect(p.series?.score).toEqual({ a: 0, b: 0 });
          expect(p.series?.bindingState).not.toBe('needs_operator');
          expect(op.matchContext.state).toBe('bound');
        },
      },
      {
        index: 1,
        label: '对阵',
        expectedScene: 'matchup',
        assert: (p, _op, scene) => {
          expect(scene).toBe('matchup');
          expect(p.series?.status).toBe('planned');
          expect(p.series?.score).toEqual({ a: 0, b: 0 });
          expect(p.series?.bindingState).not.toBe('needs_operator');
        },
      },
      {
        index: 2,
        label: 'BP',
        expectedScene: 'bp',
        assert: (p, _op, scene) => {
          expect(scene).toBe('bp');
          expect(p.series?.status).toBe('planned');
          expect(p.series?.bindingState).not.toBe('needs_operator');
        },
      },
      {
        index: 3,
        label: '第一图 · 比赛中',
        expectedScene: 'gameplay',
        assert: (p, op, scene) => {
          expect(scene).toBe('gameplay');
          expect(p.status.telemetry).toBe('fresh');
          expect(p.status.identity).toBe('degraded');
          expect(p.series?.bindingState).toBe('bound');
          expect(p.series?.bindingState).not.toBe('needs_operator');
          expect(p.series?.currentMapOrder).toBe(1);
          expect(op.seriesProgress?.bindingState).toBe('bound');
          expect(op.seriesProgress?.currentMapOrder).toBe(1);
        },
      },
      {
        index: 4,
        label: '第一图 · 半场',
        expectedScene: 'halftime',
        assert: (p, op, scene) => {
          expect(scene).toBe('halftime');
          expect(p.status.telemetry).toBe('fresh');
          expect(p.series?.bindingState).toBe('bound');
          expect(p.series?.bindingState).not.toBe('needs_operator');
          expect(p.series?.currentMapOrder).toBe(1);
          expect(op.seriesProgress?.currentMapOrder).toBe(1);
          expect(p.map.phase).toBe('intermission');
        },
      },
      {
        index: 5,
        label: '第一图 · 结果',
        expectedScene: 'map_result',
        assert: (p, op, scene) => {
          expect(scene).toBe('map_result');
          expect(p.series?.bindingState).not.toBe('needs_operator');
          expect(op.seriesProgress?.bindingState).not.toBe('needs_operator');
          expect(p.series?.maps[0]?.status).toBe('completed');
          expect(p.series?.maps[0]?.finalScore).toEqual({ a: 8, b: 13 });
          expect(p.series?.score).toEqual({ a: 0, b: 1 });
        },
      },
      {
        index: 6,
        label: '图间 · 第二图',
        expectedScene: 'intermap',
        assert: (p, op, scene) => {
          expect(scene).toBe('intermap');
          expect(p.series?.score).toEqual({ a: 0, b: 1 });
          expect(p.series?.bindingState).not.toBe('needs_operator');
          expect(op.seriesProgress?.bindingState).not.toBe('needs_operator');
        },
      },
      {
        index: 7,
        label: '第二图 · 比赛中',
        expectedScene: 'gameplay',
        assert: (p, op, scene) => {
          expect(scene).toBe('gameplay');
          expect(p.status.telemetry).toBe('fresh');
          expect(p.status.identity).toBe('degraded');
          expect(p.series?.bindingState).toBe('bound');
          expect(p.series?.bindingState).not.toBe('needs_operator');
          expect(p.series?.currentMapOrder).toBe(2);
          expect(op.seriesProgress?.bindingState).toBe('bound');
          expect(op.seriesProgress?.currentMapOrder).toBe(2);
        },
      },
      {
        index: 8,
        label: '第二图 · 半场',
        expectedScene: 'halftime',
        assert: (p, op, scene) => {
          expect(scene).toBe('halftime');
          expect(p.status.telemetry).toBe('fresh');
          expect(p.series?.bindingState).toBe('bound');
          expect(p.series?.bindingState).not.toBe('needs_operator');
          expect(p.series?.currentMapOrder).toBe(2);
          expect(op.seriesProgress?.currentMapOrder).toBe(2);
          expect(p.map.phase).toBe('intermission');
        },
      },
      {
        index: 9,
        label: '第二图 · 结果',
        expectedScene: 'map_result',
        assert: (p, op, scene) => {
          expect(scene).toBe('map_result');
          expect(p.series?.bindingState).not.toBe('needs_operator');
          expect(op.seriesProgress?.bindingState).not.toBe('needs_operator');
          expect(p.series?.maps[0]?.status).toBe('completed');
          expect(p.series?.maps[1]?.status).toBe('completed');
          expect(p.series?.maps[1]?.finalScore).toEqual({ a: 13, b: 10 });
          expect(p.series?.score).toEqual({ a: 1, b: 1 });
        },
      },
      {
        index: 10,
        label: '图间 · 决胜图',
        expectedScene: 'intermap',
        assert: (p, op, scene) => {
          expect(scene).toBe('intermap');
          expect(p.series?.score).toEqual({ a: 1, b: 1 });
          expect(p.series?.bindingState).not.toBe('needs_operator');
          expect(op.seriesProgress?.bindingState).not.toBe('needs_operator');
        },
      },
      {
        index: 11,
        label: '决胜图 · 比赛中',
        expectedScene: 'gameplay',
        assert: (p, op, scene) => {
          expect(scene).toBe('gameplay');
          expect(p.status.telemetry).toBe('fresh');
          expect(p.status.identity).toBe('degraded');
          expect(p.series?.bindingState).toBe('bound');
          expect(p.series?.bindingState).not.toBe('needs_operator');
          expect(p.series?.currentMapOrder).toBe(3);
          expect(op.seriesProgress?.bindingState).toBe('bound');
          expect(op.seriesProgress?.currentMapOrder).toBe(3);
        },
      },
      {
        index: 12,
        label: '决胜图 · 半场',
        expectedScene: 'halftime',
        assert: (p, op, scene) => {
          expect(scene).toBe('halftime');
          expect(p.status.telemetry).toBe('fresh');
          expect(p.series?.bindingState).toBe('bound');
          expect(p.series?.bindingState).not.toBe('needs_operator');
          expect(p.series?.currentMapOrder).toBe(3);
          expect(op.seriesProgress?.currentMapOrder).toBe(3);
          expect(p.map.phase).toBe('intermission');
        },
      },
      {
        index: 13,
        label: '决胜图 · 结果',
        expectedScene: 'map_result',
        assert: (p, op, scene) => {
          expect(scene).toBe('map_result');
          expect(p.series?.bindingState).not.toBe('needs_operator');
          expect(op.seriesProgress?.bindingState).not.toBe('needs_operator');
          expect(p.series?.maps[2]?.status).toBe('completed');
          expect(p.series?.maps[2]?.finalScore).toEqual({ a: 13, b: 11 });
          expect(p.series?.score).toEqual({ a: 2, b: 1 });
        },
      },
      {
        index: 14,
        label: '整场结果',
        expectedScene: 'match_result',
        assert: (p, op, scene) => {
          expect(scene).toBe('match_result');
          expect(p.series?.status).toBe('completed');
          expect(p.series?.score).toEqual({ a: 2, b: 1 });
          expect(p.series?.bindingState).not.toBe('needs_operator');
          expect(op.seriesProgress?.bindingState).not.toBe('needs_operator');
        },
      },
    ];

    for (const expected of stageExpectations) {
      await rehearsal.stage(expected.index);
      const pSnap = projectionCoordinator.getCurrent().program;
      const opSnap = projectionCoordinator.getCurrent().operator;
      const activeScene = sceneController.get().active;

      const issues = opSnap.seriesProgress?.issues ?? [];

      // Invariants:
      // 1. Series must never enter needs_operator at any stage
      expect(pSnap.series?.bindingState).not.toBe('needs_operator');
      expect(opSnap.seriesProgress?.bindingState).not.toBe('needs_operator');

      // 2. No operator bind is ever rejected
      expect(issues.map((i) => i.code)).not.toContain('operator_bind_rejected');

      // 3. No map mismatch at any stage
      expect(issues.map((i) => i.code)).not.toContain('map_mismatch');

      // 4. Non-gameplay stages (pre-match, results, intermap) must never have map_order_exception
      if ([0, 1, 2, 5, 6, 9, 10, 13, 14].includes(expected.index)) {
        expect(issues.map((i) => i.code)).not.toContain('map_order_exception');
      }

      expected.assert(pSnap, opSnap, activeScene);
    }
  });

  it('cleans up all fixture series state, telemetry suppression, and sample binding on stop() and avoids leaking to real matches', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mizar-rehearsal-lifecycle-'));
    temporary.push(dir);

    const lkgStore = new MatchManifestLkgStore({ filePath: join(dir, 'lkg.json') });
    const programRuntime = createProgramRuntime('test-lifecycle');
    const projectionCoordinator = createProjectionCoordinator({
      programRuntime,
      cstvSources: createCstvSourceManagers({}),
      nowMonotonicMs: () => performance.now(),
    });
    const matchController = new MatchContextController({
      lkgStore,
      onBindingChanged: (binding) => {
        projectionCoordinator.setMatchContextBinding(binding);
      },
    });

    const dispatchObservation = (
      obs: TelemetryObservation,
      sampleBinding?: { mapOrder: number },
    ) => {
      const result = programRuntime.acceptObservation(obs);
      if (sampleBinding) {
        programRuntime.executeOperatorCommand({
          kind: 'bind-current-map-execution-to-series-map',
          mapOrder: sampleBinding.mapOrder,
          reason: `Rivals 示例第 ${sampleBinding.mapOrder} 图执行绑定`,
        });
      }
      projectionCoordinator.afterRuntimeMutation(result);
    };

    const bpSession = {
      get: () => ({ projection: null, state: 'hidden' }),
    } as unknown as BpSession;
    const sceneController = new ProgramSceneController(projectionCoordinator, bpSession);

    const rehearsal = new RivalsRehearsal(
      fixturePath,
      matchController,
      sceneController,
      dispatchObservation,
      {
        activateFixtureSeriesProgress: (context) => {
          programRuntime.activateFixtureSeriesProgress(context);
          projectionCoordinator.refresh();
        },
        clearFixtureSeriesProgress: () => {
          programRuntime.clearFixtureSeriesProgress();
          projectionCoordinator.refresh();
        },
      },
    );

    // 1. Load Rivals sample and progress to Map Result (Stage 5)
    await rehearsal.load();
    await rehearsal.stage(3);
    await rehearsal.stage(5);
    expect(projectionCoordinator.getCurrent().program.series?.score).toEqual({ a: 0, b: 1 });
    expect(matchController.getActiveBinding()?.origin).toBe('fixture');

    // 2. Stop rehearsal
    rehearsal.stop();
    expect(matchController.getActiveBinding()).toBeUndefined();
    expect(programRuntime.getSeriesProgress()).toBeNull();
    expect(sceneController.get().active).toBe('waiting');

    // 3. Activate normal online MatchContext (even with the exact same focus matchId)
    const rawFixture = JSON.parse(await readFile(fixturePath, 'utf8')) as {
      focusMatchId: string;
      manifests: Record<string, BroadcastManifest>;
    };
    // Create an unstarted online match manifest with the same matchId to test production progression
    const baseManifest = rawFixture.manifests[rawFixture.focusMatchId]!;
    const onlineManifest: BroadcastManifest = {
      ...baseManifest,
      match: {
        ...baseManifest.match,
        status: 'scheduled',
      },
      maps: baseManifest.maps.map((m) => ({
        ...m,
        scoreA: null,
        scoreB: null,
        completedAt: null,
      })),
    };

    const selectResult = await matchController.selectMatch(rawFixture.focusMatchId, {
      kind: 'online',
      load: () => Promise.resolve(onlineManifest),
    });
    expect(selectResult.ok).toBe(true);
    expect(matchController.getActiveBinding()?.origin).toBe('online');

    // 4. Production synchronizeSeriesProgress creates fresh production SeriesProgress
    const freshContext = toMatchContext(onlineManifest);
    const prodSeries = programRuntime.synchronizeSeriesProgress(freshContext, null);
    expect(prodSeries).toBeDefined();
    // Maps in focus match fixture are pending before played in production:
    expect(prodSeries?.maps[0]?.status).toBe('pending');
    expect(prodSeries?.score).toEqual({ a: 0, b: 0 });

    // 5. Normal production telemetry observation advances Map 1 without sample binding
    const liveObs: TelemetryObservation = {
      receive: {
        sequence: 1000,
        receivedAt: new Date().toISOString(),
        receivedMonotonicMs: performance.now(),
      },
      source: { kind: 'cs2-gsi' },
      coverage: {
        provider: 'present',
        map: 'present',
        round: 'present',
        phaseCountdowns: 'absent',
        player: 'absent',
        allPlayers: 'absent',
        bomb: 'absent',
        grenades: 'absent',
      },
      telemetry: {
        map: {
          name: 'de_dust2',
          phase: 'live',
          roundNumber: 1,
          sides: { ct: { score: 1 }, t: { score: 0 } },
        },
        round: { phase: 'live' },
      },
    };

    const res = programRuntime.acceptObservation(liveObs);
    const bundle = projectionCoordinator.afterRuntimeMutation(res);
    expect(bundle.program.status.telemetry).toBe('fresh');
    expect(bundle.program.series?.currentMapOrder).toBe(1);
    expect(bundle.program.series?.bindingState).toBe('bound');
    expect(bundle.program.series?.maps[0]?.status).toBe('current');
    expect(bundle.program.series?.score).toEqual({ a: 0, b: 0 });
  });
});

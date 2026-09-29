import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import type { TelemetryObservation } from '@mizar/core/telemetry';
import { MatchContextController, MatchManifestLkgStore } from '../src/match-context/index.js';
import {
  RivalsRehearsal,
  registerRivalsRehearsalRoutes,
} from '../src/match-context/rivals-rehearsal.js';
import type { ProgramSceneController } from '../src/program-scenes/controller.js';
import { createProgramRuntime } from '../src/runtime/program-runtime.js';
import { createProjectionCoordinator } from '../src/projections/projection-coordinator.js';
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

  it('establishes execution binding per stage and preserves series state across all 15 stages without needs_operator', async () => {
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

    const forceSceneMock = vi.fn();
    const sceneController = {
      forceScene: forceSceneMock,
    } as unknown as ProgramSceneController;

    const rehearsal = new RivalsRehearsal(
      fixturePath,
      matchController,
      sceneController,
      dispatchObservation,
    );

    await rehearsal.load();

    // Stage 0: 赛前等待 (waiting)
    await rehearsal.stage(0);
    let pSnap = projectionCoordinator.getCurrent().program;
    let opSnap = projectionCoordinator.getCurrent().operator;
    expect(pSnap.series?.status).toBe('planned');
    expect(opSnap.matchContext.state).toBe('bound');

    // Stage 1: 对阵 (matchup)
    await rehearsal.stage(1);
    expect(forceSceneMock).toHaveBeenCalledWith('matchup');

    // Stage 2: BP (bp)
    await rehearsal.stage(2);
    expect(forceSceneMock).toHaveBeenCalledWith('bp');

    // Stage 3: 第一图 · 比赛中 (gameplay) -> Map 1
    await rehearsal.stage(3);
    pSnap = projectionCoordinator.getCurrent().program;
    opSnap = projectionCoordinator.getCurrent().operator;
    expect(pSnap.status.telemetry).toBe('fresh');
    expect(pSnap.status.identity).toBe('degraded');
    expect(pSnap.series?.bindingState).toBe('bound');
    expect(pSnap.series?.bindingState).not.toBe('needs_operator');
    expect(pSnap.series?.currentMapOrder).toBe(1);
    expect(opSnap.seriesProgress?.bindingState).toBe('bound');
    expect(opSnap.seriesProgress?.currentMapOrder).toBe(1);

    // Stage 4: 第一图 · 半场 (halftime) -> Map 1
    await rehearsal.stage(4);
    pSnap = projectionCoordinator.getCurrent().program;
    opSnap = projectionCoordinator.getCurrent().operator;
    expect(pSnap.status.telemetry).toBe('fresh');
    expect(opSnap.seriesProgress?.currentMapOrder).toBe(1);
    expect(pSnap.series?.bindingState).toBe('bound');
    expect(pSnap.series?.bindingState).not.toBe('needs_operator');
    expect(pSnap.series?.currentMapOrder).toBe(1);
    expect(pSnap.map.phase).toBe('intermission');

    // Stage 5: 第一图 · 结果 (map_result) -> Rivals production-derived score (8 : 13)
    await rehearsal.stage(5);
    pSnap = projectionCoordinator.getCurrent().program;
    expect(pSnap.series?.maps[0]?.status).toBe('completed');
    expect(pSnap.series?.maps[0]?.finalScore).toEqual({ a: 8, b: 13 });

    // Stage 6: 图间 · 第二图 (intermap)
    await rehearsal.stage(6);
    expect(forceSceneMock).toHaveBeenCalledWith('intermap');

    // Stage 7: 第二图 · 比赛中 (gameplay) -> Map 2
    await rehearsal.stage(7);
    pSnap = projectionCoordinator.getCurrent().program;
    opSnap = projectionCoordinator.getCurrent().operator;
    expect(pSnap.status.telemetry).toBe('fresh');
    expect(pSnap.status.identity).toBe('degraded');
    expect(pSnap.series?.bindingState).toBe('bound');
    expect(pSnap.series?.bindingState).not.toBe('needs_operator');
    expect(pSnap.series?.currentMapOrder).toBe(2);
    expect(opSnap.seriesProgress?.bindingState).toBe('bound');
    expect(opSnap.seriesProgress?.currentMapOrder).toBe(2);

    // Stage 8: 第二图 · 半场 (halftime) -> Map 2
    await rehearsal.stage(8);
    pSnap = projectionCoordinator.getCurrent().program;
    expect(pSnap.status.telemetry).toBe('fresh');
    expect(pSnap.series?.bindingState).toBe('bound');
    expect(pSnap.series?.bindingState).not.toBe('needs_operator');
    expect(pSnap.series?.currentMapOrder).toBe(2);
    expect(pSnap.map.phase).toBe('intermission');

    // Stage 9: 第二图 · 结果 (map_result) -> Rivals production-derived score (13 : 10)
    await rehearsal.stage(9);
    pSnap = projectionCoordinator.getCurrent().program;
    expect(pSnap.series?.maps[1]?.status).toBe('completed');
    expect(pSnap.series?.maps[1]?.finalScore).toEqual({ a: 13, b: 10 });

    // Stage 10: 图间 · 决胜图 (intermap)
    await rehearsal.stage(10);
    expect(forceSceneMock).toHaveBeenCalledWith('intermap');

    // Stage 11: 决胜图 · 比赛中 (gameplay) -> Map 3
    await rehearsal.stage(11);
    pSnap = projectionCoordinator.getCurrent().program;
    opSnap = projectionCoordinator.getCurrent().operator;
    expect(pSnap.status.telemetry).toBe('fresh');
    expect(pSnap.status.identity).toBe('degraded');
    expect(pSnap.series?.bindingState).toBe('bound');
    expect(pSnap.series?.bindingState).not.toBe('needs_operator');
    expect(pSnap.series?.currentMapOrder).toBe(3);
    expect(opSnap.seriesProgress?.bindingState).toBe('bound');
    expect(opSnap.seriesProgress?.currentMapOrder).toBe(3);

    // Stage 12: 决胜图 · 半场 (halftime) -> Map 3
    await rehearsal.stage(12);
    pSnap = projectionCoordinator.getCurrent().program;
    expect(pSnap.status.telemetry).toBe('fresh');
    expect(pSnap.series?.bindingState).toBe('bound');
    expect(pSnap.series?.bindingState).not.toBe('needs_operator');
    expect(pSnap.series?.currentMapOrder).toBe(3);
    expect(pSnap.map.phase).toBe('intermission');

    // Stage 13: 决胜图 · 结果 (map_result) -> Rivals production-derived score (13 : 11)
    await rehearsal.stage(13);
    pSnap = projectionCoordinator.getCurrent().program;
    expect(pSnap.series?.maps[2]?.status).toBe('completed');
    expect(pSnap.series?.maps[2]?.finalScore).toEqual({ a: 13, b: 11 });

    // Stage 14: 整场结果 (match_result) -> Rivals production-derived series score (2 : 1)
    await rehearsal.stage(14);
    pSnap = projectionCoordinator.getCurrent().program;
    expect(pSnap.series?.status).toBe('completed');
    expect(pSnap.series?.score).toEqual({ a: 2, b: 1 });
  });
});

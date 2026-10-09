import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import type { TelemetryObservation } from '@mizar/core/telemetry';
import { MatchContextController, MatchManifestLkgStore } from '../src/match-context/index.js';
import {
  RivalsRehearsal,
  registerRivalsRehearsalRoutes,
} from '../src/match-context/rivals-rehearsal.js';
import { ProgramSceneController } from '../src/program-scenes/controller.js';
import type { BpSession } from '../src/bp/controller.js';
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
    await expect(rehearsal.stage(1)).rejects.toThrow('请先加载焦点比赛');
    await app.close();
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

    const stageExpectations = [
      ['waiting', 'planned', 0, 0, null],
      ['matchup', 'planned', 0, 0, null],
      ['bp', 'planned', 0, 0, null],
      ['gameplay', 'live', 0, 0, 1],
      ['halftime', 'live', 0, 0, 1],
      ['map_result', 'live', 0, 1, 1],
      ['intermap', 'live', 0, 1, 1],
      ['gameplay', 'live', 0, 1, 2],
      ['halftime', 'live', 0, 1, 2],
      ['map_result', 'live', 1, 1, 2],
      ['intermap', 'live', 1, 1, 2],
      ['gameplay', 'live', 1, 1, 3],
      ['halftime', 'live', 1, 1, 3],
      ['map_result', 'completed', 2, 1, null],
      ['match_result', 'completed', 2, 1, null],
    ] as const;

    for (const [index, [scene, status, a, b, mapOrder]] of stageExpectations.entries()) {
      await rehearsal.stage(index);
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
      if ([0, 1, 2, 5, 6, 9, 10, 13, 14].includes(index)) {
        expect(issues.map((i) => i.code)).not.toContain('map_order_exception');
      }

      expect(activeScene).toBe(scene);
      expect(pSnap.series?.status).toBe(status);
      expect(pSnap.series?.score).toEqual({ a, b });
      if (scene === 'gameplay' || scene === 'halftime') {
        expect(pSnap.status.telemetry).toBe('fresh');
        expect(pSnap.series?.currentMapOrder).toBe(mapOrder);
        expect(opSnap.seriesProgress?.currentMapOrder).toBe(mapOrder);
      }
      if (scene === 'halftime') expect(pSnap.map.phase).toBe('intermission');
      if (scene === 'map_result') {
        const order = index === 5 ? 1 : index === 9 ? 2 : 3;
        expect(pSnap.series?.maps[order - 1]).toMatchObject({
          status: 'completed',
          finalScore: [
            { a: 8, b: 13 },
            { a: 13, b: 10 },
            { a: 13, b: 11 },
          ][order - 1],
        });
      }
    }
  });
});

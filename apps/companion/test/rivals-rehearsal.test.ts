import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import type { TelemetryObservation } from '@mizar/core/telemetry';
import {
  MatchContextController,
  MatchManifestLkgStore,
} from '../src/match-context/index.js';
import {
  RivalsRehearsal,
  registerRivalsRehearsalRoutes,
} from '../src/match-context/rivals-rehearsal.js';

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
    const sceneController = {
      forceScene: vi.fn(),
    } as any;
    const observations: TelemetryObservation[] = [];
    const onObservation = (obs: TelemetryObservation) => {
      observations.push(obs);
    };

    const rehearsal = new RivalsRehearsal(
      fixturePath,
      controller,
      sceneController,
      onObservation,
    );

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
    expect(sceneController.forceScene).toHaveBeenCalledWith('waiting');

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
    expect(sceneController.forceScene).toHaveBeenCalledWith('gameplay');
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
    expect(sceneController.forceScene).toHaveBeenCalledWith('halftime');
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
    const scheduleData = JSON.parse(scheduleRes.body);
    expect(scheduleData.matches.length).toBeGreaterThanOrEqual(3);

    // POST /operator/rivals-rehearsal/select
    const otherMatch = scheduleData.matches.find((m: any) => m.matchId !== rehearsal.view().focusMatchId);
    const selectRes = await app.inject({
      method: 'POST',
      url: '/operator/rivals-rehearsal/select',
      headers: { origin: 'http://127.0.0.1:4173' },
      payload: { matchId: otherMatch.matchId },
    });
    expect(selectRes.statusCode).toBe(200);
    const selectData = JSON.parse(selectRes.body);
    expect(selectData.selectedMatchId).toBe(otherMatch.matchId);
  });
});

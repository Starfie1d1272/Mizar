import { expect, it, vi } from 'vitest';
import type { ProgramSceneId } from '@mizar/protocol/program-scenes';
import type { ProjectionCoordinator } from '../src/projections/projection-coordinator.js';
import { BpSession } from '../src/bp/controller.js';
import { ProgramSceneController } from '../src/program-scenes/controller.js';
import type { ObsSceneSwitchOptions } from '../src/obs/reconcile.js';

function controller(
  switchObs: (id: ProgramSceneId, options?: ObsSceneSwitchOptions) => Promise<void>,
) {
  const operator = {
    runtime: { telemetryFreshness: 'fresh' },
    matchContext: { freshness: 'fresh' },
    identity: { state: 'matched' },
  };
  const program = {
    series: { bindingState: 'bound', status: 'live', maps: [] },
    map: { phase: 'live', score: { ct: 0, t: 0 } },
  };
  const projections = {
    getCurrent: () => ({ operator, program }),
    getBpAssessment: () => ({ readiness: 'missing' }),
  } as unknown as ProjectionCoordinator;
  const bp = { get: () => ({ projection: null, state: 'hidden' }) } as unknown as BpSession;
  return {
    scene: new ProgramSceneController(projections, bp, switchObs),
    operator,
    program,
    projections,
  };
}

it('rechecks live truth after an OBS switch and restores the previous scene when it became stale', async () => {
  const switched: ProgramSceneId[] = [];
  const { scene, operator } = controller((id) => {
    switched.push(id);
    if (id === 'gameplay') operator.runtime.telemetryFreshness = 'stale';
    return Promise.resolve();
  });
  const result = await scene.select('gameplay', scene.get().revision);
  expect(result.ok).toBe(false);
  expect(scene.get().active).toBe('waiting');
  expect(switched).toEqual(['gameplay', 'waiting']);
});

it('真实比赛不会绕过 Program safety gate', async () => {
  const switchObs = vi.fn<(id: ProgramSceneId) => Promise<void>>().mockResolvedValue(undefined);
  const { scene, operator, program } = controller(switchObs);
  // Real match context origin is online or local (never 'fixture')
  // @ts-expect-error test assignment
  operator.matchContext.origin = 'online';

  // 1. When telemetry is stale, gameplay is blocked
  operator.runtime.telemetryFreshness = 'stale';
  expect(scene.get().blocked.gameplay).toBe('比赛数据未就绪，当前播出场景保持不变。');
  const res1 = await scene.select('gameplay', scene.get().revision);
  expect(res1.ok).toBe(false);

  // 2. When telemetry is fresh but phase is not intermission, halftime is blocked
  operator.runtime.telemetryFreshness = 'fresh';
  program.map.phase = 'live';
  expect(scene.get().available).toContain('halftime');
  const res2 = await scene.selectAutomatic('halftime', scene.get().revision, () => true);
  expect(res2.ok).toBe(false);

  // 3. When identity is mismatch, non-waiting scenes are blocked
  operator.identity.state = 'mismatch';
  expect(scene.get().blocked.matchup).toBe('当前游戏选手与所选比赛不一致，请切换比赛或核对名单。');
  const res3 = await scene.select('matchup', scene.get().revision);
  expect(res3.ok).toBe(false);

  // 4. When series is not completed, match_result is blocked
  operator.identity.state = 'matched';
  program.series.status = 'live';
  expect(scene.get().available).toContain('match_result');
  const res4 = await scene.selectAutomatic('match_result', scene.get().revision, () => true);
  expect(res4.ok).toBe(false);

  // 5. When series is not bound, bound scenes are blocked
  program.series.bindingState = 'unbound';
  expect(scene.get().blocked.matchup).toBe(
    '当前游戏尚未对应到比赛地图，请在比赛资料中核对地图和双方名单。',
  );
  const res5 = await scene.select('matchup', scene.get().revision);
  expect(res5.ok).toBe(false);
});

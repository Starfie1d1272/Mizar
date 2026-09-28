import { expect, it, vi } from 'vitest';
import type { ProgramSceneId } from '@mizar/protocol/program-scenes';
import type { ProjectionCoordinator } from '../src/projections/projection-coordinator.js';
import type { BpSession } from '../src/bp/controller.js';
import { ProgramSceneController } from '../src/program-scenes/controller.js';

function controller(switchObs: (id: ProgramSceneId) => Promise<void>) {
  const operator = {
    runtime: { telemetryFreshness: 'fresh' },
    matchContext: { freshness: 'fresh' },
    identity: { state: 'matched' },
  };
  const program = {
    series: { bindingState: 'bound', status: 'live', maps: [] },
    map: { phase: 'live' },
  };
  const projections = {
    getCurrent: () => ({ operator, program }),
    getBpAssessment: () => ({ readiness: 'missing' }),
  } as unknown as ProjectionCoordinator;
  const bp = { get: () => ({ projection: null, state: 'hidden' }) } as unknown as BpSession;
  return { scene: new ProgramSceneController(projections, bp, switchObs), operator, program };
}

it('keeps the current Program Scene when identity, freshness or OBS switch fails', async () => {
  const switchObs = vi.fn<(id: ProgramSceneId) => Promise<void>>().mockResolvedValue(undefined);
  const { scene, operator } = controller(switchObs);
  expect(scene.get().active).toBe('waiting');
  expect(scene.get().available).toContain('gameplay');
  const first = await scene.select('gameplay', scene.get().revision);
  expect(first.ok).toBe(true);
  expect(scene.get().active).toBe('gameplay');
  expect(switchObs).toHaveBeenCalledWith('gameplay');

  operator.identity.state = 'mismatch';
  const mismatch = await scene.select('matchup', scene.get().revision);
  expect(mismatch.ok).toBe(false);
  expect(scene.get().active).toBe('gameplay');
  expect(switchObs).toHaveBeenCalledTimes(1);

  operator.identity.state = 'matched';
  operator.runtime.telemetryFreshness = 'stale';
  const stale = await scene.select('halftime', scene.get().revision);
  expect(stale.ok).toBe(false);
  operator.runtime.telemetryFreshness = 'fresh';
  switchObs.mockRejectedValueOnce(new Error('OBS disconnected'));
  const failed = await scene.select('matchup', scene.get().revision);
  expect(failed.ok).toBe(false);
  expect(scene.get().active).toBe('gameplay');

  const wrongRevision = await scene.select('waiting', 'old-revision');
  expect(wrongRevision.ok).toBe(false);
  expect(scene.get().active).toBe('gameplay');
});

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
  expect(scene.get().blocked.halftime).toBe('尚无可信的半场阶段信息。');
  const res2 = await scene.select('halftime', scene.get().revision);
  expect(res2.ok).toBe(false);

  // 3. When identity is mismatch, non-waiting scenes are blocked
  operator.identity.state = 'mismatch';
  expect(scene.get().blocked.matchup).toBe('比赛绑定、地图归属或选手识别尚未确认。');
  const res3 = await scene.select('matchup', scene.get().revision);
  expect(res3.ok).toBe(false);

  // 4. When series is not completed, match_result is blocked
  operator.identity.state = 'matched';
  program.series.status = 'live';
  expect(scene.get().blocked.match_result).toBe('整场结果尚未确认。');
  const res4 = await scene.select('match_result', scene.get().revision);
  expect(res4.ok).toBe(false);

  // 5. When series is not bound, bound scenes are blocked
  program.series.bindingState = 'unbound';
  expect(scene.get().blocked.matchup).toBe('比赛绑定、地图归属或选手识别尚未确认。');
  const res5 = await scene.select('matchup', scene.get().revision);
  expect(res5.ok).toBe(false);
});

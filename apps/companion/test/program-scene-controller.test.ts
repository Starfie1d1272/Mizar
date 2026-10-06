import { expect, it, vi } from 'vitest';
import type { ProgramSceneId } from '@mizar/protocol/program-scenes';
import type { ProjectionCoordinator } from '../src/projections/projection-coordinator.js';
import { BpSession } from '../src/bp/controller.js';
import { ProgramSceneController } from '../src/program-scenes/controller.js';

function controller(switchObs: (id: ProgramSceneId) => Promise<void>) {
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
it('lets manual summaries review confirmed history without requiring the current demo identity', async () => {
  const { scene, operator, program } = controller(async () => {});
  operator.runtime.telemetryFreshness = 'stale';
  operator.identity.state = 'mismatch';
  program.series.bindingState = 'unbound';
  Object.assign(program.series, { maps: [{ status: 'completed', finalScore: { a: 13, b: 5 } }] });
  expect((await scene.select('map_result', scene.get().revision)).ok).toBe(true);
  expect((await scene.selectAutomatic('map_result', scene.get().revision, () => true)).ok).toBe(
    false,
  );
  operator.matchContext.freshness = 'missing';
  expect(scene.get().available).not.toContain('map_result');
});

it('keeps the current Program Scene when identity, freshness or OBS switch fails', async () => {
  const switchObs = vi.fn<(id: ProgramSceneId) => Promise<void>>().mockResolvedValue(undefined);
  const { scene, operator } = controller(switchObs);
  expect(scene.get().active).toBe('waiting');
  expect(scene.get().available).toContain('gameplay');
  const first = await scene.select('gameplay', scene.get().revision);
  expect(first.ok).toBe(true);
  expect(scene.get().active).toBe('gameplay');
  expect(switchObs).toHaveBeenCalledWith(
    'gameplay',
    expect.objectContaining({
      transition: { kind: 'cut', durationMs: 0 },
    }),
  );

  operator.identity.state = 'mismatch';
  const mismatch = await scene.select('matchup', scene.get().revision);
  expect(mismatch.ok).toBe(false);
  expect(scene.get().active).toBe('gameplay');
  expect(switchObs).toHaveBeenCalledTimes(1);

  operator.identity.state = 'matched';
  operator.runtime.telemetryFreshness = 'stale';
  const stale = await scene.selectAutomatic('halftime', scene.get().revision, () => true);
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

it('allows a fresh demo Gameplay Take without event binding while retaining result gates', async () => {
  const { scene, operator, program } = controller(async () => {});
  operator.matchContext.freshness = 'missing';
  operator.identity.state = 'mismatch';
  program.series.bindingState = 'unbound';
  expect(scene.get().available).toContain('gameplay');
  expect(await scene.select('gameplay', scene.get().revision)).toMatchObject({ ok: true });
  expect(scene.get().available).not.toContain('map_result');
  expect(scene.get().available).not.toContain('matchup');
  operator.runtime.telemetryFreshness = 'stale';
  expect(scene.get().available).not.toContain('gameplay');
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

it('retains the BP board until its crossfade is confirmed, then clears it without another exit', async () => {
  const { program } = controller(async () => {});
  let release!: () => void;
  const finishSceneExit = vi.fn();
  const bp = {
    get: () => ({ state: 'shown', projection: {}, revision: 'bp' }),
    finishSceneExit,
  } as unknown as BpSession;
  const projections = {
    getCurrent: () => ({
      program,
      operator: {
        runtime: { telemetryFreshness: 'fresh' },
        matchContext: { freshness: 'fresh' },
        identity: { state: 'matched' },
      },
    }),
    getBpAssessment: () => ({ readiness: 'ready' }),
  } as unknown as ProjectionCoordinator;
  const switchObs = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  const scenes = new ProgramSceneController(projections, bp, switchObs);
  scenes.forceScene('bp');
  const taking = scenes.selectAutomatic('waiting', scenes.get().revision, () => true);
  await Promise.resolve();
  expect(scenes.get().active).toBe('bp');
  expect(finishSceneExit).not.toHaveBeenCalled();
  expect(scenes.get().preparing?.target).toBe('waiting');
  expect(switchObs).toHaveBeenCalledWith(
    'waiting',
    expect.objectContaining({ transition: { kind: 'fade', durationMs: 300 } }),
  );
  release();
  expect((await taking).ok).toBe(true);
  expect(finishSceneExit).toHaveBeenCalledOnce();
  expect(scenes.get().active).toBe('waiting');
  expect(scenes.get().preparing).toBeUndefined();
});

it('manual Take interrupts the automatic fade wait and immediately requests Cut', async () => {
  const calls: { id: ProgramSceneId; kind: string }[] = [];
  const { projections } = controller(async () => {});
  const scenes = new ProgramSceneController(
    projections,
    new BpSession(() => null),
    async (id, options) => {
      calls.push({ id, kind: options.transition.kind });
      if (options.transition.kind === 'fade')
        await new Promise<void>((resolve) =>
          options.signal!.addEventListener('abort', () => resolve(), { once: true }),
        );
    },
  );
  const automatic = scenes.selectAutomatic('matchup', scenes.get().revision, () => true);
  await Promise.resolve();
  const manual = scenes.select('gameplay', scenes.get().revision);
  expect((await automatic).ok).toBe(false);
  expect((await manual).ok).toBe(true);
  expect(calls.at(-1)).toEqual({ id: 'gameplay', kind: 'cut' });
  expect(scenes.get().active).toBe('gameplay');
});

it.each([
  { phase: 'freezetime', remaining: 5, from: 'halftime' as const, kind: 'fade', durationMs: 150 },
  { phase: 'freezetime', remaining: 0.5, from: 'halftime' as const, kind: 'cut', durationMs: 0 },
  { phase: 'live', remaining: 0, from: 'halftime' as const, kind: 'cut', durationMs: 0 },
  { phase: 'freezetime', remaining: 20, from: 'matchup' as const, kind: 'cut', durationMs: 0 },
])(
  'protects gameplay deadline and the existing intro handoff: $from / $phase / $remaining',
  async ({ phase, remaining, from, kind, durationMs }) => {
    const switchObs = vi.fn<(id: ProgramSceneId) => Promise<void>>().mockResolvedValue(undefined);
    const { scene, program } = controller(switchObs);
    Object.assign(program, { round: { phase }, clock: { phase, endsInSeconds: remaining } });
    scene.forceScene(from);
    expect((await scene.selectAutomatic('gameplay', scene.get().revision, () => true)).ok).toBe(
      true,
    );
    expect(switchObs).toHaveBeenCalledWith(
      'gameplay',
      expect.objectContaining({ transition: { kind, durationMs } }),
    );
  },
);

it('keeps preparation revision through commit and drops it when the context invalidates', async () => {
  let release!: () => void;
  const switchObs = vi
    .fn<(id: ProgramSceneId) => Promise<void>>()
    .mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    )
    .mockResolvedValue(undefined);
  const { scene, operator } = controller(switchObs);
  const request = scene.selectAutomatic('matchup', scene.get().revision, () => true);
  await Promise.resolve();
  const preparing = scene.get().preparing;
  expect(preparing?.target).toBe('matchup');
  release();
  await request;
  expect(scene.get().revision).toBe(preparing?.revision);
  expect(scene.get().preparing).toBeUndefined();

  scene.forceScene('waiting');
  switchObs.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  const stale = scene.selectAutomatic('matchup', scene.get().revision, () => true);
  await Promise.resolve();
  operator.identity.state = 'mismatch';
  release();
  expect((await stale).ok).toBe(false);
  expect(scene.get().active).toBe('waiting');
  expect(scene.get().preparing).toBeUndefined();
});

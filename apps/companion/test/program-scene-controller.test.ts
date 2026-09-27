import { expect, it, vi } from 'vitest';
import type { ProgramSceneId } from '@rivalhub-broadcast/protocol/program-scenes';
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

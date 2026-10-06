import { expect, it } from 'vitest';
import { adaptGsiPayload } from '@mizar/telemetry-gsi';
import { createInitialRuntimeState, reduceRuntime } from '@mizar/core/runtime';
import { projectProgram, selectProgramSafeRuntimeView } from '@mizar/core/projection';
import { emptyActiveLineup, unboundIdentityResolution } from '@mizar/core/identity';
import evidence from './fixtures/rc14-defuse.json' with { type: 'json' };

const policy = { staleAfterMs: 2000 };
function adapted(frame: (typeof evidence.defuse.frames)[number]) {
  const result = adaptGsiPayload(frame.payload, {
    sequence: frame.sequence,
    receivedAt: frame.receivedAt,
    receivedMonotonicMs: frame.elapsedUs / 1000,
  });
  if (!result.ok) throw new Error('RC14 excerpt did not adapt');
  return result.observation;
}

it('recovers a ten-second ring from actual pistol inputs without inventing a kit field', () => {
  let runtime = createInitialRuntimeState('rc14-regression');
  for (const frame of evidence.defuse.frames) {
    const observation = adapted(frame);
    runtime = reduceRuntime(
      runtime,
      {
        kind: 'program-telemetry',
        sourceGeneration: 0,
        observation,
      },
      policy,
    ).state;
    const program = projectProgram({
      runtime: selectProgramSafeRuntimeView(runtime),
      identity: unboundIdentityResolution(),
      activeLineup: emptyActiveLineup(),
      nowMonotonicMs: observation.receive.receivedMonotonicMs,
      continuityPolicy: policy,
    });
    if (program.bomb?.state === 'defusing') {
      expect(program.bomb.action).toMatchObject({ durationSeconds: 10, hasDefuseKit: null });
      expect(program.bomb.action!.remainingSeconds).toBeGreaterThan(9);
    }
  }
});

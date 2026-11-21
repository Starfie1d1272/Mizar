import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import type { ProgramSnapshot } from '@mizar/protocol/program';
import type { RadarSnapshot } from '@mizar/protocol/radar';
import { radarMatchesProgram } from './program-radar';

test('radar follows the fresh program source and map', () => {
  const cursor = {
    producerInstanceId: 'producer',
    liveSessionId: 'session',
    programSourceGeneration: 1,
    mapEpoch: 2,
    runtimeSeq: 1,
    programReceiveSequence: 1,
  };
  const program = { cursor, payload: { status: { telemetry: 'fresh' } } } as ProgramSnapshot;
  const radar = { cursor } as RadarSnapshot;
  assert.equal(radarMatchesProgram(program, radar), true);
  assert.equal(radarMatchesProgram(null, radar), false);
  assert.equal(radarMatchesProgram(program, null), false);
  assert.equal(
    radarMatchesProgram(
      {
        ...program,
        payload: { ...program.payload, status: { ...program.payload.status, telemetry: 'stale' } },
      },
      radar,
    ),
    false,
  );
  for (const change of [
    { producerInstanceId: 'other' },
    { liveSessionId: 'other' },
    { programSourceGeneration: 2 },
    { mapEpoch: 3 },
  ]) {
    assert.equal(
      radarMatchesProgram(program, { ...radar, cursor: { ...cursor, ...change } }),
      false,
    );
  }
});

import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { createLhmProjection } from '../src/projection.js';

it('renders a captured LHM GSI update using the shared Mizar projection', () => {
  const capture: unknown = JSON.parse(
    readFileSync(
      new URL('../../../fixtures/gsi/semantic/warmup/observer/frames.jsonl', import.meta.url),
      'utf8',
    ).split('\n')[0]!,
  );
  const { payload } = capture as { payload: unknown };
  const result = createLhmProjection()(payload, 100);
  expect(result?.program.payload.map.name).toBe('de_ancient');
  expect(result?.program.payload.players).toHaveLength(10);
  expect(result?.radar.payload.players).toHaveLength(10);
  expect(result?.program.payload.teams.ct.mode).toBe('neutral');
  expect(result?.program.cursor).toEqual(result?.radar.cursor);
});

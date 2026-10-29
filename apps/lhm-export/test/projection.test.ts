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

it('expires a defuse clock without accepting the old GSI again', () => {
  const lines = readFileSync(
    new URL('../../../fixtures/gsi/semantic/bomb/defuse/frames.jsonl', import.meta.url),
    'utf8',
  )
    .trim()
    .split('\n');
  const frames = lines.map(
    (line) => JSON.parse(line) as { payload: { bomb?: { state?: string } } },
  );
  const frame = frames.find((item) => item.payload.bomb?.state === 'defusing');
  if (!frame) throw new Error('missing defuse fixture');
  const project = createLhmProjection();
  const initial = project(frame.payload, 100);
  expect(initial?.program.payload.bomb?.action?.remainingSeconds).toBeCloseTo(5.034);
  const expired = project.refresh(1101);
  expect(expired?.program.payload.bomb?.action?.remainingSeconds).toBeNull();
  expect(expired?.program.payload.status.telemetry).toBe('fresh');
  expect(expired?.program.cursor).toEqual(initial?.program.cursor);
  expect(expired?.program.channelSeq).toBe(initial?.program.channelSeq);
  const nextFrame = frames[frames.indexOf(frame) + 1];
  if (!nextFrame) throw new Error('missing next defuse frame');
  const next = project(nextFrame.payload, 1200);
  expect(next?.program.payload.bomb?.action?.remainingSeconds).toBeCloseTo(4.79);
});

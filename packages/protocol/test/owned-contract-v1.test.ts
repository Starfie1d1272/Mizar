import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { expect, it } from 'vitest';
import { parseReliableEventV1 } from '../src/output.js';

async function fixture(name: string): Promise<unknown> {
  return JSON.parse(
    await readFile(join(process.cwd(), 'packages/protocol/test/fixtures', name), 'utf8'),
  );
}

it('enforces kind-specific reliable payloads before V1 freeze', async () => {
  const event = parseReliableEventV1(await fixture('reliable-event-v1.json'));
  const cases = [
    ['match_started', {}],
    ['map_started', {}],
    ['map_ended', { scoreA: 13, scoreB: 11, scoreCT: 13, scoreT: 11 }],
    ['series_ended', { scoreA: 2, scoreB: 1 }],
    ['source_generation_changed', { previousSourceGeneration: 1000 }],
    ['map_epoch_changed', { previousMapEpoch: 1000, reason: 'explicit-reset' }],
    ['identity_mismatch', { reason: null }],
    ['lineup_mismatch', { reason: 'lineup_differs_from_expected' }],
  ];
  for (const [kind, payload] of cases) {
    expect(parseReliableEventV1({ ...event, kind, payload }).kind).toBe(kind);
    expect(() =>
      parseReliableEventV1({ ...event, kind, payload: { ...(payload as object), unrelated: 0 } }),
    ).toThrow();
  }
  expect(() => parseReliableEventV1({ ...event, kind: 'identity_mismatch' })).toThrow();
  expect(() =>
    parseReliableEventV1({
      ...event,
      kind: 'map_ended',
      payload: { scoreCT: 13, scoreT: 11 },
    }),
  ).toThrow();
});

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { expect, it } from 'vitest';
import {
  LIVE_SNAPSHOT_MAX_BYTES,
  parseLiveSnapshotV1,
  type LiveSnapshotV1,
} from '../src/output.js';

async function fixture(): Promise<LiveSnapshotV1> {
  return parseLiveSnapshotV1(
    JSON.parse(
      await readFile(
        resolve(process.cwd(), 'packages/protocol/test/fixtures/live-snapshot-v1.radar.json'),
        'utf8',
      ),
    ),
  );
}

it('rejects private and unknown fields at every new boundary', async () => {
  const base = await fixture();
  const radar = base.radar!;
  for (const candidate of [
    { ...base, lookahead: {} },
    { ...base, roundHistory: { ...base.roundHistory, future: [] } },
    {
      ...base,
      roundHistory: {
        ...base.roundHistory,
        rounds: [{ ...base.roundHistory!.rounds[0], rawGsi: {} }],
      },
    },
    { ...base, radar: { ...radar, assist: {} } },
    { ...base, radar: { ...radar, players: [{ ...radar.players[0], forward: {} }] } },
    {
      ...base,
      radar: {
        ...radar,
        players: [{ ...radar.players[0], position: { x: 0.5, y: 0.5, layer: 'upper', z: 0 } }],
      },
    },
    { ...base, radar: { ...radar, bomb: { ...radar.bomb, rawGsi: {} } } },
    { ...base, radar: { ...radar, utility: [{ ...radar.utility[0], trail: [] }] } },
    {
      ...base,
      radar: {
        ...radar,
        utility: [
          { ...radar.utility[1], flames: [{ ...radar.utility[1]!.flames[0], velocity: {} }] },
        ],
      },
    },
  ])
    expect(() => parseLiveSnapshotV1(candidate)).toThrow();
});

it('accepts a near-hard-bound fixture and rejects malicious escaped-string amplification', async () => {
  const base = await fixture();
  const radar = base.radar!;
  const sized = (width: number) => ({
    ...base,
    roundHistory: {
      ...base.roundHistory!,
      rounds: Array.from({ length: 256 }, (_, i) => ({
        ...base.roundHistory!.rounds[0]!,
        roundNumber: i + 1,
      })),
    },
    players: [],
    radar: {
      ...radar,
      players: Array(64).fill(radar.players[0]),
      utility: Array.from({ length: 128 }, (_, i) => ({
        ...radar.utility[1]!,
        sourceEntityId: `utility-${i}`,
        flames:
          i < 8
            ? Array.from({ length: 64 }, (_, f) => ({
                sourceFlameId: '\u0000'.repeat(width - 2) + String(f).padStart(2, '0'),
                position: { x: 0.5, y: 0.5, layer: 'upper' },
              }))
            : [],
      })),
    },
  });
  const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;
  let width = 2;
  while (bytes(sized(width + 1)) <= LIVE_SNAPSHOT_MAX_BYTES) width++;
  const near = sized(width);
  expect(bytes(near)).toBeGreaterThan(LIVE_SNAPSHOT_MAX_BYTES - 4096);
  expect(parseLiveSnapshotV1(near).radar?.utility).toHaveLength(128);
  expect(() => parseLiveSnapshotV1(sized(width + 1))).toThrow('output_payload_too_large');
  expect(() =>
    parseLiveSnapshotV1({ ...base, matchId: '界'.repeat(LIVE_SNAPSHOT_MAX_BYTES) }),
  ).toThrow('output_payload_too_large');
});

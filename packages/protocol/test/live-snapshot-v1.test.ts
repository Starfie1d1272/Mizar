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

it('parses the complete public fixture and preserves complete, partial, unavailable and null history', async () => {
  const base = await fixture();
  expect(base.radar?.players[0]?.position).toEqual({ x: 0.5, y: 0.5, layer: 'upper' });
  for (const completeness of ['complete', 'partial', 'unavailable'] as const) {
    const roundHistory = {
      ...base.roundHistory!,
      completeness,
      rounds: completeness === 'unavailable' ? [] : base.roundHistory!.rounds,
    };
    expect(parseLiveSnapshotV1({ ...base, roundHistory }).roundHistory).toEqual(roundHistory);
  }
  expect(parseLiveSnapshotV1({ ...base, roundHistory: null }).roundHistory).toBeNull();
});

it('rejects cross-field contradictions in the public live contract', async () => {
  const base = await fixture();
  const radar = base.radar!;
  expect(() =>
    parseLiveSnapshotV1({
      ...base,
      radar: { ...radar, mapName: base.map.name === 'de_nuke' ? 'de_ancient' : 'de_nuke' },
    }),
  ).toThrow();
  expect(() =>
    parseLiveSnapshotV1({
      ...base,
      capability: { ...base.capability, radarCurrent: false },
    }),
  ).toThrow();
  expect(() =>
    parseLiveSnapshotV1({
      ...base,
      series: { ...base.series, currentMapOrder: 2 },
      roundHistory: { ...base.roundHistory!, mapOrder: 1 },
    }),
  ).toThrow();
});

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

it('enforces collection, nested string, coordinate and layer limits', async () => {
  const base = await fixture();
  const radar = base.radar!;
  const utility = radar.utility[1]!;
  const flame = utility.flames[0]!;
  for (const candidate of [
    {
      ...base,
      roundHistory: { ...base.roundHistory, rounds: Array(257).fill(base.roundHistory!.rounds[0]) },
    },
    {
      ...base,
      roundHistory: {
        ...base.roundHistory,
        rounds: [{ ...base.roundHistory!.rounds[0], winnerEntryId: 'x'.repeat(129) }],
      },
    },
    { ...base, radar: { ...radar, players: Array(65).fill(radar.players[0]) } },
    { ...base, radar: { ...radar, utility: Array(129).fill(utility) } },
    { ...base, radar: { ...radar, utility: [{ ...utility, flames: Array(65).fill(flame) }] } },
    {
      ...base,
      radar: { ...radar, utility: Array(9).fill({ ...utility, flames: Array(64).fill(flame) }) },
    },
    { ...base, radar: { ...radar, calibrationRevision: 'x'.repeat(129) } },
    { ...base, radar: { ...radar, utility: [{ ...utility, kind: 'x'.repeat(129) }] } },
    { ...base, radar: { ...radar, layers: ['single', 'upper'] } },
    { ...base, radar: { ...radar, layers: ['upper', 'upper'] } },
    { ...base, radar: { ...radar, layers: ['upper'], players: [], bomb: null, utility: [] } },
  ])
    expect(() => parseLiveSnapshotV1(candidate)).toThrow();
  for (const x of [-0.01, 1.01, NaN, Infinity])
    expect(() =>
      parseLiveSnapshotV1({
        ...base,
        radar: { ...radar, bomb: { position: { x, y: 0, layer: 'upper' } } },
      }),
    ).toThrow();
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

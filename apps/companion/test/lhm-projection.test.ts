import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { programPayloadSchema } from '@mizar/protocol/program';
import { radarPayloadSchema } from '@mizar/protocol/radar';
import { projectLhm } from '../src/hud-compat/projection.js';

const programFixtures = JSON.parse(
  readFileSync(
    new URL(
      '../../web/src/program/fixtures/generated/real-program-fixtures.generated.json',
      import.meta.url,
    ),
    'utf8',
  ),
) as { fixtures: Record<string, { snapshot: { payload: unknown } }> };
const radarFixtures = JSON.parse(
  readFileSync(
    new URL(
      '../../web/src/program/fixtures/generated/real-radar-fixtures.generated.json',
      import.meta.url,
    ),
    'utf8',
  ),
) as { fixtures: Record<string, { samples: { snapshot: { payload: unknown } }[] }> };

describe('LHM projection', () => {
  const program = programPayloadSchema.parse(
    programFixtures.fixtures['real-warmup']!.snapshot.payload,
  );
  const radar = radarPayloadSchema.parse(
    radarFixtures.fixtures.warmup!.samples[0]!.snapshot.payload,
  );
  it('maps a matched real replay without inventing player positions', () => {
    const result = projectLhm(program, radar);
    expect(result.available).toBe(true);
    if (!result.available) return;
    expect(result.raw).toMatchObject({
      map: { name: 'de_ancient', round: 0 },
      allplayers: {
        [program.players[0]!.sourcePlayerId]: {
          name: program.players[0]!.displayName,
          position: '-525.4, 678.2, 146.2',
        },
      },
    });
  });
  it('reports missing or stale data instead of manufacturing it', () => {
    const stale = projectLhm(program, { ...radar, telemetryFreshness: 'stale' });
    expect(stale.available).toBe(false);
    if (!stale.available) expect(stale.missing).toContain('telemetry');
    const missing = projectLhm(program, { ...radar, players: [] });
    expect(missing.available).toBe(false);
    if (!missing.available)
      expect(missing.missing).toContain(`player:${program.players[0]!.sourcePlayerId}`);
  });
});

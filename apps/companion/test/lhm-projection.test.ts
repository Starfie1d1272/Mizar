import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { programPayloadSchema, programSnapshotSchema } from '@mizar/protocol/program';
import { radarPayloadSchema, radarSnapshotSchema } from '@mizar/protocol/radar';
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
  it('preserves bomb clocks in all 19 cursor-matched replay projections', () => {
    const radars = Object.values(radarFixtures.fixtures).flatMap((fixture) =>
      fixture.samples.map((sample) => radarSnapshotSchema.parse(sample.snapshot)),
    );
    const programs = Object.values(programFixtures.fixtures).map((fixture) =>
      programSnapshotSchema.parse(fixture.snapshot),
    );
    expect(programs).toHaveLength(19);
    for (const snapshot of programs) {
      const matching = radars.find(
        (candidate) => JSON.stringify(candidate.cursor) === JSON.stringify(snapshot.cursor),
      );
      expect(matching, `missing radar for ${snapshot.cursor.programReceiveSequence}`).toBeDefined();
      if (!matching) continue;
      const result = projectLhm(snapshot.payload, matching.payload);
      expect(result.available, `frame ${snapshot.cursor.programReceiveSequence}`).toBe(true);
      const state = snapshot.payload.bomb?.state;
      if (state !== 'planting' && state !== 'defusing' && state !== 'planted') continue;
      expect(result.available, `${state} ${snapshot.cursor.programReceiveSequence}`).toBe(true);
      if (!result.available) continue;
      const expected =
        state === 'planted'
          ? snapshot.payload.bomb?.explosion?.remainingSeconds
          : snapshot.payload.bomb?.action?.remainingSeconds;
      expect(result.raw).toMatchObject({ bomb: { state, countdown: String(expected) } });
    }
  });
  it('rejects missing required bomb time and weapon name', () => {
    const planting = programPayloadSchema.parse(
      programFixtures.fixtures['real-planting']!.snapshot.payload,
    );
    if (!planting.bomb) throw new Error('fixture missing bomb');
    planting.bomb.action = null;
    const result = projectLhm(planting, radar);
    expect(result.available).toBe(false);
    if (!result.available) expect(result.missing).toContain('bomb:countdown');
    const missingWeapon = structuredClone(program);
    missingWeapon.players[0]!.weapons[0]!.name = null;
    const weapons = projectLhm(missingWeapon, radar);
    expect(weapons.available).toBe(false);
    if (!weapons.available)
      expect(weapons.missing).toContain(`player:${program.players[0]!.sourcePlayerId}`);
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

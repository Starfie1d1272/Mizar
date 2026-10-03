import { describe, expect, it } from 'vitest';
import { parseLiveSnapshotV1 } from '@mizar/protocol/output';
import { fromPublicRadar, getRadarArtwork, radarAssetUrl } from '@mizar-hud/radar-view';
import { RadarPresentation, radarUtilityPhase } from '@mizar-hud/radar-view/presentation';
import { readFileSync } from 'node:fs';
// Read the shared wire corpus as data, not a cross-package source module.
const fixture: unknown = JSON.parse(
  readFileSync('packages/protocol/test/fixtures/live-snapshot-v1.radar.json', 'utf8'),
);

function frame() {
  const live = parseLiveSnapshotV1(fixture);
  return fromPublicRadar(live.radar, {
    boundary: 'match:authority:generation:epoch',
    sequence: 10,
    current: true,
    bomb: live.bomb,
  })!;
}

describe('public radar consumer contract', () => {
  it('consumes the actual LiveSnapshot radar including utility and flames without local fields', () => {
    const input = frame();
    expect(input.payload.grenades.length).toBeGreaterThan(0);
    expect(input.payload.grenades.some((g) => g.flames.length > 0)).toBe(true);
    expect(input.payload.players[0]).not.toHaveProperty('health');
    expect(input.payload.players[0]).not.toHaveProperty('label');
    expect(input.payload.grenades[0]).not.toHaveProperty('moving');
    const model = new RadarPresentation();
    model.accept(input, 0);
    expect(model.players.size).toBeGreaterThan(0);
    expect(model.grenades.size).toBeGreaterThan(0);
    expect(
      [...model.grenades.values()].some((g) => g.source.kind === 'inferno' && g.phase === 'effect'),
    ).toBe(true);
  });

  it('preserves optional Radar C4 state unless the host supplies authoritative bomb fields', () => {
    const radar = parseLiveSnapshotV1(fixture).radar!;
    const bomb = { position: null, state: 'carried', sourcePlayerId: 'carrier' };
    const context = { boundary: 'match', sequence: 1, current: true };
    expect(fromPublicRadar({ ...radar, bomb }, context)!.payload.bomb).toEqual(bomb);
    expect(
      fromPublicRadar(
        { ...radar, bomb },
        {
          ...context,
          bomb: { state: 'dropped', sourcePlayerId: null },
        },
      )!.payload.bomb,
    ).toEqual({ position: null, state: 'dropped', sourcePlayerId: null });
  });

  it('distinguishes absent public motion evidence from explicitly unknown local velocity', () => {
    const grenade = {
      kind: 'frag',
      position: { x: 0.5, y: 0.5, layer: 'upper' as const },
      effectTimeSeconds: null,
      flames: [],
    };
    expect(radarUtilityPhase(grenade)).toBe('projectile');
    expect(radarUtilityPhase({ ...grenade, moving: null })).toBe('terminal');
    expect(radarUtilityPhase({ ...grenade, moving: false })).toBe('terminal');
    expect(radarUtilityPhase({ ...grenade, moving: true })).toBe('projectile');
  });

  it('clears unavailable, unsupported maps and incompatible calibration instead of guessing', () => {
    const input = frame();
    const model = new RadarPresentation();
    for (const invalid of [
      null,
      { ...input, mapName: 'de_unsupported' },
      { ...input, calibrationRevision: 'new-incompatible-calibration' },
    ]) {
      model.accept(input, 0);
      model.accept(invalid, 10);
      expect(model.players.size).toBe(0);
      expect(model.grenades.size).toBe(0);
    }
    expect(
      fromPublicRadar(parseLiveSnapshotV1(fixture).radar, {
        boundary: 'x',
        sequence: 1,
        current: false,
      }),
    ).toBeNull();
  });

  it('drops explicit missing public positions, including an established smoke and death marker', () => {
    const input = frame();
    const player = input.payload.players[0]!;
    const smoke = {
      sourceEntityId: 'smoke',
      kind: 'smoke',
      ownerSourceId: null,
      position: player.position,
      lifetimeSeconds: 2,
      effectTimeSeconds: 2,
      flames: [],
    };
    const model = new RadarPresentation();
    model.accept({ ...input, payload: { ...input.payload, grenades: [smoke] } }, 0);
    expect(model.grenades.get('smoke')?.phase).toBe('effect');
    model.accept(
      {
        ...input,
        sequence: 11,
        payload: {
          players: [{ ...player, lifeState: 'dead', position: null }],
          bomb: null,
          grenades: [{ ...smoke, position: null }],
        },
      },
      500,
    );
    expect(model.players.size).toBe(0);
    expect(model.grenades.size).toBe(0);
    expect(model.exits.size).toBe(0);
  });

  it('smooths 2 Hz latest-value samples with bounded prediction and no consecutive GSI requirement', () => {
    const input = frame();
    const player = {
      ...input.payload.players[0]!,
      lifeState: 'alive' as const,
      position: { x: 0.5, y: 0.5, layer: 'upper' as const },
    };
    const start = { ...input, payload: { ...input.payload, players: [player], grenades: [] } };
    const model = new RadarPresentation();
    model.accept(start, 0);
    const next = {
      ...start,
      sequence: 40,
      payload: {
        ...start.payload,
        players: [{ ...player, position: { ...player.position, x: 0.52 } }],
      },
    };
    model.accept(next, 600);
    model.tick(900, false);
    expect(model.players.get(player.sourcePlayerId)!.x).toBeCloseTo(0.51);
    model.tick(5000, false);
    const x = model.players.get(player.sourcePlayerId)!.x;
    model.tick(10000, false);
    expect(model.players.get(player.sourcePlayerId)!.x).toBe(x);
    model.accept({ ...start, sequence: 39 }, 11000);
    expect(model.snapshot).toBe(next);
    model.accept({ ...start, boundary: 'new-match-or-authority', sequence: 1 }, 12000);
    expect(model.players.get(player.sourcePlayerId)!.x).toBe(0.5);
  });

  it('snaps across floors and resets transient effects on reconnect', () => {
    const input = frame();
    const model = new RadarPresentation();
    model.accept(input, 0);
    const player = input.payload.players.find((p) => p.position)!;
    const moved = {
      ...player,
      position: {
        ...player.position!,
        layer: player.position!.layer === 'upper' ? ('lower' as const) : ('upper' as const),
      },
    };
    model.accept({ ...input, sequence: 11, payload: { ...input.payload, players: [moved] } }, 500);
    expect(model.players.get(player.sourcePlayerId)!.interpolationDurationMs).toBe(0);
    model.accept(input, 600, true);
    expect(model.exits.size).toBe(0);
  });

  it('resolves the same hashed assets under root, subpath and CDN prefixes', () => {
    const artwork = getRadarArtwork('de_nuke')!;
    expect(artwork.layers).toEqual(['upper', 'lower']);
    for (const base of ['/', '/radar/v0.1.0/', 'https://cdn.example.test/radar/v0.1.0/']) {
      expect(radarAssetUrl(artwork.artwork.upper!, base)).toBe(
        base + artwork.artwork.upper!.replace(/^\//, ''),
      );
    }
  });
});

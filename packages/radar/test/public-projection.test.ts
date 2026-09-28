import { expect, it } from 'vitest';

import {
  defaultMapGeometryProvider,
  projectPublicRadarFrame,
  type RadarFrame,
} from '../src/index.js';

function frame(mapName = 'de_ancient'): RadarFrame {
  const geometry = defaultMapGeometryProvider.resolve(mapName)!;
  const position = {
    x: geometry.originWorld.x + geometry.scaleWorldUnitsPerPixel * 512,
    y: geometry.originWorld.y - geometry.scaleWorldUnitsPerPixel * 512,
    z: 0,
  };
  return {
    cursor: {
      producerInstanceId: 'test',
      liveSessionId: null,
      runtimeSeq: 1,
      programSourceGeneration: 0,
      programReceiveSequence: 1,
      mapEpoch: 1,
    },
    telemetryFreshness: 'fresh',
    identityState: 'matched',
    mapName,
    observedPlayerSourceId: 'player',
    coverage: { allPlayers: 'present', bomb: 'present', grenades: 'present' },
    players: [
      {
        sourcePlayerId: 'player',
        canonicalPlayerId: 'canonical',
        displayName: null,
        side: 'CT',
        observerSlot: null,
        lifeState: 'alive',
        position,
        forward: { x: 0, y: 1, z: 0 },
        health: 100,
        flashAmount: null,
        activeWeapon: null,
      },
    ],
    bomb: { state: 'planted', sourcePlayerId: null, position },
    grenades: ['frag', 'smoke', 'inferno'].map((kind, index) => ({
      sourceEntityId: `utility-${index}`,
      kind,
      ownerSourceId: 'player',
      position: kind === 'inferno' ? null : position,
      velocity: null,
      lifetimeSeconds: 8,
      effectTimeSeconds: kind === 'smoke' ? 5 : null,
      flames: kind === 'inferno' ? [{ sourceFlameId: 'flame', position }] : [],
    })),
  };
}

it('projects single-layer players, facing, C4 and utility using canonical geometry without history', () => {
  const input = frame();
  const result = projectPublicRadarFrame(input)!;
  expect(result).toMatchObject({
    mapName: 'de_ancient',
    layers: ['single'],
    activeLayer: 'single',
  });
  expect(result.players[0]).toMatchObject({
    canonicalPlayerId: 'canonical',
    side: 'CT',
    lifeState: 'alive',
    position: { x: 0.5, y: 0.5, layer: 'single' },
    facing: { x: 0, y: -1 },
  });
  expect(result.bomb?.position).toEqual(result.players[0]?.position);
  expect(result.utility[1]).toMatchObject({
    kind: 'smoke',
    lifetimeSeconds: 8,
    effectTimeSeconds: 5,
  });
  expect(result.utility[2]).toMatchObject({
    kind: 'inferno',
    position: null,
    flames: [{ sourceFlameId: 'flame', position: { x: 0.5, y: 0.5, layer: 'single' } }],
  });
  expect(result.utility[0]?.kind).toBe('frag');
  const dead = projectPublicRadarFrame({
    ...input,
    players: input.players.map((p) => ({ ...p, lifeState: 'dead' })),
  });
  expect(dead?.players[0]).toMatchObject({ lifeState: 'dead', facing: null });
  expect(
    projectPublicRadarFrame({
      ...input,
      players: input.players.map((p) => ({ ...p, position: null })),
    })?.players[0]?.position,
  ).toBeNull();
});

it('projects both floors and selects the observed floor, failing closed on unknown height or bounds', () => {
  const input = frame('de_nuke');
  const upper = input.players[0]!;
  const lower = { ...upper, sourcePlayerId: 'lower', position: { ...upper.position!, z: -600 } };
  const result = projectPublicRadarFrame({
    ...input,
    players: [upper, lower],
    observedPlayerSourceId: 'lower',
  })!;
  expect(result.layers).toEqual(['upper', 'lower']);
  expect(result.activeLayer).toBe('lower');
  expect(result.players.map((p) => p.position?.layer)).toEqual(['upper', 'lower']);
  expect(
    projectPublicRadarFrame({ ...input, players: [upper, lower], observedPlayerSourceId: null })
      ?.activeLayer,
  ).toBeNull();
  for (const position of [
    { ...upper.position!, z: NaN },
    { x: 1e9, y: 1e9, z: 0 },
  ]) {
    const invalid = projectPublicRadarFrame({
      ...input,
      players: [{ ...upper, position }],
      bomb: { ...input.bomb!, position },
      grenades: [{ ...input.grenades[2]!, position, flames: [{ sourceFlameId: 'bad', position }] }],
    })!;
    expect(invalid.players[0]?.position).toBeNull();
    expect(invalid.bomb?.position).toBeNull();
    expect(invalid.utility[0]?.position).toBeNull();
    expect(invalid.utility[0]?.flames).toEqual([]);
    expect(invalid.activeLayer).toBeNull();
  }
});

it('returns unavailable for unsupported maps, stale telemetry and identity mismatch', () => {
  const input = frame();
  expect(projectPublicRadarFrame({ ...input, mapName: 'unsupported' })).toBeNull();
  expect(projectPublicRadarFrame({ ...input, telemetryFreshness: 'stale' })).toBeNull();
  expect(projectPublicRadarFrame({ ...input, identityState: 'mismatch' })).toBeNull();
});

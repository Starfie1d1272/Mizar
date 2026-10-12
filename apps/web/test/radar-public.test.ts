import { describe, expect, it } from 'vitest';
import { parseLiveSnapshotV1 } from '@mizar/protocol/output';
import { fromPublicRadar } from '@mizar-hud/radar-view';
import { RadarPresentation } from '@mizar-hud/radar-view/presentation';
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
});

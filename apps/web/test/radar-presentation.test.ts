import { describe, expect, it } from 'vitest';
import { radarSnapshotSchema, type RadarSnapshot } from '@mizar/protocol/radar';
import { RadarPresentation as SharedRadarPresentation } from '@mizar-hud/radar-view/presentation';
import fixtures from '../src/program/fixtures/generated/real-radar-fixtures.generated.json';

import { toRadarViewFrame } from '../src/program/widgets/radar/adapter';
import type { RadarViewFrame } from '@mizar-hud/radar-view';
class RadarPresentation extends SharedRadarPresentation {
  override accept(snapshot: RadarSnapshot | RadarViewFrame | null, now: number, reconnect = false) {
    super.accept(
      snapshot && 'channel' in snapshot ? toRadarViewFrame(snapshot) : snapshot,
      now,
      reconnect,
    );
  }
}

function real(): RadarSnapshot {
  return radarSnapshotSchema.parse(fixtures.fixtures['dense-utility'].samples[0]!.snapshot);
}
function next(s: RadarSnapshot): RadarSnapshot {
  const n = structuredClone(s);
  n.channelSeq++;
  n.cursor.runtimeSeq++;
  n.cursor.programReceiveSequence = (n.cursor.programReceiveSequence ?? 0) + 1;
  return n;
}
// Explicit synthetic mutations exercise edges that a repeatable real capture cannot guarantee.
function single(): RadarSnapshot {
  const s = real();
  s.payload.mapName = 'de_mirage';
  s.payload.observedPlayerSourceId = null;
  s.payload.players = [
    {
      ...s.payload.players[0]!,
      position: { x: -1000, y: 0, z: 0 },
      forward: { x: 1, y: 0, z: 0 },
      lifeState: 'alive',
      health: 100,
      flashAmount: 0,
      activeWeapon: { name: 'weapon_ak47', ammoClip: 30, state: 'active' },
    },
  ];
  s.payload.grenades = [
    {
      sourceEntityId: 'synthetic-projectile',
      kind: 'frag',
      ownerSourceId: null,
      position: { x: -1000, y: 0, z: 0 },
      velocity: { x: 100, y: 0, z: 0 },
      lifetimeSeconds: 0,
      effectTimeSeconds: null,
      flames: [],
    },
  ];
  return s;
}

describe('Radar renderer local lifecycle', () => {
  it('keeps the real seq 925→926 smoke stable across owner identity drift', () => {
    const before = single();
    const owner = '76561197960690195';
    before.payload.players[0] = { ...before.payload.players[0]!, sourcePlayerId: owner };
    before.payload.grenades = [
      {
        ...before.payload.grenades[0]!,
        sourceEntityId: '160',
        kind: 'smoke',
        ownerSourceId: owner,
        position: { x: -2071.5, y: 377.1, z: 75.9 },
        velocity: { x: 20.557, y: -5.244, z: -8.604 },
        lifetimeSeconds: 19.11,
        effectTimeSeconds: 16.656,
      },
    ];

    const model = new RadarPresentation();
    model.accept(before, 0);
    const initial = model.grenades.get('160')!;
    expect(initial).toMatchObject({
      phase: 'effect',
      side: before.payload.players[0].side,
    });
    const initialPhaseStartedAt = initial.phaseStartedAt;
    const initialAnchor = {
      x: initial.x,
      y: initial.y,
      target: structuredClone(initial.target),
    };

    // Ancient acceptance replay seq 926 keeps the same smoke entity and position,
    // but its owner changes from a Steam64 id to "263".
    const ownerDrift = next(before);
    ownerDrift.payload.grenades[0]!.ownerSourceId = '263';
    ownerDrift.payload.grenades[0]!.lifetimeSeconds = 19.352;
    ownerDrift.payload.grenades[0]!.effectTimeSeconds = 16.906;
    model.accept(ownerDrift, 250);

    const drifted = model.grenades.get('160')!;
    expect(drifted).toMatchObject({
      phase: 'effect',
      side: before.payload.players[0].side,
      phaseStartedAt: initialPhaseStartedAt,
      x: initialAnchor.x,
      y: initialAnchor.y,
      target: initialAnchor.target,
    });
    // Even if later telemetry position/velocity is noisy, a settled smoke remains
    // anchored to the first authoritative effect position for this lifecycle.
    const noisy = next(ownerDrift);
    noisy.payload.grenades[0]!.position = { x: 1_000_000, y: 1_000_000, z: 75.9 };
    noisy.payload.grenades[0]!.velocity = { x: 400, y: 0, z: 0 };
    noisy.payload.grenades[0]!.lifetimeSeconds = 19.61;
    noisy.payload.grenades[0]!.effectTimeSeconds = 17.156;
    model.accept(noisy, 500);

    expect(model.grenades.get('160')).toMatchObject({
      phase: 'effect',
      x: initialAnchor.x,
      y: initialAnchor.y,
      target: initialAnchor.target,
      phaseStartedAt: initialPhaseStartedAt,
    });
  });
  it('starts ID reuse with new history after an observed projectile disappears', () => {
    const m = new RadarPresentation();
    let s = single();
    m.accept(s, 0);
    s = next(s);
    s.payload.grenades[0]!.position!.x += 0.1;
    m.accept(s, 10);
    const g = [...m.grenades.values()][0]!;
    expect(g.trail).toHaveLength(2);
    expect(g.side).toBe('unknown');
    const gone = next(s);
    gone.payload.grenades = [];
    m.accept(gone, 20);
    expect(m.grenades.size).toBe(0);
    expect(m.exits.size).toBe(1);
    const reused = next(gone);
    reused.payload.grenades = s.payload.grenades;
    m.accept(reused, 30);
    expect([...m.grenades.values()][0]!.trail).toHaveLength(1);
    expect(m.exits.size).toBe(0);
  });
});

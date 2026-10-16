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
  it.each([
    {
      round: 3,
      entity: '114',
      samples: [
        { at: 0, position: [-1084.8, -915.9, 402.1], lifetime: 4.137, effect: 0 },
        { at: 14.045, position: [-1085.6, -917.7, 404.1], lifetime: 4.152, effect: 0 },
        { at: 45.728, position: [-1087.3, -921.4, 407.8], lifetime: 4.184, effect: 0 },
        { at: 3467.384, position: [-1258.2, -1309, 24], lifetime: 7.605, effect: 0.031 },
      ],
    },
    {
      round: 6,
      entity: '486',
      samples: [
        { at: 0, position: [-1090, -928.1, 409.4], lifetime: 4.47, effect: 0 },
        { at: 30.314, position: [-1091.8, -931.8, 412.4], lifetime: 4.501, effect: 0 },
        { at: 60.972, position: [-1093.5, -935.5, 415.2], lifetime: 4.533, effect: 0 },
        { at: 3264.513, position: [-1256.2, -1301, 24], lifetime: 7.736, effect: 0.047 },
      ],
    },
  ])(
    'waits for effect time before anchoring the Ancient round $round smoke',
    ({ entity, samples }) => {
      // Minimal positions/timing from the 2026-10-16 GSI capture of demo
      // 4163084560_1000003401: seq 30073–30075/30161 and 39038–39040/39118.
      const model = new RadarPresentation();
      let snapshot = single();
      snapshot.payload.mapName = 'de_ancient';
      for (const sample of samples) {
        snapshot = next(snapshot);
        const [x, y, z] = sample.position as [number, number, number];
        snapshot.payload.grenades = [
          {
            ...snapshot.payload.grenades[0]!,
            sourceEntityId: entity,
            kind: 'smoke',
            position: { x, y, z },
            lifetimeSeconds: sample.lifetime,
            effectTimeSeconds: sample.effect,
          },
        ];
        model.accept(snapshot, sample.at);
        expect(model.grenades.get(entity)?.phase).toBe(sample.effect > 0 ? 'effect' : 'projectile');
      }
      const settled = samples.at(-1)!;
      const marker = model.grenades.get(entity)!;
      // Ancient's independent overview calibration is (-2953, 2164), 5 units/px at 1024px.
      expect(marker.target.x).toBeCloseTo((settled.position[0]! + 2953) / 5120);
      expect(marker.target.y).toBeCloseTo((2164 - settled.position[1]!) / 5120);
    },
  );

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

    // Previously observed lifetime quantization and short missing/zero effect fields
    // must not turn a confirmed smoke back into a projectile or restart its entrance.
    let stable = noisy;
    for (const [index, update] of [
      { lifetimeSeconds: 19.597, effectTimeSeconds: 0 },
      { lifetimeSeconds: 19.7, effectTimeSeconds: null, position: null },
    ].entries()) {
      stable = next(stable);
      Object.assign(stable.payload.grenades[0]!, update);
      model.accept(stable, 600 + index * 100);
      expect(model.grenades.get('160')).toMatchObject({
        phase: 'effect',
        side: before.payload.players[0].side,
        phaseStartedAt: initialPhaseStartedAt,
        x: initialAnchor.x,
        y: initialAnchor.y,
        target: initialAnchor.target,
        positionAvailable: true,
      });
    }
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

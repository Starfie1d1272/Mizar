import { describe, expect, it } from 'vitest';
import { radarSnapshotSchema, type RadarSnapshot } from '@mizar/protocol/radar';
import {
  RadarPresentation as SharedRadarPresentation,
  RADAR_PRESENTATION,
} from '@mizar-hud/radar-view/presentation';
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

  it('does not replay entry or lose T ownership on RC14 seq 2913→2914 sub-tick jitter after owner drift', () => {
    // Real anonymous RC14 smoke-excerpt.jsonl.gz, evidence commit a23d71e.
    // Entity 95 changes owner to "397" after death; lifetime 10.374→10.364.
    const before = single();
    const owner = before.payload.players[0]!.sourcePlayerId;
    before.payload.players[0]!.side = 'T';
    before.payload.grenades = [
      {
        ...before.payload.grenades[0]!,
        sourceEntityId: '95',
        kind: 'smoke',
        ownerSourceId: owner,
        position: { x: 677.9, y: -1526.7, z: -413.5 },
        velocity: { x: 0, y: 0, z: 0 },
        lifetimeSeconds: 10.3,
        effectTimeSeconds: 8.672,
      },
    ];
    const model = new RadarPresentation();
    model.accept(before, 0);
    const phaseStartedAt = model.grenades.get('95')!.phaseStartedAt;
    const drift = next(before);
    drift.payload.players[0]!.health = 0;
    drift.payload.players[0]!.lifeState = 'dead';
    drift.payload.grenades[0]!.ownerSourceId = '397';
    drift.payload.grenades[0]!.lifetimeSeconds = 10.374;
    drift.payload.grenades[0]!.effectTimeSeconds = 8.75;
    model.accept(drift, 40);
    const jitter = next(drift);
    jitter.payload.grenades[0]!.lifetimeSeconds = 10.364;
    jitter.payload.grenades[0]!.effectTimeSeconds = 8.734;
    model.accept(jitter, 50);
    expect(model.grenades.get('95')).toMatchObject({ phase: 'effect', side: 'T', phaseStartedAt });
    expect(model.exits.size).toBe(0);
  });
  it('keeps the first observation and real reversals through bounded long-flight compression', () => {
    const model = new RadarPresentation();
    let snapshot = single();
    model.accept(snapshot, 0);
    const first = { ...[...model.grenades.values()][0]!.trail[0]! };
    const turns: { x: number; y: number; at: number }[] = [];
    for (let index = 1; index <= 600; index++) {
      snapshot = next(snapshot);
      // Six straight legs with exact backtracking, not just convex corners.
      snapshot.payload.grenades[0]!.position!.x += Math.floor((index - 1) / 100) % 2 ? -2 : 2;
      model.accept(snapshot, index * 10);
      const marker = [...model.grenades.values()][0]!;
      if (index % 100 === 0) turns.push({ ...marker.trail.at(-1)! });
      expect(marker.trail.length).toBeLessThanOrEqual(RADAR_PRESENTATION.trailPoints);
      expect(marker.trail[0]).toEqual(first);
    }
    const marker = [...model.grenades.values()][0]!;
    for (const turn of turns) expect(marker.trail).toContainEqual(turn);
    expect(marker.trail.at(-1)).toMatchObject({ x: marker.target.x, y: marker.target.y });
    for (const autoZoom of [false, true]) {
      model.tick(6000, autoZoom, true);
      expect(marker.trail[0]).toEqual(first);
    }
    snapshot = next(snapshot);
    snapshot.payload.grenades[0]!.position = null;
    model.accept(snapshot, 6010);
    expect([...model.grenades.values()].every((item) => item.trail.length === 0)).toBe(true);
    expect(model.exits.size).toBe(0);
  });
  it('bounds full histories for the maximum simultaneous projectile population', () => {
    const model = new RadarPresentation();
    let snapshot = single();
    snapshot.payload.grenades = Array.from(
      { length: RADAR_PRESENTATION.maxGrenades + 10 },
      (_, index) => ({
        ...snapshot.payload.grenades[0]!,
        sourceEntityId: `stress-${index}`,
        position: { x: -1000, y: index, z: 0 },
      }),
    );
    for (let index = 0; index < 200; index++) {
      snapshot = next(snapshot);
      for (const grenade of snapshot.payload.grenades) grenade.position!.x += 1;
      model.accept(snapshot, index * 10);
      model.tick(index * 10, true);
    }
    expect(model.grenades.size).toBe(RADAR_PRESENTATION.maxGrenades);
    expect(
      [...model.grenades.values()].every(
        (marker) =>
          marker.trail.length <= RADAR_PRESENTATION.trailPoints && marker.trail[0]!.at === 0,
      ),
    ).toBe(true);
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

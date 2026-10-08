import { describe, expect, it } from 'vitest';
import { radarSnapshotSchema, type RadarSnapshot } from '@mizar/protocol/radar';
import { RADAR_SCHEMA_VERSION } from '@mizar/protocol/version';
import {
  grenadeIcon,
  isActiveSmoke as sharedIsActiveSmoke,
  RadarPresentation as SharedRadarPresentation,
  radarPlayerMarkerKind,
  radarPlayerMarkerVisualRole,
  radarUtilityPhase as sharedRadarUtilityPhase,
  shortestAngle,
  smokeRemaining,
  RADAR_PRESENTATION,
} from '@mizar-hud/radar-view/presentation';
import { effectCentroid, smokeContour, smokeLobes } from '@mizar-hud/radar-view/effects';
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
function phaseInput(g: RadarSnapshot['payload']['grenades'][number]) {
  return {
    ...g,
    position: g.position ? { ...g.position, layer: 'single' as const } : null,
    moving:
      g.velocity === null ? null : Math.hypot(g.velocity.x, g.velocity.y, g.velocity.z) > 0.01,
    flames: g.flames.map((f) => ({ ...f, position: { ...f.position, layer: 'single' as const } })),
  };
}
const radarUtilityPhase = (g: RadarSnapshot['payload']['grenades'][number]) =>
  sharedRadarUtilityPhase(phaseInput(g));
const isActiveSmoke = (g: RadarSnapshot['payload']['grenades'][number]) =>
  sharedIsActiveSmoke(phaseInput(g));

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
  it('accepts real source truth and rejects old/malformed/extra Radar fields', () => {
    const s = real();
    expect(s.schemaVersion).toBe(RADAR_SCHEMA_VERSION);
    expect(s.payload.players).toHaveLength(10);
    expect(s.payload.grenades.some((g) => g.effectTimeSeconds !== null)).toBe(true);
    expect(s.payload.grenades.some((g) => g.flames.length > 0)).toBe(true);
    expect(radarSnapshotSchema.safeParse({ ...s, schemaVersion: 1 }).success).toBe(false);
    const malformed = structuredClone(s);
    delete (malformed.payload.players[0] as Partial<(typeof malformed.payload.players)[number]>)
      .health;
    expect(radarSnapshotSchema.safeParse(malformed).success).toBe(false);
    expect(
      radarSnapshotSchema.safeParse({ ...s, payload: { ...s.payload, futurePosition: [] } })
        .success,
    ).toBe(false);
  });
  it('encodes carried and planting C4 ownership on the player marker only', () => {
    const snapshot = single();
    const playerId = snapshot.payload.players[0]!.sourcePlayerId;

    for (const state of ['carried', 'planting'] as const) {
      snapshot.payload.bomb = {
        state,
        sourcePlayerId: playerId,
        position: null,
      };
      expect(radarPlayerMarkerVisualRole(playerId, snapshot.payload.bomb)).toBe('bomb-carrier');
      expect(radarPlayerMarkerVisualRole('other-player', snapshot.payload.bomb)).toBe('side');
    }

    snapshot.payload.bomb = {
      state: 'dropped',
      sourcePlayerId: null,
      position: { x: -1000, y: 0, z: 0 },
    };
    expect(radarPlayerMarkerVisualRole(playerId, snapshot.payload.bomb)).toBe('side');
    expect(radarPlayerMarkerVisualRole(playerId, null)).toBe('side');
  });

  it('keeps procedural effect geometry deterministic and bounded', () => {
    const a = smokeLobes('smoke-188', 30);
    const b = smokeLobes('smoke-188', 30);
    const c = smokeLobes('smoke-202', 30);
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
    expect(a).toHaveLength(9);
    expect(a.every((lobe) => lobe.radius > 0 && lobe.radius <= 30)).toBe(true);

    const contour = smokeContour('smoke-188', 30);
    expect(contour).toHaveLength(18);
    expect(
      contour.every(
        (point) => Math.hypot(point.x, point.y) >= 24 && Math.hypot(point.x, point.y) <= 33,
      ),
    ).toBe(true);
    expect(
      effectCentroid([
        { x: 0, y: 2 },
        { x: 2, y: 0 },
      ]),
    ).toEqual({ x: 1, y: 1 });
    expect(effectCentroid([])).toBeNull();
  });

  it('uses official side-appropriate assets for airborne firebombs', () => {
    expect(grenadeIcon('firebomb', 'CT')).toContain('/utility/incgrenade.');
    expect(grenadeIcon('firebomb', 'T')).toContain('/utility/molotov.');
    expect(grenadeIcon('firebomb', 'unknown')).toBeNull();
    expect(grenadeIcon('smoke', 'CT')).toContain('/utility/smokegrenade.');
  });

  it('keeps a moving smoke projectile airborne when effecttime is zero', () => {
    const source = single().payload.grenades[0]!;
    const movingSmoke = {
      ...source,
      kind: 'smoke' as const,
      velocity: { x: 25, y: 0, z: 0 },
      effectTimeSeconds: 0,
    };
    const stationarySmoke = {
      ...movingSmoke,
      velocity: { x: 0, y: 0, z: 0 },
      effectTimeSeconds: 0.2,
    };

    expect(radarUtilityPhase(movingSmoke)).toBe('projectile');
    expect(isActiveSmoke(movingSmoke)).toBe(false);
    expect(
      radarUtilityPhase({
        ...movingSmoke,
        velocity: { x: 20.557, y: -5.244, z: -8.604 },
        lifetimeSeconds: 17.611,
        effectTimeSeconds: 15.156,
      }),
    ).toBe('effect');
    expect(radarUtilityPhase(stationarySmoke)).toBe('effect');
    expect(isActiveSmoke(stationarySmoke)).toBe(true);
    expect(radarUtilityPhase({ ...stationarySmoke, effectTimeSeconds: 20 })).toBe('terminal');
  });

  it('restores a mature smoke effect without replaying its enter animation', () => {
    const restored = single();
    restored.payload.grenades = [
      {
        ...restored.payload.grenades[0]!,
        kind: 'smoke',
        velocity: { x: 20.557, y: -5.244, z: -8.604 },
        lifetimeSeconds: 17.611,
        effectTimeSeconds: 15.156,
      },
    ];
    const model = new RadarPresentation();
    model.accept(restored, 1_000, true);

    expect(model.grenades.get('synthetic-projectile')).toMatchObject({
      phase: 'effect',
      phaseStartedAt: 1_000 - RADAR_PRESENTATION.smokeEnterMs,
    });
  });

  it('does not reset presentation history for runtime-only publications', () => {
    const source = single();
    source.payload.grenades = [
      {
        ...source.payload.grenades[0]!,
        kind: 'smoke',
        lifetimeSeconds: 5,
        effectTimeSeconds: 2.5,
      },
    ];
    const model = new RadarPresentation();
    model.accept(source, 1_000);
    const smoke = model.grenades.get('synthetic-projectile');
    const player = model.players.get(source.payload.players[0]!.sourcePlayerId);
    expect(smoke?.phase).toBe('effect');

    const runtimeOnly = structuredClone(source);
    runtimeOnly.channelSeq += 1;
    runtimeOnly.cursor.runtimeSeq += 1;
    model.accept(runtimeOnly, 2_000);

    expect(model.grenades.get('synthetic-projectile')).toBe(smoke);
    expect(model.players.get(source.payload.players[0]!.sourcePlayerId)).toBe(player);
    expect(model.snapshot).toEqual(toRadarViewFrame(runtimeOnly));
  });

  it('keeps a mature smoke steady when sample continuity resets', () => {
    const restored = single();
    restored.payload.grenades = [
      {
        ...restored.payload.grenades[0]!,
        kind: 'smoke',
        velocity: { x: 20.557, y: -5.244, z: -8.604 },
        lifetimeSeconds: 17.611,
        effectTimeSeconds: 15.156,
      },
    ];
    const model = new RadarPresentation();
    model.accept(restored, 1_000);
    const established = model.grenades.get('synthetic-projectile');
    expect(established).toMatchObject({
      phase: 'effect',
      phaseStartedAt: 1_000 - RADAR_PRESENTATION.smokeEnterMs,
    });
    const establishedAnchor = structuredClone(established?.target);
    const establishedPhaseStartedAt = established?.phaseStartedAt;

    const skipped = next(restored);
    skipped.cursor.programReceiveSequence = (restored.cursor.programReceiveSequence ?? 0) + 2;
    skipped.payload.grenades[0]!.position = { x: 1_000_000, y: 1_000_000, z: 0 };
    skipped.payload.grenades[0]!.effectTimeSeconds = 15.406;
    model.accept(skipped, 1_100);
    expect(model.grenades.get('synthetic-projectile')).toMatchObject({
      phase: 'effect',
      phaseStartedAt: establishedPhaseStartedAt,
      target: establishedAnchor,
    });
  });

  it('latches smoke from projectile to effect and never returns on residual velocity', () => {
    const before = single();
    before.payload.grenades = [
      {
        ...before.payload.grenades[0]!,
        kind: 'smoke',
        velocity: { x: 25, y: 0, z: 0 },
        effectTimeSeconds: 0,
      },
    ];
    const model = new RadarPresentation();
    model.accept(before, 0);
    expect(model.grenades.get('synthetic-projectile')?.phase).toBe('projectile');

    const started = next(before);
    started.payload.grenades[0]!.effectTimeSeconds = 0.2;
    model.accept(started, 100);
    const effectAnchor = model.grenades.get('synthetic-projectile')!;
    expect(effectAnchor).toMatchObject({
      phase: 'effect',
      phaseStartedAt: 100,
    });
    const anchoredTarget = effectAnchor.target;

    const missingPosition = next(started);
    missingPosition.payload.grenades[0]!.position = null;
    missingPosition.payload.grenades[0]!.effectTimeSeconds = 0.4;
    model.accept(missingPosition, 150);
    expect(model.grenades.get('synthetic-projectile')).toMatchObject({
      phase: 'effect',
      positionAvailable: true,
    });

    const residualVelocity = next(missingPosition);
    residualVelocity.payload.grenades[0]!.position = { ...started.payload.grenades[0]!.position! };
    residualVelocity.payload.grenades[0]!.velocity = { x: 25, y: 0, z: 0 };
    residualVelocity.payload.grenades[0]!.position.x += 2;
    residualVelocity.payload.grenades[0]!.effectTimeSeconds = 0.5;
    model.accept(residualVelocity, 200);
    expect(model.grenades.get('synthetic-projectile')).toMatchObject({
      phase: 'effect',
      positionAvailable: true,
      target: anchoredTarget,
    });

    const expired = next(residualVelocity);
    expired.payload.grenades[0]!.effectTimeSeconds = 20;
    model.accept(expired, 300);
    expect(model.grenades.get('synthetic-projectile')?.phase).toBe('terminal');
    expect(model.exits.get('synthetic-projectile')?.marker.phase).toBe('effect');
  });

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

  it('starts a fresh smoke lifecycle when the same entity id is reused after lifetime rewind', () => {
    const before = single();
    before.payload.grenades = [
      {
        ...before.payload.grenades[0]!,
        sourceEntityId: '160',
        kind: 'smoke',
        position: { x: -2071.5, y: 377.1, z: 75.9 },
        lifetimeSeconds: 19.11,
        effectTimeSeconds: 16.656,
      },
    ];

    const model = new RadarPresentation();
    model.accept(before, 0);
    const previous = model.grenades.get('160');
    expect(previous?.phase).toBe('effect');

    const reused = next(before);
    reused.payload.grenades[0]!.position = { x: -1200, y: 900, z: 75.9 };
    reused.payload.grenades[0]!.velocity = { x: 300, y: 0, z: 0 };
    reused.payload.grenades[0]!.lifetimeSeconds = 0.2;
    reused.payload.grenades[0]!.effectTimeSeconds = 0;
    model.accept(reused, 250);

    const fresh = model.grenades.get('160');
    expect(fresh).toMatchObject({
      phase: 'projectile',
      positionAvailable: true,
    });
    expect(fresh?.target).not.toEqual(previous?.target);
    expect(fresh?.phaseStartedAt).toBe(250);
  });

  it('uses two consecutive stationary authoritative displacements when velocity is missing', () => {
    const before = single();
    before.payload.grenades = [
      {
        ...before.payload.grenades[0]!,
        kind: 'smoke',
        velocity: null,
        effectTimeSeconds: 0,
      },
    ];
    const model = new RadarPresentation();
    model.accept(before, 0);

    const firstStationary = next(before);
    firstStationary.payload.grenades[0]!.position!.x += 1;
    model.accept(firstStationary, 100);
    expect(model.grenades.get('synthetic-projectile')).toMatchObject({
      phase: 'projectile',
      stationarySampleCount: 1,
    });

    const secondStationary = next(firstStationary);
    secondStationary.payload.grenades[0]!.position!.x += 1;
    model.accept(secondStationary, 200);
    expect(model.grenades.get('synthetic-projectile')).toMatchObject({
      phase: 'effect',
      stationarySampleCount: 0,
    });
  });

  it('draw state omits unknown life and freezes death position until alive again', () => {
    expect(radarPlayerMarkerKind('unknown')).toBeNull();
    expect(radarPlayerMarkerKind('dead')).toBe('dead');

    const before = single();
    before.payload.players[0]!.lifeState = 'alive';
    const playerId = before.payload.players[0]!.sourcePlayerId;
    const model = new RadarPresentation();
    model.accept(before, 0);

    const died = next(before);
    died.payload.players[0]!.lifeState = 'dead';
    died.payload.players[0]!.position!.x += 40;
    model.accept(died, 100);
    const marker = model.players.get(playerId)!;
    expect(marker.deathPosition).toEqual({ x: marker.target.x, y: marker.target.y });
    const deathPosition = marker.deathPosition;

    const corpseMoved = next(died);
    corpseMoved.payload.players[0]!.position!.x += 400;
    model.accept(corpseMoved, 200);
    model.tick(200, false);
    expect(marker.deathPosition).toEqual(deathPosition);
    expect({ x: marker.x, y: marker.y }).toEqual(deathPosition);

    const aliveAgain = next(corpseMoved);
    aliveAgain.payload.players[0]!.lifeState = 'alive';
    aliveAgain.payload.players[0]!.position!.x += 20;
    model.accept(aliveAgain, 300);
    expect(model.players.get(playerId)?.deathPosition).toBeNull();
  });

  it('falls back to the last target when the first authoritative dead sample has no position', () => {
    const before = single();
    before.payload.players[0]!.lifeState = 'alive';
    const playerId = before.payload.players[0]!.sourcePlayerId;
    const model = new RadarPresentation();
    model.accept(before, 0);
    const lastTarget = model.players.get(playerId)!.target;

    const died = next(before);
    died.payload.players[0]!.lifeState = 'dead';
    died.payload.players[0]!.position = null;
    model.accept(died, 100);
    expect(model.players.get(playerId)?.deathPosition).toEqual({
      x: lastTarget.x,
      y: lastTarget.y,
    });
  });

  it('hands a terminal firebomb off to flame evidence without a second projectile presentation', () => {
    // A presentation-only lifecycle edge: it changes no Program/Radar gameplay truth.
    const before = single();
    const owner = before.payload.players[0]!.sourcePlayerId;
    before.payload.grenades = [
      {
        ...before.payload.grenades[0]!,
        sourceEntityId: 'synthetic-firebomb',
        kind: 'firebomb',
        ownerSourceId: owner,
        velocity: { x: 100, y: 0, z: 0 },
      },
    ];
    const model = new RadarPresentation();
    model.accept(before, 0);
    expect([...model.grenades.values()][0]!.phase).toBe('projectile');

    const after = next(before);
    after.payload.grenades = [
      {
        ...after.payload.grenades[0]!,
        sourceEntityId: 'synthetic-inferno',
        kind: 'inferno',
        ownerSourceId: owner,
        position: null,
        velocity: null,
        flames: [
          { sourceFlameId: 'flame-a', position: { x: -1000, y: 0, z: 0 } },
          { sourceFlameId: 'flame-b', position: { x: -900, y: 0, z: 0 } },
        ],
      },
    ];
    model.accept(after, 100);

    expect(model.grenades.has('synthetic-firebomb')).toBe(false);
    expect(model.grenades.get('synthetic-inferno')?.phase).toBe('effect');
    expect(model.grenades.get('synthetic-inferno')?.target).toBeDefined();
    expect(model.exits.get('synthetic-firebomb')?.includeProjectileIcon).toBe(false);
    expect(
      [...model.grenades.values()].filter((marker) => marker.phase === 'projectile'),
    ).toHaveLength(0);
  });

  it('wraps angles along the shortest distance and eases movement without changing truth', () => {
    expect(shortestAngle(359, 1)).toBe(2);
    expect(shortestAngle(1, 359)).toBe(-2);
    const m = new RadarPresentation();
    const a = single();
    m.accept(a, 0);
    m.tick(0, false);
    const before = [...m.players.values()][0]!.x;
    const b = next(a);
    b.payload.players[0]!.position!.x += 100;
    m.accept(b, 100);
    m.tick(116, false);
    const p = [...m.players.values()][0]!;
    expect(p.x).toBeGreaterThan(before);
    expect(p.x).toBeLessThan(p.target.x);
    expect(b.payload.players[0]!.position!.x).toBe(-900);
  });
  it('interpolates between real-time samples and bounds prediction to 100 ms', () => {
    const model = new RadarPresentation();
    const a = single();
    model.accept(a, 0);
    model.tick(0, false);
    const before = [...model.players.values()][0]!;
    const b = next(a);
    b.payload.players[0]!.position!.x = -900;
    model.accept(b, 250);
    model.tick(375, false);

    const between = [...model.players.values()][0]!;
    const dx = between.target.x - between.previousTarget.x;
    const dy = between.target.y - between.previousTarget.y;
    const distanceSquared = dx * dx + dy * dy;
    const progress =
      ((between.x - between.previousTarget.x) * dx + (between.y - between.previousTarget.y) * dy) /
      distanceSquared;
    expect(before.target.x).toBe(between.previousTarget.x);
    expect(progress).toBeCloseTo(0.5, 1);

    model.tick(600, false);
    const atPredictionLimit = [...model.players.values()][0]!;
    const boundedX = atPredictionLimit.x;
    model.tick(900, false);
    expect([...model.players.values()][0]!.x).toBe(boundedX);
    expect(atPredictionLimit.x).toBeCloseTo(
      atPredictionLimit.target.x + atPredictionLimit.velocity.x * 100,
      6,
    );
  });
  it('snaps motion at a skipped source sample instead of bridging the gap', () => {
    const model = new RadarPresentation();
    const a = single();
    model.accept(a, 0);
    const gap = next(a);
    gap.cursor.programReceiveSequence = (gap.cursor.programReceiveSequence ?? 0) + 1;
    gap.payload.players[0]!.position!.x = -900;
    model.accept(gap, 250);
    const marker = [...model.players.values()][0]!;
    expect(marker.x).toBe(marker.target.x);
    expect(marker.interpolationDurationMs).toBe(0);
  });
  it('snaps teleports, resets HP/ammo baselines and does not infer on first sample', () => {
    const m = new RadarPresentation();
    const a = single();
    m.accept(a, 0);
    expect([...m.players.values()][0]!.shootingUntil).toBe(0);
    const b = next(a);
    b.payload.players[0]!.health = 80;
    b.payload.players[0]!.activeWeapon!.ammoClip = 29;
    m.accept(b, 100);
    expect([...m.players.values()][0]!.damageUntil).toBeGreaterThan(100);
    expect([...m.players.values()][0]!.shootingUntil).toBeGreaterThan(100);
    const c = next(b);
    c.payload.players[0]!.position!.x += 2000;
    c.payload.players[0]!.health = 70;
    m.accept(c, 200);
    const p = [...m.players.values()][0]!;
    expect(p.x).toBe(p.target.x);
    expect(p.damageUntil).toBe(0);
    expect(p.shootingUntil).toBe(0);
  });
  it('does not infer shots from reloads, equipment, weapon switches or evidence gaps', () => {
    for (const name of ['weapon_smokegrenade', 'weapon_knife', 'unknown']) {
      const m = new RadarPresentation();
      const a = single();
      a.payload.players[0]!.activeWeapon!.name = name;
      m.accept(a, 0);
      const b = next(a);
      b.payload.players[0]!.activeWeapon!.ammoClip = 29;
      m.accept(b, 100);
      expect([...m.players.values()][0]!.shootingUntil).toBe(0);
    }
    const m = new RadarPresentation();
    const a = single();
    m.accept(a, 0);
    const b = next(a);
    b.payload.players[0]!.activeWeapon!.ammoClip = 10;
    b.payload.players[0]!.activeWeapon!.state = 'reloading';
    m.accept(b, 100);
    expect([...m.players.values()][0]!.shootingUntil).toBe(0);
    const c = next(b);
    c.payload.players[0]!.health = 1;
    m.accept(c, 1000);
    expect([...m.players.values()][0]!.damageUntil).toBe(0);
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
  it('clears an airborne smoke path when effect evidence arrives without a position', () => {
    const model = new RadarPresentation();
    const a = single();
    a.payload.grenades[0]!.kind = 'smoke';
    model.accept(a, 0);
    const b = next(a);
    b.payload.grenades[0]!.position!.x += 2;
    model.accept(b, 10);
    expect([...model.grenades.values()][0]!.trail).toHaveLength(2);
    const effect = next(b);
    effect.payload.grenades[0]!.position = null;
    effect.payload.grenades[0]!.effectTimeSeconds = 1;
    model.accept(effect, 20);
    expect([...model.grenades.values()].every((marker) => marker.trail.length === 0)).toBe(true);
    expect(model.exits.size).toBe(0);
  });
  it('does not connect projectile history across Nuke floors', () => {
    const model = new RadarPresentation();
    const upper = single();
    upper.payload.mapName = 'de_nuke';
    model.accept(upper, 0);
    const flying = next(upper);
    flying.payload.grenades[0]!.position!.x += 2;
    model.accept(flying, 10);
    expect([...model.grenades.values()][0]!.trail).toHaveLength(2);
    const lower = next(flying);
    lower.payload.grenades[0]!.position!.z = -600;
    model.accept(lower, 20);
    expect([...model.grenades.values()][0]!.trail).toHaveLength(1);
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
  it('bounds real-observation trails and starts ID reuse with new history', () => {
    const m = new RadarPresentation();
    let s = single();
    for (let i = 0; i < 1000; i++) {
      s = next(s);
      s.payload.grenades[0]!.position!.x += 0.1;
      m.accept(s, i * 10);
      m.tick(i * 10, false);
    }
    const g = [...m.grenades.values()][0]!;
    expect(g.trail.length).toBeLessThanOrEqual(RADAR_PRESENTATION.trailPoints);
    expect(g.side).toBe('unknown');
    const gone = next(s);
    gone.payload.grenades = [];
    m.accept(gone, 10000);
    expect(m.grenades.size).toBe(0);
    expect(m.exits.size).toBe(1);
    const reused = next(gone);
    reused.payload.grenades = s.payload.grenades;
    m.accept(reused, 10100);
    expect([...m.grenades.values()][0]!.trail).toHaveLength(1);
    expect(m.exits.size).toBe(0);
  });
  it.each(['producer', 'generation', 'epoch', 'session', 'reconnect', 'stale', 'unsupported'])(
    'clears ephemeral state on %s',
    (kind) => {
      const m = new RadarPresentation();
      const a = single();
      m.accept(a, 0);
      const b = next(a);
      if (kind === 'producer') b.cursor.producerInstanceId += '-new';
      if (kind === 'generation') b.cursor.programSourceGeneration++;
      if (kind === 'epoch') b.cursor.mapEpoch++;
      if (kind === 'session') b.cursor.liveSessionId = 'new-session';
      if (kind === 'stale') b.payload.telemetryFreshness = 'stale';
      if (kind === 'unsupported') b.payload.mapName = 'unsupported';
      b.payload.players[0]!.health = 10;
      m.accept(b, 100, kind === 'reconnect');
      expect(m.exits.size).toBe(0);
      expect([...m.players.values()].every((p) => p.damageUntil === 0)).toBe(true);
      expect([...m.grenades.values()].every((g) => g.trail.length === 1)).toBe(true);
      if (kind === 'stale' || kind === 'unsupported') expect(m.players.size).toBe(0);
    },
  );
  it('selects focused floors while retaining both floors across floor changes', () => {
    const m = new RadarPresentation();
    const a = single();
    a.payload.mapName = 'de_nuke';
    a.payload.observedPlayerSourceId = a.payload.players[0]!.sourcePlayerId;
    m.accept(a, 0);
    expect(m.layer).toBe('upper');
    const b = next(a);
    b.payload.players[0]!.position!.z = -600;
    b.payload.players[0]!.health = 50;
    m.accept(b, 100);
    expect(m.layer).toBe('lower');
    expect([...m.players.values()][0]!.damageUntil).toBe(0);
    expect(m.grenades.size).toBe(1);
  });
  it('uses only effecttime, clamps remaining, and verifies real replay monotonicity', () => {
    expect(smokeRemaining(null)).toBeNull();
    expect(smokeRemaining(22)).toBe(0);
    expect(smokeRemaining(-1)).toBe(20);
    const smoke = real().payload.grenades.find((grenade) => grenade.kind === 'smoke');
    if (smoke === undefined) throw new Error('real replay fixture has no smoke grenade');
    expect(isActiveSmoke({ ...smoke, effectTimeSeconds: 19.9 })).toBe(true);
    expect(isActiveSmoke({ ...smoke, effectTimeSeconds: 20 })).toBe(false);
    const previous = new Map<string, number>();
    let comparisons = 0;
    for (const sample of fixtures.fixtures['bomb-plant'].samples)
      for (const g of sample.snapshot.payload.grenades) {
        if (g.kind !== 'smoke' || g.effectTimeSeconds === null) continue;
        const remaining = smokeRemaining(g.effectTimeSeconds)!;
        const before = previous.get(g.sourceEntityId);
        if (before !== undefined) {
          expect(remaining).toBeLessThanOrEqual(before);
          comparisons++;
        }
        previous.set(g.sourceEntityId, remaining);
      }
    expect(comparisons).toBeGreaterThan(0);
  });
  it('defaults to full map, bounds auto zoom and returns when no alive targets remain', () => {
    const m = new RadarPresentation();
    const s = single();
    m.accept(s, 0);
    m.tick(0, false);
    m.tick(100, false);
    expect(m.zoom.scale).toBe(1);
    for (let i = 1; i <= 100; i++) m.tick(i * 16, true);
    expect(m.zoom.scale).toBeGreaterThan(1);
    expect(m.zoom.scale).toBeLessThanOrEqual(RADAR_PRESENTATION.maxZoom);
    const b = next(s);
    b.payload.players = [];
    m.accept(b, 1700);
    m.tick(1700, true);
    expect(m.zoom.scale).toBe(1);
  });

  it('correctly handles planting C4 presentation authoritative single representation', () => {
    const s = single();
    s.payload.bomb = {
      state: 'planting',
      position: { x: -1000, y: 0, z: 0 },
      sourcePlayerId: s.payload.players[0]!.sourcePlayerId,
    };
    const p = new RadarPresentation();
    p.accept(s, 1000);
    expect(p.players.has(s.payload.players[0]!.sourcePlayerId)).toBe(true);
    expect(s.payload.bomb.state === 'planting' && s.payload.bomb.sourcePlayerId !== null).toBe(
      true,
    );
  });

  it('fails closed with neutral presentation on unresolved layers for Nuke, Train, and Vertigo', () => {
    for (const mapName of ['de_nuke', 'de_train', 'de_vertigo']) {
      const s = single();
      s.payload.mapName = mapName;
      const upperZ = mapName === 'de_nuke' ? -400 : mapName === 'de_vertigo' ? 12000 : 100;
      const lowerZ = mapName === 'de_nuke' ? -1000 : mapName === 'de_vertigo' ? 11500 : -200;
      s.payload.players = [
        {
          ...s.payload.players[0]!,
          sourcePlayerId: 'p-upper',
          position: { x: 0, y: 0, z: upperZ },
        },
        {
          ...s.payload.players[0]!,
          sourcePlayerId: 'p-lower',
          position: { x: 0, y: 0, z: lowerZ },
        },
      ];
      const p = new RadarPresentation();
      p.accept(s, 1000);
      expect(p.layer).toBe('unknown');
    }
  });

  it('clears unsupported local maps at the adapter boundary', () => {
    const s = single();
    s.payload.mapName = 'de_unsupported_test_map';
    const p = new RadarPresentation();
    p.accept(s, 1000);
    expect(toRadarViewFrame(s)).toBeNull();
    expect(p.snapshot).toBeNull();
    expect(p.players.size).toBe(0);
  });
});

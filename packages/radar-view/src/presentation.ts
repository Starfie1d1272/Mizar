import { getRadarArtwork, utilityIcon, type RadarArtwork } from './assets.js';
import type {
  RadarViewFrame,
  RadarPlayer,
  RadarUtility,
  RadarBomb,
  RadarPoint,
  RadarLayer,
} from './types.js';

// Issue #34 freezes the broadcast smoke presentation at 20 s. This is not a
// server cvar or a claim about the exact volumetric visibility/collision field.
export const SMOKE_PRESENTATION_DURATION_SECONDS = 20;
export const RADAR_PRESENTATION = Object.freeze({
  correctionSmoothingMs: 80,
  maxExtrapolationMs: 100,
  utilityVelocityEpsilon: 0.01,
  smokeStationaryWorldThreshold: 6,
  smokeStationarySamples: 2,
  teleportBaseWorld: 160,
  teleportSpeedWorldPerSecond: 1100,
  sampleGapMs: 500,
  trailPoints: 64,
  projectileExitMs: 180,
  smokeEnterMs: 160,
  smokeExitMs: 200,
  infernoEnterMs: 120,
  infernoExitMs: 160,
  exitMs: 180,
  damageMs: 220,
  shootingMs: 110,
  maxPlayers: 64,
  maxGrenades: 128,
  maxFlames: 512,
  zoomPadding: 0.12,
  maxZoom: 2.5,
});

type Player = RadarPlayer;
type Bomb = RadarBomb | null;
type Grenade = RadarUtility;
type Vector = NonNullable<Player['position']>;
export type RadarSide = Player['side'];
export type RadarUtilityPhase = 'projectile' | 'effect' | 'terminal';
export interface TrailPoint {
  x: number;
  y: number;
  at: number;
}
/** Fixed-cost simplification: preserve endpoints and remove the least geometric
 * information first. Distance to the segment (not its infinite line) retains
 * reversals as well as corners. No synthetic points or future positions. */
function compressTrail(trail: TrailPoint[]): void {
  while (trail.length > RADAR_PRESENTATION.trailPoints) {
    let remove = 1;
    let smallestError = Number.POSITIVE_INFINITY;
    for (let index = 1; index < trail.length - 1; index++) {
      const a = trail[index - 1]!;
      const b = trail[index]!;
      const c = trail[index + 1]!;
      const dx = c.x - a.x;
      const dy = c.y - a.y;
      const length = dx * dx + dy * dy;
      const t =
        length === 0 ? 0 : Math.max(0, Math.min(1, ((b.x - a.x) * dx + (b.y - a.y) * dy) / length));
      const error = (b.x - a.x - t * dx) ** 2 + (b.y - a.y - t * dy) ** 2;
      if (error < smallestError) {
        smallestError = error;
        remove = index;
      }
    }
    trail.splice(remove, 1);
  }
}

export interface Motion {
  x: number;
  y: number;
  angle: number;
  previousTarget: { readonly x: number; readonly y: number };
  target: RadarPoint;
  targetAngle: number;
  world: Vector;
  previousSampleAt: number;
  sampledAt: number;
  velocity: { readonly x: number; readonly y: number };
  interpolationDurationMs: number;
}
export interface PlayerMarker extends Motion {
  source: Player;
  damageUntil: number;
  shootingUntil: number;
  deathPosition: { readonly x: number; readonly y: number } | null;
}
export interface GrenadeMarker extends Motion {
  source: Grenade;
  side: RadarSide;
  trail: TrailPoint[];
  phase: RadarUtilityPhase;
  phaseStartedAt: number;
  iconUrl: string | null;
  previousPosition: Vector;
  stationarySampleCount: number;
  positionAvailable: boolean;
}
export interface GrenadeExit {
  marker: GrenadeMarker;
  startedAt: number;
  until: number;
  durationMs: number;
  includeProjectileIcon: boolean;
}

export function shortestAngle(from: number, to: number): number {
  return ((((to - from + 540) % 360) + 360) % 360) - 180;
}
export function smokeRemaining(effectTimeSeconds: number | null): number | null {
  return effectTimeSeconds === null
    ? null
    : Math.max(
        0,
        Math.min(
          SMOKE_PRESENTATION_DURATION_SECONDS,
          SMOKE_PRESENTATION_DURATION_SECONDS - effectTimeSeconds,
        ),
      );
}

export function radarBoundary(snapshot: RadarViewFrame): string {
  return JSON.stringify([snapshot.boundary, snapshot.mapName, snapshot.calibrationRevision]);
}
export function onLayer(point: RadarPoint, layer: RadarLayer): boolean {
  if (point.outOfBounds) return false;
  if (layer === 'unknown') return false;
  return point.layer === layer || point.layer === 'single';
}
export function isMultiLayerGeometry(geometry: RadarArtwork): boolean {
  return geometry.layers.length > 1;
}

export function layerOpacity(point: RadarPoint, primary: RadarLayer): number {
  if (point.layer === 'unknown' || primary === 'unknown') return 0.76;
  return point.layer === primary ? 0.88 : 0.62;
}
export function radarPlayerMarkerKind(lifeState: Player['lifeState']): 'alive' | 'dead' | null {
  if (lifeState === 'alive') return 'alive';
  if (lifeState === 'dead') return 'dead';
  return null;
}

export function radarPlayerMarkerVisualRole(
  sourcePlayerId: string,
  bomb: Pick<NonNullable<Bomb>, 'state' | 'sourcePlayerId'> | null,
): 'side' | 'bomb-carrier' {
  return bomb?.sourcePlayerId === sourcePlayerId &&
    (bomb.state === 'carried' || bomb.state === 'planting')
    ? 'bomb-carrier'
    : 'side';
}
function direction(player: Player): number {
  const d = player.lifeState === 'alive' ? player.facing : null;
  return d ? (Math.atan2(d.y, d.x) * 180) / Math.PI : 0;
}
function discontinuous(
  previous: Motion,
  world: Vector,
  point: RadarPoint,
  now: number,
  unitRadius: number,
  sampleGapMs: number,
): boolean {
  const dt = now - previous.sampledAt;
  const distance = Math.hypot(
    world.x - previous.world.x,
    world.y - previous.world.y,
    (world.z ?? 0) - (previous.world.z ?? 0),
  );
  return (
    dt < 0 ||
    dt > sampleGapMs ||
    previous.target.layer !== point.layer ||
    distance >
      unitRadius *
        (RADAR_PRESENTATION.teleportBaseWorld +
          (RADAR_PRESENTATION.teleportSpeedWorldPerSecond * dt) / 1000)
  );
}
function motion(world: Vector, point: RadarPoint, angle: number, now: number): Motion {
  return {
    x: point.x,
    y: point.y,
    angle,
    previousTarget: { x: point.x, y: point.y },
    target: point,
    targetAngle: angle,
    world,
    previousSampleAt: now,
    sampledAt: now,
    velocity: { x: 0, y: 0 },
    interpolationDurationMs: 0,
  };
}
function retarget(
  previous: Motion,
  world: Vector,
  point: RadarPoint,
  angle: number,
  now: number,
): Motion {
  const sampleIntervalMs = Math.max(0, now - previous.sampledAt);
  return {
    ...previous,
    previousTarget: { x: previous.x, y: previous.y },
    target: point,
    targetAngle: angle,
    world,
    previousSampleAt: previous.sampledAt,
    sampledAt: now,
    velocity:
      sampleIntervalMs > 0
        ? {
            x: (point.x - previous.target.x) / sampleIntervalMs,
            y: (point.y - previous.target.y) / sampleIntervalMs,
          }
        : { x: 0, y: 0 },
    interpolationDurationMs: Math.max(RADAR_PRESENTATION.correctionSmoothingMs, sampleIntervalMs),
  };
}
function isShooting(before: Player, after: Player): boolean {
  const a = before.activeWeapon;
  const b = after.activeWeapon;
  if (
    !a ||
    !b ||
    a.name === null ||
    a.name !== b.name ||
    a.state !== 'active' ||
    b.state !== 'active' ||
    a.ammoClip === null ||
    b.ammoClip === null ||
    b.ammoClip < 0 ||
    b.ammoClip >= a.ammoClip
  )
    return false;
  return a.firearm && b.firearm;
}
export function grenadeIcon(kind: string | null, side: RadarSide = 'unknown'): string | null {
  const name =
    kind === 'firebomb'
      ? side === 'CT'
        ? 'weapon_incgrenade'
        : side === 'T'
          ? 'weapon_molotov'
          : null
      : (
          {
            smoke: 'weapon_smokegrenade',
            flashbang: 'weapon_flashbang',
            frag: 'weapon_hegrenade',
            hegrenade: 'weapon_hegrenade',
            decoy: 'weapon_decoy',
          } as Record<string, string>
        )[kind ?? ''];
  if (!name) return null;
  return utilityIcon(name);
}
export function radarUtilityPhase(
  g: Pick<Grenade, 'kind' | 'moving' | 'position' | 'effectTimeSeconds' | 'flames'>,
): RadarUtilityPhase {
  // Public projection has no velocity. A positioned utility may be displayed, but
  // absence of velocity cannot prove terminal state or an impact animation.
  const moving = g.moving === undefined ? g.position !== null : g.moving === true;
  switch (g.kind) {
    case 'smoke':
      if (
        g.effectTimeSeconds !== null &&
        g.effectTimeSeconds >= SMOKE_PRESENTATION_DURATION_SECONDS
      )
        return 'terminal';
      // effectTime is authoritative lifecycle evidence. Real GSI captures can retain a
      // stale non-zero grenade velocity long after the smoke has settled; this matters
      // especially on seek/reconnect where renderer-local phase history is intentionally reset.
      if (g.effectTimeSeconds !== null && g.effectTimeSeconds > 0) return 'effect';
      return 'projectile';
    case 'firebomb':
      return moving ? 'projectile' : 'terminal';
    case 'inferno':
      return g.flames.length > 0 ? 'effect' : 'terminal';
    default:
      return moving ? 'projectile' : 'terminal';
  }
}
export function isActiveSmoke(g: Parameters<typeof radarUtilityPhase>[0]): boolean {
  return g.kind === 'smoke' && radarUtilityPhase(g) === 'effect';
}

function worldDisplacement(before: Vector, after: Vector): number {
  return Math.hypot(after.x - before.x, after.y - before.y, (after.z ?? 0) - (before.z ?? 0));
}

function transitionSmokePhase(
  previousPhase: RadarUtilityPhase,
  source: Grenade,
  stationarySampleCount: number,
): RadarUtilityPhase {
  if (previousPhase === 'terminal') return 'terminal';
  if (
    source.effectTimeSeconds !== null &&
    source.effectTimeSeconds >= SMOKE_PRESENTATION_DURATION_SECONDS
  )
    return 'terminal';
  if (previousPhase === 'effect') return 'effect';
  if (
    (source.effectTimeSeconds !== null && source.effectTimeSeconds > 0) ||
    stationarySampleCount >= RADAR_PRESENTATION.smokeStationarySamples
  )
    return 'effect';
  return 'projectile';
}

// RC14 real captures contain 2–13 ms lifetime regressions within the same
// entity/effect. One 64 Hz source tick is quantization jitter, not ID reuse.
const SMOKE_LIFETIME_JITTER_SECONDS = 1 / 64;

function lifetimeRestarted(previous: Grenade, source: Grenade): boolean {
  return (
    previous.lifetimeSeconds !== null &&
    source.lifetimeSeconds !== null &&
    previous.lifetimeSeconds - source.lifetimeSeconds >
      (source.kind === 'smoke' ? SMOKE_LIFETIME_JITTER_SECONDS : 0)
  );
}

function sameSmokeLifecycle(old: GrenadeMarker | undefined, source: Grenade): old is GrenadeMarker {
  return (
    source.kind === 'smoke' &&
    old?.source.kind === 'smoke' &&
    old.source.sourceEntityId === source.sourceEntityId &&
    !lifetimeRestarted(old.source, source)
  );
}

function exitDuration(marker: GrenadeMarker): number {
  if (marker.phase === 'projectile') return RADAR_PRESENTATION.projectileExitMs;
  if (marker.phase !== 'effect') return 0;
  return marker.source.kind === 'smoke'
    ? RADAR_PRESENTATION.smokeExitMs
    : RADAR_PRESENTATION.infernoExitMs;
}

function presentationPosition(grenade: Grenade): Vector | null {
  if (grenade.position !== null) return grenade.position;
  if (grenade.kind !== 'inferno' || grenade.flames.length === 0) return null;
  let x = 0;
  let y = 0;
  let z = 0;
  for (const flame of grenade.flames) {
    x += flame.position.x;
    y += flame.position.y;
    z += flame.position.z ?? 0;
  }
  return {
    x: x / grenade.flames.length,
    y: y / grenade.flames.length,
    z: z / grenade.flames.length,
    layer: grenade.flames[0]!.position.layer,
  };
}

/** All history is local presentation, bounded, and disposable; never a domain reducer. */
export class RadarPresentation {
  snapshot: RadarViewFrame | null = null;
  geometry: RadarArtwork | null = null;
  layer: RadarLayer = 'unknown';
  unsupportedMap: string | null = null;
  diagnosticReason: 'unsupported-map' | 'stale' | 'awaiting' | null = 'awaiting';
  readonly players = new Map<string, PlayerMarker>();
  readonly grenades = new Map<string, GrenadeMarker>();
  readonly exits = new Map<string, GrenadeExit>();
  zoom = { x: 0.5, y: 0.5, scale: 1 };
  private boundary: string | null = null;
  private lastFrame: number | null = null;
  private acceptedAt: number | null = null;
  private bombTerminalAt: number | null = null;

  private beginExit(
    id: string,
    marker: GrenadeMarker,
    now: number,
    includeProjectileIcon = true,
  ): void {
    const durationMs = exitDuration(marker);
    if (durationMs <= 0) return;
    this.exits.set(id, {
      marker,
      startedAt: now,
      until: now + durationMs,
      durationMs,
      includeProjectileIcon,
    });
  }

  reset(reason: 'unsupported-map' | 'stale' | 'awaiting' | null = null): void {
    this.snapshot = null;
    this.geometry = null;
    this.layer = 'unknown';
    this.players.clear();
    this.grenades.clear();
    this.exits.clear();
    this.zoom = { x: 0.5, y: 0.5, scale: 1 };
    this.boundary = null;
    this.lastFrame = null;
    this.acceptedAt = null;
    this.bombTerminalAt = null;
    if (reason !== null) {
      this.diagnosticReason = reason;
    }
  }

  accept(snapshot: RadarViewFrame | null, now: number, reconnect = false): void {
    if (!snapshot) {
      this.unsupportedMap = null;
      this.reset('awaiting');
      return;
    }
    const geometry = getRadarArtwork(snapshot.mapName);
    if (
      !geometry ||
      geometry.calibrationRevision !== snapshot.calibrationRevision ||
      geometry.layers.length !== snapshot.layers.length ||
      !geometry.layers.every((layer) => snapshot.layers.includes(layer))
    ) {
      this.unsupportedMap = snapshot.mapName;
      this.reset('unsupported-map');
      return;
    }
    this.unsupportedMap = null;
    this.diagnosticReason = null;
    const boundary = radarBoundary(snapshot);
    const layer = snapshot.activeLayer ?? 'unknown';
    const sameBoundary = this.boundary === boundary;
    if (!reconnect && sameBoundary && this.snapshot && snapshot.sequence <= this.snapshot.sequence)
      return;
    const runtimeOnlyPublication =
      !reconnect &&
      sameBoundary &&
      snapshot.sampleSequence != null &&
      this.snapshot?.sampleSequence === snapshot.sampleSequence;
    if (runtimeOnlyPublication) {
      this.snapshot = snapshot;
      return;
    }
    const previousSequence = this.snapshot?.sampleSequence;
    const nextSequence = snapshot.sampleSequence;
    const skippedSample =
      previousSequence !== undefined &&
      previousSequence !== null &&
      nextSequence !== undefined &&
      nextSequence !== null &&
      nextSequence !== previousSequence + 1;
    const sampleGapMs = snapshot.sampleGapMs ?? RADAR_PRESENTATION.sampleGapMs;
    const sampleGap = this.acceptedAt !== null && now - this.acceptedAt > sampleGapMs;
    const hardBoundaryReset = reconnect || !sameBoundary;
    const samplingDiscontinuity = skippedSample || sampleGap;
    const restoringPresentationHistory = hardBoundaryReset || samplingDiscontinuity;
    const preservedSmokeEffects =
      samplingDiscontinuity && !hardBoundaryReset
        ? [...this.grenades.entries()].filter(
            ([, marker]) => marker.source.kind === 'smoke' && marker.phase === 'effect',
          )
        : [];
    if (restoringPresentationHistory) {
      this.reset();
      for (const [id, marker] of preservedSmokeEffects) this.grenades.set(id, marker);
    }
    const previousBomb = this.snapshot?.payload.bomb?.state;
    this.boundary = boundary;
    this.geometry = geometry;
    this.layer = layer;
    this.acceptedAt = now;
    const currentPlayers = new Set<string>();
    for (const source of snapshot.payload.players.slice(0, RADAR_PRESENTATION.maxPlayers)) {
      const point = source.position;
      const id = source.sourcePlayerId;
      const old = this.players.get(id);
      const projectedPoint = point && !point.outOfBounds ? point : null;
      if (source.lifeState === 'dead') {
        if (!snapshot.payload.retainEffectAnchors && !projectedPoint) continue;
        const deathPosition =
          old?.source.lifeState === 'dead' && old.deathPosition !== null
            ? old.deathPosition
            : projectedPoint
              ? { x: projectedPoint.x, y: projectedPoint.y }
              : old
                ? { x: old.target.x, y: old.target.y }
                : null;
        if (deathPosition === null) continue;
        currentPlayers.add(id);
        if (old?.source.lifeState === 'dead' && old.deathPosition !== null) {
          this.players.set(id, { ...old, source, deathPosition: old.deathPosition });
          continue;
        }
        const world = source.position ?? old?.world;
        const target = projectedPoint ?? old?.target;
        if (world === undefined || target === undefined) continue;
        const baseMotion = old ?? motion(world, target, direction(source), now);
        this.players.set(id, {
          ...baseMotion,
          source,
          x: deathPosition.x,
          y: deathPosition.y,
          previousTarget: { ...deathPosition },
          target,
          targetAngle: baseMotion.angle,
          world,
          previousSampleAt: now,
          sampledAt: now,
          velocity: { x: 0, y: 0 },
          interpolationDurationMs: 0,
          damageUntil: 0,
          shootingUntil: 0,
          deathPosition,
        });
        continue;
      }
      if (!source.position || !projectedPoint) continue;
      currentPlayers.add(id);
      const angle = direction(source);
      const continuous =
        old &&
        !discontinuous(
          old,
          source.position,
          projectedPoint,
          now,
          geometry.unitRadius,
          sampleGapMs,
        ) &&
        old.source.lifeState === source.lifeState &&
        old.source.side === source.side &&
        snapshot.payload.playersComplete !== false &&
        this.snapshot?.payload.playersComplete !== false;
      const next: PlayerMarker = {
        ...(continuous
          ? retarget(old, source.position, projectedPoint, angle, now)
          : motion(source.position, projectedPoint, angle, now)),
        source,
        target: projectedPoint,
        targetAngle: angle,
        world: source.position,
        sampledAt: now,
        damageUntil: continuous ? old.damageUntil : 0,
        shootingUntil: continuous ? old.shootingUntil : 0,
        deathPosition: null,
      };
      if (
        continuous &&
        old.source.health != null &&
        source.health != null &&
        source.health < old.source.health
      )
        next.damageUntil = now + RADAR_PRESENTATION.damageMs;
      if (continuous && source.lifeState === 'alive' && isShooting(old.source, source))
        next.shootingUntil = now + RADAR_PRESENTATION.shootingMs;
      this.players.set(id, next);
    }
    for (const id of this.players.keys()) if (!currentPlayers.has(id)) this.players.delete(id);
    const infernoEvidenceOwners = new Set(
      snapshot.payload.grenades
        .filter((grenade) => grenade.kind === 'inferno' && grenade.flames.length > 0)
        .map((grenade) => grenade.ownerSourceId)
        .filter((owner): owner is string => owner !== null),
    );
    const currentGrenades = new Set<string>();
    const invalidGrenades = new Set<string>();
    for (const source of snapshot.payload.grenades.slice(0, RADAR_PRESENTATION.maxGrenades)) {
      const id = source.sourceEntityId;
      const old = this.grenades.get(id);
      const smokeLifecycleContinuous = sameSmokeLifecycle(old, source);
      const owner = snapshot.payload.players.find((p) => p.sourcePlayerId === source.ownerSourceId);
      const smokeSide =
        smokeLifecycleContinuous && old.side !== 'unknown'
          ? old.side
          : (owner?.side ?? (smokeLifecycleContinuous ? old.side : 'unknown'));

      // A settled smoke is a stationary area effect, not a moving grenade marker.
      // Once its effect anchor exists, later source position/velocity cannot move,
      // hide, or restart it. Only lifecycle phase and metadata continue to update.
      if (
        smokeLifecycleContinuous &&
        old.phase === 'effect' &&
        (source.position !== null || snapshot.payload.retainEffectAnchors)
      ) {
        currentGrenades.add(id);
        const phase = transitionSmokePhase(old.phase, source, 0);
        if (phase !== old.phase) this.beginExit(id, old, now);
        const activeExit = this.exits.get(id);
        if (activeExit && activeExit.marker.phase === phase) this.exits.delete(id);
        this.grenades.set(id, {
          ...old,
          source,
          side: smokeSide,
          phase,
          iconUrl: grenadeIcon(source.kind, smokeSide),
          trail: [],
          stationarySampleCount: 0,
          positionAvailable: phase === 'effect' ? old.positionAvailable : false,
        });
        continue;
      }

      const world = presentationPosition(source);
      if (world === null) {
        if (!snapshot.payload.retainEffectAnchors || old?.phase !== 'effect') {
          invalidGrenades.add(id);
          this.exits.delete(id);
        }
        if (snapshot.payload.retainEffectAnchors && sameSmokeLifecycle(old, source)) {
          currentGrenades.add(id);
          const phase = transitionSmokePhase(old.phase, source, 0);
          if (old.phase !== phase && old.phase !== 'projectile') this.beginExit(id, old, now);
          const activeExit = this.exits.get(id);
          if (activeExit && activeExit.marker.phase === phase) this.exits.delete(id);
          this.grenades.set(id, {
            ...old,
            source,
            phase,
            phaseStartedAt: old.phase === phase ? old.phaseStartedAt : now,
            stationarySampleCount: 0,
            // An established smoke is stationary presentation truth. Real captures can
            // omit one grenade position sample; retain the last trusted spatial anchor
            // instead of blinking the mature effect off for that frame.
            positionAvailable: phase === 'effect' ? old.positionAvailable : false,
            trail: [],
          });
        }
        continue;
      }
      const point = world;
      if (point.outOfBounds) {
        invalidGrenades.add(id);
        continue;
      }
      currentGrenades.add(id);
      const side = smokeSide;

      // Motion continuity answers only "may this moving marker interpolate?".
      // It does not own utility lifecycle or effect entrance timing.
      const motionContinuous =
        old &&
        old.source.kind === source.kind &&
        old.source.ownerSourceId === source.ownerSourceId &&
        old.positionAvailable &&
        !discontinuous(old, world, point, now, geometry.unitRadius, sampleGapMs) &&
        !lifetimeRestarted(old.source, source);
      const stationarySampleCount =
        snapshot.payload.retainEffectAnchors &&
        source.kind === 'smoke' &&
        motionContinuous &&
        old.phase === 'projectile' &&
        source.effectTimeSeconds !== null &&
        worldDisplacement(old.previousPosition, world) <=
          RADAR_PRESENTATION.smokeStationaryWorldThreshold * geometry.unitRadius
          ? old.stationarySampleCount + 1
          : 0;
      const phase = smokeLifecycleContinuous
        ? transitionSmokePhase(old.phase, source, stationarySampleCount)
        : radarUtilityPhase(source);
      const phaseContinuous =
        old !== undefined &&
        old.source.kind === source.kind &&
        old.phase === phase &&
        (source.kind !== 'smoke' || smokeLifecycleContinuous);

      if (old && old.phase !== phase) {
        const infernoHandoff =
          old.source.kind === 'firebomb' &&
          old.phase === 'projectile' &&
          source.ownerSourceId !== null &&
          infernoEvidenceOwners.has(source.ownerSourceId);
        this.beginExit(id, old, now, !infernoHandoff);
      }
      const activeExit = this.exits.get(id);
      if (activeExit && activeExit.marker.phase === phase) this.exits.delete(id);

      const trail =
        motionContinuous && old.phase === 'projectile' && phase === 'projectile'
          ? old.trail.slice()
          : [];
      // Keep every distinct observation before simplifying; sampling by time or
      // distance alone can erase a bounce that occurs between retained samples.
      const lastTrailPoint = trail.at(-1);
      if (
        phase === 'projectile' &&
        (!lastTrailPoint || point.x !== lastTrailPoint.x || point.y !== lastTrailPoint.y)
      ) {
        trail.push({ x: point.x, y: point.y, at: now });
      }
      compressTrail(trail);
      const restoredEffectEnterMs =
        restoringPresentationHistory && phase === 'effect'
          ? source.kind === 'smoke'
            ? RADAR_PRESENTATION.smokeEnterMs
            : source.kind === 'inferno'
              ? RADAR_PRESENTATION.infernoEnterMs
              : 0
          : 0;
      this.grenades.set(id, {
        ...(source.kind === 'smoke' && phase === 'effect'
          ? motion(world, point, 0, now)
          : motionContinuous
            ? retarget(old, world, point, 0, now)
            : motion(world, point, 0, now)),
        source,
        side,
        phase,
        phaseStartedAt:
          restoredEffectEnterMs > 0
            ? now - restoredEffectEnterMs
            : phaseContinuous
              ? old.phaseStartedAt
              : now,
        iconUrl: grenadeIcon(source.kind, side),
        trail,
        previousPosition: world,
        stationarySampleCount: phase === 'projectile' ? stationarySampleCount : 0,
        positionAvailable: true,
        target: point,
        targetAngle: 0,
        world,
        sampledAt: now,
      });
    }
    for (const [id, marker] of this.grenades)
      if (!currentGrenades.has(id)) {
        const infernoHandoff =
          marker.source.kind === 'firebomb' &&
          marker.phase === 'projectile' &&
          marker.source.ownerSourceId !== null &&
          infernoEvidenceOwners.has(marker.source.ownerSourceId);
        if (!invalidGrenades.has(id)) this.beginExit(id, marker, now, !infernoHandoff);
        else this.exits.delete(id);
        this.grenades.delete(id);
      }
    while (this.exits.size > RADAR_PRESENTATION.maxGrenades)
      this.exits.delete(this.exits.keys().next().value!);
    const bombState = snapshot.payload.bomb?.state;
    if ((bombState === 'defused' || bombState === 'exploded') && bombState !== previousBomb)
      this.bombTerminalAt = now;
    if (bombState !== 'defused' && bombState !== 'exploded') this.bombTerminalAt = null;
    this.snapshot = snapshot;
  }

  bombVisible(now: number): boolean {
    return this.bombTerminalAt === null || now - this.bombTerminalAt < RADAR_PRESENTATION.exitMs;
  }

  tick(now: number, autoZoom: boolean, reducedMotion = false): void {
    const dt = this.lastFrame === null ? 0 : Math.max(0, Math.min(100, now - this.lastFrame));
    this.lastFrame = now;
    const mix = reducedMotion ? 1 : 1 - Math.exp(-dt / 180);
    if (reducedMotion) this.exits.clear();
    const updateMotion = (marker: Motion) => {
      if (reducedMotion) {
        marker.x = marker.target.x;
        marker.y = marker.target.y;
        marker.angle = marker.targetAngle;
        return;
      }
      const elapsedMs = Math.max(0, now - marker.sampledAt);
      const intervalMs = marker.interpolationDurationMs;
      if (intervalMs > 0 && elapsedMs < intervalMs) {
        const progress = elapsedMs / intervalMs;
        marker.x = marker.previousTarget.x + (marker.target.x - marker.previousTarget.x) * progress;
        marker.y = marker.previousTarget.y + (marker.target.y - marker.previousTarget.y) * progress;
        marker.angle +=
          shortestAngle(marker.angle, marker.targetAngle) *
          Math.min(1, Math.max(0, Math.min(1, dt / RADAR_PRESENTATION.correctionSmoothingMs)));
      } else {
        const predictedMs = Math.min(
          RADAR_PRESENTATION.maxExtrapolationMs,
          Math.max(0, elapsedMs - intervalMs),
        );
        marker.x = marker.target.x + marker.velocity.x * predictedMs;
        marker.y = marker.target.y + marker.velocity.y * predictedMs;
        marker.angle = marker.targetAngle;
      }
    };
    for (const marker of this.players.values()) {
      if (marker.source.lifeState === 'dead') {
        if (marker.deathPosition !== null) {
          marker.x = marker.deathPosition.x;
          marker.y = marker.deathPosition.y;
        }
        continue;
      }
      updateMotion(marker);
    }
    for (const marker of this.grenades.values())
      if (marker.phase === 'projectile') updateMotion(marker);
    for (const [id, exit] of this.exits) if (now >= exit.until) this.exits.delete(id);
    let x = 0.5;
    let y = 0.5;
    let scale = 1;
    let minX = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    for (const player of this.players.values()) {
      if (player.source.lifeState !== 'alive') continue;
      minX = Math.min(minX, player.target.x);
      maxX = Math.max(maxX, player.target.x);
      minY = Math.min(minY, player.target.y);
      maxY = Math.max(maxY, player.target.y);
    }
    if (autoZoom && Number.isFinite(minX)) {
      scale = Math.max(
        1,
        Math.min(
          RADAR_PRESENTATION.maxZoom,
          1 / (Math.max(maxX - minX, maxY - minY) + 2 * RADAR_PRESENTATION.zoomPadding),
        ),
      );
      const half = 0.5 / scale;
      x = Math.max(half, Math.min(1 - half, (minX + maxX) / 2));
      y = Math.max(half, Math.min(1 - half, (minY + maxY) / 2));
    }
    this.zoom.x += (x - this.zoom.x) * mix;
    this.zoom.y += (y - this.zoom.y) * mix;
    this.zoom.scale += (scale - this.zoom.scale) * mix;
  }
}

'use client';

import { useEffect, useRef } from 'react';
import type { RadarViewFrame, RadarViewSource } from './types.js';
import { bombIconPath, radarAssetUrl } from './assets.js';
import {
  RadarPresentation,
  radarBoundary,
  RADAR_PRESENTATION,
  SMOKE_PRESENTATION_DURATION_SECONDS,
  isMultiLayerGeometry,
  layerOpacity,
  radarPlayerMarkerKind,
  radarPlayerMarkerVisualRole,
  smokeRemaining,
  type RadarSide,
} from './presentation.js';
import {
  RADAR_CANVAS_GEOMETRY,
  radarBroadcastPlacement,
  radarCanvasPoint,
  radarCanvasRadius,
  radarPointInsideViewport,
  type RadarCanvasPlacement,
} from './canvas-geometry.js';
import { WebGL2RadarRenderer } from './webgl-renderer.js';

export interface RadarViewProps {
  readonly appearance?: 'default' | 'shanghai' | 'esl';
  readonly client?: RadarViewSource | undefined;
  readonly snapshot?: RadarViewFrame | null | undefined;
  readonly zoomMode?: 'full-map' | 'auto' | undefined;
  /** Freeze the current trusted image; the host owns staleness. Null input still clears. */
  readonly paused?: boolean;
  readonly reducedMotion?: boolean;
  /** Draw a fixed snapshot on input, asset or surface changes, without a frame loop. */
  readonly staticFrame?: boolean;
  /** Emit detailed diagnostic data-radar-* attributes for testing/inspection. */
  readonly debugAttributes?: boolean;
  readonly assetBaseUrl: string;
  readonly resolveAssetUrl?: ((url: string) => string) | undefined;
  readonly className?: string;
  readonly presentationRevision?: number | undefined;
}

function drawContainedWebGL(
  renderer: WebGL2RadarRenderer,
  image: HTMLImageElement,
  cx: number,
  cy: number,
  boxWidth: number,
  boxHeight: number,
  alpha: number,
  tintColor?: string,
): void {
  const region = renderer.cache.image(image, tintColor);
  if (!region) return;
  const scale = Math.min(boxWidth / region.width, boxHeight / region.height);
  renderer.drawTexturedQuad(region, cx, cy, region.width * scale, region.height * scale, alpha);
}

/** React owns the surface. Accepted channel samples and WebGL 2 rAF own all motion. */
export function RadarView({
  client,
  appearance = 'default',
  snapshot,
  assetBaseUrl,
  resolveAssetUrl,
  className,
  paused = false,
  reducedMotion,
  staticFrame = false,
  debugAttributes = false,
  zoomMode = 'full-map',
  presentationRevision = 0,
}: RadarViewProps) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const redraw = useRef<(() => void) | null>(null);
  const currentPaused = useRef(paused);
  const currentReducedMotion = useRef(reducedMotion);
  const currentSnapshot = useRef(snapshot);
  const currentPresentationRevision = useRef(presentationRevision);

  useEffect(() => {
    currentPaused.current = paused;
    currentReducedMotion.current = reducedMotion;
    currentSnapshot.current = snapshot;
    currentPresentationRevision.current = presentationRevision;
    redraw.current?.();
  }, [presentationRevision, snapshot, paused, reducedMotion, staticFrame]);

  useEffect(() => {
    const maybeElement = canvas.current;
    if (!maybeElement) return;
    const element: HTMLCanvasElement = maybeElement;

    const setData = (key: string, value: string | undefined) => {
      if (element.dataset[key] === value) return;
      if (value === undefined) delete element.dataset[key];
      else element.dataset[key] = value;
    };

    const gl = element.getContext('webgl2', {
      alpha: true,
      premultipliedAlpha: true,
      antialias: true,
      powerPreference: 'high-performance',
    });
    if (!gl) {
      setData('radarDiagnostic', 'webgl-unavailable');
      return;
    }

    const renderer = new WebGL2RadarRenderer(gl);
    if (!renderer.isReady()) {
      setData('radarDiagnostic', 'webgl-init-failed');
      renderer.dispose();
      return;
    }

    const model = new RadarPresentation();
    const images = new Map<string, HTMLImageElement>();
    const emitDiagnostics = staticFrame || debugAttributes;

    let surfaceDirty = true;
    let backingSize = 1;
    let ctColor = '#6aa8ff';
    let tColor = '#f2bd4f';
    let bombCarrierColor = '#f06f6f';
    let cacheBoundary: string | null = null;
    let lastDrawnSequence: string | undefined;
    let frame = 0;
    let disposed = false;
    let lastStatic: RadarViewFrame | null | undefined;
    let lastConnection: unknown;
    let lastPresentationRevision = currentPresentationRevision.current;
    let restoreStaticBoundary = false;
    let frozenAt: number | null = null;

    const isPageVisible = () =>
      typeof document === 'undefined' || document.visibilityState === 'visible';
    const motionPreference = window.matchMedia?.('(prefers-reduced-motion: reduce)');

    const updateUtilityPhaseDataset = () => {
      if (!emitDiagnostics) return;
      let phases = '';
      let projectiles = '';
      for (const marker of model.grenades.values()) {
        phases += `${phases.length === 0 ? '' : ','}${marker.source.sourceEntityId}:${marker.phase}`;
        if (marker.phase === 'projectile') {
          projectiles += `${projectiles.length === 0 ? '' : ','}${marker.source.sourceEntityId}`;
        }
      }
      setData('radarUtilityPhases', phases);
      setData('radarProjectileIds', projectiles);
    };

    const assetUrl = (path: string) => {
      const url = radarAssetUrl(path, assetBaseUrl);
      return resolveAssetUrl ? resolveAssetUrl(url) : url;
    };

    const clearChangedPausedBoundary = (next: RadarViewFrame | null | undefined) => {
      if (
        currentPaused.current &&
        next &&
        model.snapshot &&
        radarBoundary(next) !== radarBoundary(model.snapshot)
      ) {
        model.reset();
        updateUtilityPhaseDataset();
      }
    };

    function scheduleFrame() {
      if (disposed || frame !== 0) return;
      frame = requestAnimationFrame(render);
    }

    function invalidateSurface() {
      surfaceDirty = true;
      scheduleFrame();
    }
    redraw.current = invalidateSurface;

    function imageFor(url: string): HTMLImageElement | null {
      let image = images.get(url);
      if (!image) {
        image = new Image();
        image.onload = invalidateSurface;
        image.src = assetUrl(url);
        images.set(url, image);
      }
      return image.complete && image.naturalWidth > 0 ? image : null;
    }

    function accept() {
      if (!client) return;
      const state = client.getSnapshot();
      clearChangedPausedBoundary(state);
      if (state === lastConnection || (currentPaused.current && state !== null)) return;
      lastConnection = state;
      model.accept(state, performance.now(), restoreStaticBoundary);
      restoreStaticBoundary = false;
      updateUtilityPhaseDataset();
      if (isPageVisible() && !staticFrame) scheduleFrame();
    }

    function render() {
      if (disposed) return;
      frame = 0;

      if (!renderer.isReady()) {
        setData('radarDiagnostic', 'webgl-init-failed');
        return;
      }

      if (lastPresentationRevision !== currentPresentationRevision.current) {
        lastPresentationRevision = currentPresentationRevision.current;
        lastStatic = undefined;
        lastConnection = undefined;
        restoreStaticBoundary = true;
        model.reset();
        updateUtilityPhaseDataset();
      }
      if (client) accept();
      else clearChangedPausedBoundary(currentSnapshot.current);

      let now = performance.now();
      if (
        !client &&
        lastStatic !== currentSnapshot.current &&
        (!currentPaused.current || currentSnapshot.current == null)
      ) {
        lastStatic = currentSnapshot.current;
        if (staticFrame) frozenAt = now;
        model.accept(lastStatic ?? null, now, restoreStaticBoundary);
        restoreStaticBoundary = false;
        updateUtilityPhaseDataset();
      }
      if (currentPaused.current || staticFrame) frozenAt ??= now;
      else frozenAt = null;
      now = frozenAt ?? now;

      const reduceMotion =
        staticFrame || (currentReducedMotion.current ?? motionPreference?.matches ?? false);
      model.tick(now, zoomMode === 'auto', reduceMotion);
      if (reduceMotion) {
        for (const marker of model.grenades.values())
          marker.phaseStartedAt = Math.min(marker.phaseStartedAt, now - 1000);
      }

      if (surfaceDirty) {
        surfaceDirty = false;
        backingSize = Math.max(
          1,
          Math.round(element.clientWidth * Math.min(window.devicePixelRatio || 1, 2)),
        );
        const style = getComputedStyle(element);
        ctColor = style.getPropertyValue('--mizar-side-ct').trim() || '#6aa8ff';
        tColor = style.getPropertyValue('--mizar-side-t').trim() || '#f2bd4f';
        bombCarrierColor = style.getPropertyValue('--mizar-hud-objective-bomb').trim() || '#f06f6f';
      }

      const size = backingSize;
      if (element.width !== size || element.height !== size) {
        element.width = size;
        element.height = size;
      }

      const logicalSize = RADAR_CANVAS_GEOMETRY.logicalSize;
      const sideColor = (side: RadarSide) =>
        side === 'CT' ? ctColor : side === 'T' ? tColor : '#aab4c0';

      const boundary = model.snapshot ? radarBoundary(model.snapshot) : null;
      if (boundary !== cacheBoundary) {
        cacheBoundary = boundary;
        renderer.cache.clear();
      }

      const geometry = model.geometry;
      const payload = model.snapshot?.payload;
      const multiLayer = geometry !== null && isMultiLayerGeometry(geometry);
      const singleAsset = geometry !== null && !multiLayer ? geometry.artwork.overview : null;
      const singleImage = singleAsset ? imageFor(singleAsset) : null;
      const upperAsset = geometry !== null && multiLayer ? geometry.artwork.upper : null;
      const lowerAsset = geometry !== null && multiLayer ? geometry.artwork.lower : null;
      const upperImage = upperAsset ? imageFor(upperAsset) : null;
      const lowerImage = lowerAsset ? imageFor(lowerAsset) : null;

      const placementFor = (layer: string): RadarCanvasPlacement | null =>
        geometry === null ? null : radarBroadcastPlacement(geometry.mapKey, layer, appearance);
      const pointAt = (point: { x: number; y: number; layer?: string }, layerHint?: string) => {
        const placement = placementFor(layerHint ?? point.layer ?? model.layer);
        if (placement !== null && !radarPointInsideViewport(point, placement.viewport)) return null;
        return radarCanvasPoint(point, placement?.viewport ?? null, placement?.rect ?? null);
      };
      const radiusAt = (normalizedRadius: number, layer: string) => {
        const placement = placementFor(layer);
        return radarCanvasRadius(
          normalizedRadius,
          placement?.viewport ?? null,
          placement?.rect ?? null,
        );
      };

      if (emitDiagnostics) {
        setData(
          'radarSampleSequence',
          String(model.snapshot?.sampleSequence ?? model.snapshot?.sequence ?? ''),
        );
        const detachedFloors = geometry?.mapKey === 'de_nuke' && multiLayer;
        setData('radarState', !payload ? 'unavailable' : 'live');
        setData('radarDiagnostic', model.diagnosticReason ?? 'none');
        if (model.unsupportedMap === null) setData('radarUnsupportedMap', undefined);
        else setData('radarUnsupportedMap', model.unsupportedMap);
        setData('radarLayer', model.layer);
        setData('radarLayers', multiLayer ? 'simultaneous' : model.layer);
        setData(
          'radarCompositor',
          detachedFloors
            ? `${appearance === 'shanghai' ? 'shanghai' : 'ewc'}-detached-floor-shared-calibration`
            : multiLayer
              ? 'shared-calibration'
              : 'single-calibration',
        );
        setData('radarCoordinateSpace', 'overview-1024');
        setData(
          'radarArtwork',
          (multiLayer ? upperImage && lowerImage : singleImage) ? 'ready' : 'loading',
        );
        setData('radarVisibleFloors', multiLayer ? 'upper,lower' : model.layer);
        setData('radarPlayers', String(model.players.size));
        let trailPoints = 0;
        let projectiles = 0;
        let smokeEffects = 0;
        let smokeProjectiles = 0;
        let infernoEffects = 0;
        let firebombProjectiles = 0;
        for (const marker of model.grenades.values()) {
          trailPoints += marker.trail.length;
          if (marker.phase === 'projectile') {
            projectiles += 1;
            if (marker.source.kind === 'smoke') smokeProjectiles += 1;
            if (marker.source.kind === 'firebomb') firebombProjectiles += 1;
          }
          if (marker.phase === 'effect' && marker.source.kind === 'smoke') smokeEffects += 1;
          if (marker.phase === 'effect' && marker.source.kind === 'inferno') infernoEffects += 1;
        }
        setData('radarTrails', String(trailPoints));
        setData('radarProjectiles', String(projectiles));
        setData('radarSmokeProjectiles', String(smokeProjectiles));
        setData('radarSmokes', String(smokeEffects));
        setData('radarFirebombProjectiles', String(firebombProjectiles));
        setData('radarInfernos', String(infernoEffects));
        setData(
          'radarFlamePoints',
          String(
            payload?.grenades.reduce((count, grenade) => count + grenade.flames.length, 0) ?? 0,
          ),
        );
        const observedPlayer = payload?.observedPlayerSourceId;
        const observedMarker =
          observedPlayer == null ? undefined : model.players.get(observedPlayer);
        if (observedPlayer != null && observedMarker !== undefined) {
          setData('radarObservedPlayer', observedPlayer);
          setData(
            'radarObservedMotion',
            [
              observedMarker.previousTarget.x,
              observedMarker.previousTarget.y,
              observedMarker.target.x,
              observedMarker.target.y,
              observedMarker.x,
              observedMarker.y,
            ]
              .map((value) => value.toFixed(6))
              .join(','),
          );
        } else {
          setData('radarObservedPlayer', undefined);
          setData('radarObservedMotion', undefined);
        }
        setData('radarAppearance', appearance);
      }

      const z = model.zoom;
      renderer.beginFrame(size, z.x, z.y, z.scale);

      const drawArtwork = (
        image: HTMLImageElement,
        placement: RadarCanvasPlacement | null,
        alpha: number,
      ) => {
        const region = renderer.cache.artwork(image, placement, size, appearance);
        if (region) {
          renderer.drawTexturedQuad(
            region,
            logicalSize * 0.5,
            logicalSize * 0.5,
            logicalSize,
            logicalSize,
            alpha,
          );
        }
      };

      if (singleImage) {
        drawArtwork(singleImage, placementFor('single'), appearance === 'esl' ? 1 : 0.84);
      } else if (geometry && multiLayer) {
        const floors =
          model.layer === 'upper' ? (['lower', 'upper'] as const) : (['upper', 'lower'] as const);
        for (const floor of floors) {
          const image = floor === 'upper' ? upperImage : lowerImage;
          if (!image) continue;
          const alpha = floor === model.layer ? 0.86 : model.layer === 'unknown' ? 0.72 : 0.5;
          drawArtwork(image, placementFor(floor), alpha);
        }
      }

      const drawSiteBadge = (
        label: 'A' | 'B',
        normalized: { readonly x: number; readonly y: number },
        layer: string,
      ) => {
        const placement = placementFor(layer);
        const point = radarCanvasPoint(
          normalized,
          placement?.viewport ?? null,
          placement?.rect ?? null,
        );
        renderer.drawRect(point.x, point.y, 56, 56, '#f3ce22', 1);
        const region = renderer.cache.glyph(label, '900 64px Inter, sans-serif', '#0b1119');
        if (region) renderer.drawTexturedQuad(region, point.x, point.y + 1, 32, 32, 1);
      };
      if (appearance !== 'esl' && geometry?.mapKey === 'de_ancient') {
        drawSiteBadge('A', { x: 0.302, y: 0.26 }, 'single');
        drawSiteBadge('B', { x: 0.8, y: 0.4 }, 'single');
      } else if (appearance !== 'esl' && geometry?.mapKey === 'de_nuke') {
        drawSiteBadge('A', { x: 0.58, y: 0.48 }, 'upper');
        drawSiteBadge('B', { x: 0.58, y: 0.58 }, 'lower');
      }

      if (geometry && payload) {
        let flameCount = 0;
        const drawInferno = (
          marker: typeof model.grenades extends Map<string, infer V> ? V : never,
          alpha: number,
        ) => {
          if (
            !marker.positionAvailable ||
            marker.source.kind !== 'inferno' ||
            marker.source.flames.length === 0
          )
            return;
          if (appearance === 'esl') {
            for (const flame of marker.source.flames) {
              if (flameCount >= RADAR_PRESENTATION.maxFlames) break;
              flameCount += 1;
              const point =
                flame.position && !flame.position.outOfBounds ? pointAt(flame.position) : null;
              if (!point) continue;
              const op = alpha * layerOpacity(flame.position, model.layer) * 0.5;
              renderer.drawCircle(point.x, point.y, 6, '#ff0000', op, '#ffa500', 2);
            }
            return;
          }
          let totalX = 0;
          let totalY = 0;
          let totalOpacity = 0;
          let pointCount = 0;
          let processedFlames = 0;
          const worldRadius = 52 * geometry.unitRadius;
          const glowBlur = (5 * logicalSize) / (size * z.scale);
          for (const flame of marker.source.flames) {
            if (flameCount >= RADAR_PRESENTATION.maxFlames) break;
            flameCount += 1;
            processedFlames += 1;
            const projected = flame.position;
            if (!projected || projected.outOfBounds) continue;
            const point = pointAt(projected);
            if (point === null) continue;
            const radius = radiusAt(worldRadius, projected.layer);
            const opacity = layerOpacity(projected, model.layer);
            totalX += point.x;
            totalY += point.y;
            totalOpacity += opacity;
            pointCount += 1;
            renderer.drawFlameGlow(
              point.x,
              point.y,
              radius,
              glowBlur,
              '#e85f2f',
              alpha * opacity * 0.46,
            );
          }
          let drawnFlames = 0;
          for (const flame of marker.source.flames) {
            if (drawnFlames >= processedFlames) break;
            drawnFlames += 1;
            const projected = flame.position;
            if (!projected || projected.outOfBounds) continue;
            const point = pointAt(projected);
            if (point === null) continue;
            const radius = radiusAt(worldRadius, projected.layer);
            const opacity = layerOpacity(projected, model.layer);
            renderer.drawCircle(
              point.x,
              point.y,
              radius * 0.9,
              '#f49b3d',
              alpha * opacity * 0.58,
              undefined,
              0,
              true,
            );
            renderer.drawCircle(
              point.x,
              point.y,
              radius * 0.42,
              '#ffd16a',
              alpha * opacity * 0.34,
              undefined,
              0,
              true,
            );
          }
          if (pointCount > 0) {
            const ownerSide =
              payload.players.find(
                (player) => player.sourcePlayerId === marker.source.ownerSourceId,
              )?.side ?? 'unknown';
            renderer.drawCircle(
              totalX / pointCount,
              totalY / pointCount,
              5,
              sideColor(ownerSide),
              (totalOpacity / pointCount / 2.5) * alpha,
            );
          }
        };

        for (const marker of model.grenades.values()) {
          if (marker.phase !== 'effect' || marker.source.kind !== 'inferno') continue;
          drawInferno(
            marker,
            Math.min(
              1,
              Math.max(0, (now - marker.phaseStartedAt) / RADAR_PRESENTATION.infernoEnterMs),
            ),
          );
        }
        for (const exit of model.exits.values()) {
          if (exit.marker.phase === 'effect' && exit.marker.source.kind === 'inferno') {
            drawInferno(
              exit.marker,
              Math.min(1, Math.max(0, (exit.until - now) / exit.durationMs)),
            );
          }
        }

        const drawSmoke = (
          marker: typeof model.grenades extends Map<string, infer V> ? V : never,
          alpha: number,
        ) => {
          if (marker.source.kind !== 'smoke') return;
          const point = pointAt({ ...marker.target, x: marker.x, y: marker.y });
          if (point === null) return;
          const x = point.x;
          const y = point.y;
          const opacity = layerOpacity(marker.target, model.layer) * alpha;
          const radius = radiusAt(144 * geometry.unitRadius, marker.target.layer);
          if (appearance === 'esl') {
            renderer.drawCircle(x, y, radius, '#ffffff80', opacity, sideColor(marker.side), 5);
            return;
          }
          const smokeTex = renderer.cache.smoke(marker.source.sourceEntityId);
          if (smokeTex) {
            renderer.drawTexturedQuad(smokeTex, x, y, radius * 2, radius * 2, opacity);
          }
          renderer.drawCircle(x, y, radius, '#00000000', opacity * 0.78, '#f7f8f8', 2);

          const remaining = smokeRemaining(marker.source.effectTimeSeconds);
          if (remaining !== null) {
            const timerRadius = radius * 0.4;
            const remainingRatio = remaining / SMOKE_PRESENTATION_DURATION_SECONDS;
            renderer.drawSmokeTimer(
              x,
              y,
              timerRadius,
              remainingRatio,
              sideColor(marker.side),
              opacity,
            );
          }
        };

        for (const marker of model.grenades.values()) {
          if (
            !marker.positionAvailable ||
            marker.phase !== 'effect' ||
            marker.source.kind !== 'smoke'
          )
            continue;
          drawSmoke(
            marker,
            Math.min(
              1,
              Math.max(0, (now - marker.phaseStartedAt) / RADAR_PRESENTATION.smokeEnterMs),
            ),
          );
        }
        for (const exit of model.exits.values()) {
          if (exit.marker.phase === 'effect' && exit.marker.source.kind === 'smoke') {
            drawSmoke(exit.marker, Math.min(1, Math.max(0, (exit.until - now) / exit.durationMs)));
          }
        }

        const drawTrail = (
          marker: typeof model.grenades extends Map<string, infer V> ? V : never,
          alpha: number,
        ) => {
          if (marker.trail.length < 2) return;
          const color = sideColor(marker.side);
          const trailAlpha = alpha * 0.72;
          let prev: { x: number; y: number } | null = null;
          let dashOffset = 0;
          for (const sample of marker.trail) {
            const pt = pointAt(sample, marker.target.layer);
            if (pt === null) {
              prev = null;
              continue;
            }
            if (prev !== null) {
              const segLen = Math.hypot(pt.x - prev.x, pt.y - prev.y);
              renderer.drawLine(prev.x, prev.y, pt.x, pt.y, 2, color, trailAlpha, 13, dashOffset);
              dashOffset += segLen;
            }
            prev = pt;
          }
        };

        for (const exit of model.exits.values()) {
          if (!exit.marker.positionAvailable) continue;
          const alpha = Math.min(1, Math.max(0, (exit.until - now) / exit.durationMs));
          drawTrail(exit.marker, alpha);
          const exitPoint = pointAt(exit.marker.target);
          if (exitPoint === null) continue;

          const kind = exit.marker.source.kind;
          if (exit.marker.phase === 'projectile' && kind === 'firebomb') {
            const icon =
              exit.includeProjectileIcon && exit.marker.iconUrl && imageFor(exit.marker.iconUrl);
            if (icon) {
              drawContainedWebGL(
                renderer,
                icon,
                exitPoint.x,
                exitPoint.y,
                28,
                28,
                alpha * layerOpacity(exit.marker.target, model.layer),
              );
            }
          }
          if (
            exit.marker.source.moving !== undefined &&
            exit.marker.phase === 'projectile' &&
            (kind === 'frag' || kind === 'hegrenade')
          ) {
            renderer.drawCircle(
              exitPoint.x,
              exitPoint.y,
              10 + (1 - alpha) * 26,
              '#00000000',
              alpha * 0.8,
              '#f3f6fa',
              2.5,
            );
            renderer.drawCircle(
              exitPoint.x,
              exitPoint.y,
              5 + (1 - alpha) * 14,
              '#f0b45e',
              alpha * 0.36,
            );
            continue;
          }
          if (
            exit.marker.source.moving !== undefined &&
            exit.marker.phase === 'projectile' &&
            kind === 'flashbang'
          ) {
            for (let ray = 0; ray < 8; ray += 1) {
              const angle = (ray / 8) * Math.PI * 2;
              const inner = 5 + (1 - alpha) * 3;
              const outer = 14 + (1 - alpha) * 16;
              renderer.drawLine(
                exitPoint.x + Math.cos(angle) * inner,
                exitPoint.y + Math.sin(angle) * inner,
                exitPoint.x + Math.cos(angle) * outer,
                exitPoint.y + Math.sin(angle) * outer,
                2.5,
                '#ffffff',
                alpha * 0.88,
              );
            }
            renderer.drawCircle(
              exitPoint.x,
              exitPoint.y,
              6 + (1 - alpha) * 4,
              '#ffffff',
              alpha * 0.7,
            );
          }
          if (
            exit.marker.phase === 'projectile' &&
            exit.includeProjectileIcon &&
            kind !== 'firebomb' &&
            (exit.marker.source.moving === undefined ||
              (kind !== 'frag' && kind !== 'hegrenade' && kind !== 'flashbang'))
          ) {
            const icon = exit.marker.iconUrl && imageFor(exit.marker.iconUrl);
            if (icon) {
              drawContainedWebGL(
                renderer,
                icon,
                exitPoint.x,
                exitPoint.y,
                28,
                28,
                alpha * layerOpacity(exit.marker.target, model.layer),
              );
            }
          }
        }

        for (const marker of model.grenades.values()) {
          if (!marker.positionAvailable || marker.phase !== 'projectile') continue;
          drawTrail(marker, 1);
          const point = pointAt({ ...marker.target, x: marker.x, y: marker.y });
          if (point === null) continue;
          const x = point.x;
          const y = point.y;
          const op = layerOpacity(marker.target, model.layer);
          const url = marker.iconUrl;
          const icon = url && imageFor(url);
          if (icon) drawContainedWebGL(renderer, icon, x, y, 28, 28, op);
          else renderer.drawRect(x, y, 12, 12, '#ecedef', op);
        }

        const bomb = payload.bomb;
        const bombIcon = imageFor(bombIconPath);
        for (const marker of model.players.values()) {
          const p = marker.source;
          const markerKind = radarPlayerMarkerKind(p.lifeState);
          if (markerKind === null) continue;
          const deathPosition = markerKind === 'dead' ? marker.deathPosition : null;
          if (markerKind === 'dead' && deathPosition === null) continue;
          const position =
            deathPosition === null
              ? { ...marker.target, x: marker.x, y: marker.y }
              : { ...marker.target, ...deathPosition };
          const point = pointAt(position);
          if (point === null) continue;
          const x = point.x;
          const y = point.y;
          const color = sideColor(p.side);
          const markerFill =
            radarPlayerMarkerVisualRole(p.sourcePlayerId, bomb) === 'bomb-carrier'
              ? bombCarrierColor
              : color;
          const baseAlpha = layerOpacity(marker.target, model.layer);

          if (appearance === 'esl' && markerKind === 'dead') {
            const lbl = renderer.cache.glyph(
              p.label ?? '',
              '900 48px ESLLegend, "Mizar Radar Legend", SourceHanSans, sans-serif',
              color,
            );
            if (lbl) {
              const s = 64 / z.scale;
              renderer.drawTexturedQuad(lbl, x, y + 1, s, s, baseAlpha * 0.2);
            }
            continue;
          }
          if (markerKind === 'dead') {
            renderer.drawLine(x - 19, y - 19, x + 19, y + 19, 7, color, baseAlpha);
            renderer.drawLine(x - 19, y + 19, x + 19, y - 19, 7, color, baseAlpha);
            continue;
          }

          if (appearance === 'esl') {
            const observed = payload.observedPlayerSourceId === p.sourcePlayerId;
            const radius = (observed ? 30 : 27.5) / z.scale;
            const angleRad = (marker.angle * Math.PI) / 180;
            if (p.facing) {
              const direction = imageFor('brand/hud/esl/playerBg.png');
              if (direction) {
                const region = renderer.cache.image(direction);
                if (region) {
                  renderer.drawTexturedQuad(
                    region,
                    x,
                    y,
                    radius * 2.3,
                    radius * 2.3,
                    baseAlpha,
                    angleRad + (135 * Math.PI) / 180,
                  );
                }
              }
              if (marker.shootingUntil > now) {
                const fire = imageFor('brand/hud/esl/shootFire.png');
                if (fire) {
                  const region = renderer.cache.image(fire);
                  const fireAlpha =
                    baseAlpha * (reduceMotion || Math.floor(now / 125) % 2 === 0 ? 1 : 0);
                  if (region && fireAlpha > 0) {
                    const fx = x + Math.cos(angleRad) * (radius * 2);
                    const fy = y + Math.sin(angleRad) * (radius * 2);
                    renderer.drawTexturedQuad(
                      region,
                      fx,
                      fy,
                      radius * 4,
                      radius * 4,
                      fireAlpha,
                      angleRad,
                    );
                  }
                }
              }
            }
            const flashRatio =
              p.flashAmount != null ? Math.min(1, Math.max(0, p.flashAmount / 255)) : 0;
            renderer.drawCircle(x, y, radius, markerFill, baseAlpha);
            if (flashRatio > 0) {
              renderer.drawCircle(x, y, radius, '#ffffff', baseAlpha * flashRatio);
            }
            const lbl = renderer.cache.glyph(
              p.label ?? '',
              '900 48px ESLLegend, "Mizar Radar Legend", SourceHanSans, sans-serif',
              '#000000',
            );
            if (lbl) {
              const s = 64 / z.scale;
              renderer.drawTexturedQuad(lbl, x, y + 1, s, s, baseAlpha);
            }
            continue;
          }

          if (payload.observedPlayerSourceId === p.sourcePlayerId) {
            renderer.drawCircle(x, y, 33, '#00000000', baseAlpha, '#ffffff', 4);
          }
          const angleRad = (marker.angle * Math.PI) / 180;
          if (p.facing) {
            renderer.drawFacingArrow(x, y, angleRad, color, baseAlpha);
            if (marker.shootingUntil > now) {
              const mx = x + Math.cos(angleRad) * 45.5;
              const my = y + Math.sin(angleRad) * 45.5;
              renderer.drawRect(mx, my, 15, 8, '#fff4b0', baseAlpha, angleRad);
            }
          }
          const flashRatio =
            p.flashAmount != null ? Math.min(1, Math.max(0, p.flashAmount / 255)) : 0;
          renderer.drawCircle(x, y, 29, '#f3f6fa', baseAlpha);
          renderer.drawCircle(x, y, 25, markerFill, baseAlpha, '#0b1119', 2);
          if (flashRatio > 0) {
            renderer.drawCircle(x, y, 24, '#ffffff', flashRatio * 0.9);
          }
          const lblColor = flashRatio > 0.72 ? '#5d6670' : '#0b1119';
          const lbl = renderer.cache.glyph(p.label ?? '', '800 56px Inter, sans-serif', lblColor);
          if (lbl) {
            renderer.drawTexturedQuad(lbl, x, y + 1, 32, 32, baseAlpha);
          }
          if (marker.damageUntil > now) {
            const damageAlpha = Math.max(
              0,
              Math.min(1, (marker.damageUntil - now) / RADAR_PRESENTATION.damageMs),
            );
            renderer.drawDamageArc(x, y, 31, angleRad, damageAlpha * 0.95);
          }
        }

        if (
          bomb &&
          (bomb.state === 'dropped' || bomb.state === 'planted' || bomb.state === 'defusing') &&
          model.bombVisible(now)
        ) {
          const p = bomb.position;
          if (p && !p.outOfBounds) {
            const point = pointAt(p);
            if (point !== null) {
              let alpha = layerOpacity(p, model.layer);
              const active = bomb.state === 'planted' || bomb.state === 'defusing';
              const phase = reduceMotion ? 1 : 0.88 + 0.12 * Math.sin((now * Math.PI) / 1000);
              if (active) alpha *= phase;
              if (bombIcon) {
                drawContainedWebGL(
                  renderer,
                  bombIcon,
                  point.x,
                  point.y,
                  38 / z.scale,
                  38 / z.scale,
                  alpha,
                  active ? bombCarrierColor : undefined,
                );
              }
            }
          }
        }
      }

      renderer.endFrame();

      if (renderer.isReady()) {
        const drawnSeq = String(model.snapshot?.sampleSequence ?? model.snapshot?.sequence ?? '');
        if (drawnSeq !== lastDrawnSequence) {
          lastDrawnSequence = drawnSeq;
          setData('radarDrawnSequence', drawnSeq);
        }
      }

      if (
        !staticFrame &&
        !currentPaused.current &&
        isPageVisible() &&
        model.hasActiveMotion(now, reduceMotion)
      ) {
        scheduleFrame();
      }
    }

    const handleVisibilityChange = () => {
      if (isPageVisible()) {
        scheduleFrame();
      } else if (frame !== 0) {
        cancelAnimationFrame(frame);
        frame = 0;
      }
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);

    const handleContextLost = (event: Event) => {
      event.preventDefault();
      if (frame !== 0) {
        cancelAnimationFrame(frame);
        frame = 0;
      }
      renderer.handleContextLost();
    };
    const handleContextRestored = () => {
      if (renderer.handleContextRestored()) {
        invalidateSurface();
      }
    };
    element.addEventListener('webglcontextlost', handleContextLost);
    element.addEventListener('webglcontextrestored', handleContextRestored);

    const resizeObserver =
      typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(invalidateSurface);
    resizeObserver?.observe(element);
    const styleObserver = new MutationObserver(invalidateSurface);
    for (let ancestor: HTMLElement | null = element; ancestor; ancestor = ancestor.parentElement)
      styleObserver.observe(ancestor, {
        attributes: true,
        ...(ancestor === element ? { attributeFilter: ['class', 'style'] } : {}),
      });
    window.addEventListener('resize', invalidateSurface);

    const eslFonts = appearance === 'esl' ? document.fonts : undefined;
    let bundledLegend: FontFace | undefined;
    if (eslFonts) {
      if (!Array.from(eslFonts).some((face) => face.family === 'ESLLegend')) {
        bundledLegend = new FontFace(
          'Mizar Radar Legend',
          'url(' + JSON.stringify(assetUrl('brand/fonts/esl/legend-bold.woff2')) + ')',
          { weight: '900' },
        );
        eslFonts.add(bundledLegend);
      }
      const load = bundledLegend?.load() ?? eslFonts.load('900 48px ESLLegend');
      void load.then(
        () => {
          renderer.cache.clearGlyphs();
          invalidateSurface();
        },
        () => undefined,
      );
    }

    const unsubscribe = client?.subscribe(accept);
    accept();

    if (isPageVisible() || staticFrame) {
      scheduleFrame();
    }

    return () => {
      disposed = true;
      redraw.current = null;
      if (frame !== 0) cancelAnimationFrame(frame);
      unsubscribe?.();
      resizeObserver?.disconnect();
      styleObserver.disconnect();
      window.removeEventListener('resize', invalidateSurface);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      element.removeEventListener('webglcontextlost', handleContextLost);
      element.removeEventListener('webglcontextrestored', handleContextRestored);
      if (bundledLegend) eslFonts?.delete(bundledLegend);
      renderer.dispose();
      model.reset();
      images.clear();
    };
  }, [client, zoomMode, assetBaseUrl, resolveAssetUrl, appearance, staticFrame, debugAttributes]);

  return (
    <canvas
      aria-label="比赛雷达"
      className={['mizar-radar-view', className].filter(Boolean).join(' ')}
      ref={canvas}
      data-radar-static={staticFrame}
      data-radar-paused={paused}
      data-radar-source={client ? 'client' : 'snapshot'}
    />
  );
}

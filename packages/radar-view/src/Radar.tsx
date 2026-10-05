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
import { drawContainedImage } from './draw-contained-image.js';
import {
  RADAR_CANVAS_GEOMETRY,
  radarBroadcastPlacement,
  radarCanvasPoint,
  radarCanvasRadius,
  radarPointInsideViewport,
  type RadarCanvasPlacement,
} from './canvas-geometry.js';
import { smokeContour, smokeLobes } from './effect-geometry.js';

export interface RadarViewProps {
  readonly appearance?: 'default' | 'shanghai' | 'esl';
  readonly client?: RadarViewSource | undefined;
  readonly snapshot?: RadarViewFrame | null | undefined;
  readonly zoomMode?: 'full-map' | 'auto' | undefined;
  /** Freeze the current trusted image; the host owns staleness. Null input still clears. */
  readonly paused?: boolean;
  readonly reducedMotion?: boolean;
  readonly assetBaseUrl: string;
  readonly className?: string;
  readonly presentationRevision?: number | undefined;
}

/** React owns the surface. Accepted channel samples and rAF own all motion. */
export function RadarView({
  client,
  appearance = 'default',
  snapshot,
  assetBaseUrl,
  className,
  paused = false,
  reducedMotion,
  zoomMode = 'full-map',
  presentationRevision = 0,
}: RadarViewProps) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const currentPaused = useRef(paused);
  const currentReducedMotion = useRef(reducedMotion);
  const currentSnapshot = useRef(snapshot);
  const currentPresentationRevision = useRef(presentationRevision);
  useEffect(() => {
    currentPaused.current = paused;
    currentReducedMotion.current = reducedMotion;
    currentSnapshot.current = snapshot;
    currentPresentationRevision.current = presentationRevision;
  }, [presentationRevision, snapshot, paused, reducedMotion]);
  useEffect(() => {
    const element = canvas.current;
    const context = element?.getContext('2d');
    if (!element || !context) return;
    const model = new RadarPresentation();
    const images = new Map<string, HTMLImageElement>();
    let frame = 0;
    let disposed = false;
    let lastStatic: RadarViewFrame | null | undefined;
    let lastConnection: unknown;
    let lastPresentationRevision = currentPresentationRevision.current;
    let restoreStaticBoundary = false;
    let frozenAt: number | null = null;
    const motionPreference = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    const updateUtilityPhaseDataset = () => {
      let phases = '';
      let projectiles = '';
      for (const marker of model.grenades.values()) {
        phases += `${phases.length === 0 ? '' : ','}${marker.source.sourceEntityId}:${marker.phase}`;
        if (marker.phase === 'projectile') {
          projectiles += `${projectiles.length === 0 ? '' : ','}${marker.source.sourceEntityId}`;
        }
      }
      element.dataset.radarUtilityPhases = phases;
      element.dataset.radarProjectileIds = projectiles;
    };
    const imageFor = (url: string): HTMLImageElement | null => {
      let image = images.get(url);
      if (!image) {
        image = new Image();
        image.src = radarAssetUrl(url, assetBaseUrl);
        images.set(url, image);
      }
      return image.complete && image.naturalWidth > 0 ? image : null;
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
    const accept = () => {
      if (!client) return;
      const state = client.getSnapshot();
      clearChangedPausedBoundary(state);
      if (state === lastConnection || (currentPaused.current && state !== null)) return;
      lastConnection = state;
      model.accept(state, performance.now(), restoreStaticBoundary);
      restoreStaticBoundary = false;
      updateUtilityPhaseDataset();
    };
    const unsubscribe = client?.subscribe(accept);
    accept();
    const render = (now: number) => {
      if (disposed) return;
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
      if (
        !client &&
        lastStatic !== currentSnapshot.current &&
        (!currentPaused.current || currentSnapshot.current == null)
      ) {
        lastStatic = currentSnapshot.current;
        model.accept(lastStatic ?? null, now, restoreStaticBoundary);
        restoreStaticBoundary = false;
        updateUtilityPhaseDataset();
      }
      if (currentPaused.current) frozenAt ??= now;
      else frozenAt = null;
      now = frozenAt ?? now;
      const reduceMotion = currentReducedMotion.current ?? motionPreference?.matches ?? false;
      model.tick(now, zoomMode === 'auto', reduceMotion);
      if (reduceMotion) {
        for (const marker of model.grenades.values())
          marker.phaseStartedAt = Math.min(marker.phaseStartedAt, now - 1000);
      }
      const size = Math.max(
        1,
        Math.round(element.clientWidth * Math.min(window.devicePixelRatio || 1, 2)),
      );
      if (element.width !== size || element.height !== size) {
        element.width = size;
        element.height = size;
      }
      const ctx = context;
      const logicalSize = RADAR_CANVAS_GEOMETRY.logicalSize;
      ctx.setTransform(size / logicalSize, 0, 0, size / logicalSize, 0, 0);
      ctx.clearRect(0, 0, logicalSize, logicalSize);
      const style = getComputedStyle(element);
      const sideColor = (side: RadarSide) =>
        side === 'CT'
          ? style.getPropertyValue('--mizar-side-ct').trim() || '#6aa8ff'
          : side === 'T'
            ? style.getPropertyValue('--mizar-side-t').trim() || '#f2bd4f'
            : '#aab4c0';
      const bombCarrierColor =
        style.getPropertyValue('--mizar-hud-objective-bomb').trim() || '#f06f6f';
      const circle = (
        x: number,
        y: number,
        radius: number,
        fill: string,
        stroke?: string,
        width = 4,
      ) => {
        ctx.beginPath();
        ctx.arc(x, y, radius, 0, Math.PI * 2);
        ctx.fillStyle = fill;
        ctx.fill();
        if (stroke) {
          ctx.strokeStyle = stroke;
          ctx.lineWidth = width;
          ctx.stroke();
        }
      };
      const smoothClosedPath = (points: readonly { readonly x: number; readonly y: number }[]) => {
        if (points.length < 3) return;
        const first = points[0]!;
        const last = points.at(-1)!;
        ctx.beginPath();
        ctx.moveTo((last.x + first.x) / 2, (last.y + first.y) / 2);
        for (let index = 0; index < points.length; index += 1) {
          const current = points[index]!;
          const next = points[(index + 1) % points.length]!;
          ctx.quadraticCurveTo(
            current.x,
            current.y,
            (current.x + next.x) / 2,
            (current.y + next.y) / 2,
          );
        }
        ctx.closePath();
      };
      const geometry = model.geometry;
      const payload = model.snapshot?.payload;
      element.dataset.radarSampleSequence = String(
        model.snapshot?.sampleSequence ?? model.snapshot?.sequence ?? '',
      );
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
      const drawArtwork = (
        image: HTMLImageElement,
        placement: RadarCanvasPlacement | null = null,
      ) => {
        if (placement === null) {
          ctx.drawImage(
            image,
            RADAR_CANVAS_GEOMETRY.inset,
            RADAR_CANVAS_GEOMETRY.inset,
            RADAR_CANVAS_GEOMETRY.artworkSize,
            RADAR_CANVAS_GEOMETRY.artworkSize,
          );
          return;
        }
        const { viewport, rect } = placement;
        ctx.drawImage(
          image,
          viewport.x * image.naturalWidth,
          viewport.y * image.naturalHeight,
          viewport.width * image.naturalWidth,
          viewport.height * image.naturalHeight,
          rect.x,
          rect.y,
          rect.width,
          rect.height,
        );
      };
      const detachedFloors = geometry?.mapKey === 'de_nuke' && multiLayer;
      element.dataset.radarState = !payload ? 'unavailable' : 'live';
      element.dataset.radarDiagnostic = model.diagnosticReason ?? 'none';
      if (model.unsupportedMap === null) delete element.dataset.radarUnsupportedMap;
      else element.dataset.radarUnsupportedMap = model.unsupportedMap;
      element.dataset.radarLayer = model.layer;
      element.dataset.radarLayers = multiLayer ? 'simultaneous' : model.layer;
      element.dataset.radarCompositor = detachedFloors
        ? `${appearance === 'shanghai' ? 'shanghai' : 'ewc'}-detached-floor-shared-calibration`
        : multiLayer
          ? 'shared-calibration'
          : 'single-calibration';
      element.dataset.radarCoordinateSpace = 'overview-1024';
      element.dataset.radarArtwork = (multiLayer ? upperImage && lowerImage : singleImage)
        ? 'ready'
        : 'loading';
      element.dataset.radarVisibleFloors = multiLayer ? 'upper,lower' : model.layer;
      element.dataset.radarPlayers = String(model.players.size);
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
      element.dataset.radarTrails = String(trailPoints);
      element.dataset.radarProjectiles = String(projectiles);
      element.dataset.radarSmokeProjectiles = String(smokeProjectiles);
      element.dataset.radarSmokes = String(smokeEffects);
      element.dataset.radarFirebombProjectiles = String(firebombProjectiles);
      element.dataset.radarInfernos = String(infernoEffects);
      element.dataset.radarFlamePoints = String(
        payload?.grenades.reduce((count, grenade) => count + grenade.flames.length, 0) ?? 0,
      );
      const observedPlayer = payload?.observedPlayerSourceId;
      const observedMarker = observedPlayer == null ? undefined : model.players.get(observedPlayer);
      if (observedPlayer != null && observedMarker !== undefined) {
        element.dataset.radarObservedPlayer = observedPlayer;
        element.dataset.radarObservedMotion = [
          observedMarker.previousTarget.x,
          observedMarker.previousTarget.y,
          observedMarker.target.x,
          observedMarker.target.y,
          observedMarker.x,
          observedMarker.y,
        ]
          .map((value) => value.toFixed(6))
          .join(',');
      } else {
        delete element.dataset.radarObservedPlayer;
        delete element.dataset.radarObservedMotion;
      }
      ctx.save();
      ctx.beginPath();
      ctx.rect(
        RADAR_CANVAS_GEOMETRY.inset,
        RADAR_CANVAS_GEOMETRY.inset,
        RADAR_CANVAS_GEOMETRY.artworkSize,
        RADAR_CANVAS_GEOMETRY.artworkSize,
      );
      ctx.clip();
      const z = model.zoom;
      ctx.translate(logicalSize / 2, logicalSize / 2);
      ctx.scale(z.scale, z.scale);
      ctx.translate(-z.x * logicalSize, -z.y * logicalSize);
      element.dataset.radarAppearance = appearance;
      ctx.filter =
        appearance === 'esl'
          ? 'none'
          : (appearance === 'shanghai'
              ? 'grayscale(1) contrast(1.08) '
              : 'grayscale(0.82) saturate(0.1) contrast(1.16) ') +
            'drop-shadow(3px 0 0 rgba(243,246,250,.72)) ' +
            'drop-shadow(-3px 0 0 rgba(243,246,250,.72)) ' +
            'drop-shadow(0 3px 0 rgba(243,246,250,.72)) ' +
            'drop-shadow(0 -3px 0 rgba(243,246,250,.72))';
      if (singleImage) {
        ctx.globalAlpha = appearance === 'esl' ? 1 : 0.84;
        drawArtwork(singleImage, placementFor('single'));
        ctx.globalAlpha = 1;
      } else if (geometry && multiLayer) {
        const floors =
          model.layer === 'upper' ? (['lower', 'upper'] as const) : (['upper', 'lower'] as const);
        for (const floor of floors) {
          const image = floor === 'upper' ? upperImage : lowerImage;
          if (!image) continue;
          ctx.globalAlpha = floor === model.layer ? 0.86 : model.layer === 'unknown' ? 0.72 : 0.5;
          drawArtwork(image, placementFor(floor));
        }
        ctx.globalAlpha = 1;
      }
      ctx.filter = 'none';

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
        const size = 56;
        ctx.fillStyle = '#f3ce22';
        ctx.fillRect(point.x - size / 2, point.y - size / 2, size, size);
        ctx.fillStyle = '#0b1119';
        ctx.font = '900 32px Inter, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(label, point.x, point.y + 1);
      };
      if (appearance !== 'esl' && geometry?.mapKey === 'de_ancient') {
        // Valve overview artwork already owns spawn-zone geometry. Only add
        // calibrated broadcast labels at the centers of the source bombsites.
        drawSiteBadge('A', { x: 0.302, y: 0.26 }, 'single');
        drawSiteBadge('B', { x: 0.8, y: 0.4 }, 'single');
      } else if (appearance !== 'esl' && geometry?.mapKey === 'de_nuke') {
        drawSiteBadge('A', { x: 0.58, y: 0.48 }, 'upper');
        drawSiteBadge('B', { x: 0.58, y: 0.58 }, 'lower');
      }

      if (geometry && payload) {
        // Active effects are spatial footprints, not enlarged grenade markers.
        // Eon (ISC) and Lexogrine (MIT) informed the state split; this Canvas
        // implementation is original and keeps RivalHub's calibrated truth.
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
            ctx.save();
            for (const flame of marker.source.flames) {
              if (flameCount >= RADAR_PRESENTATION.maxFlames) break;
              flameCount += 1;
              const point =
                flame.position && !flame.position.outOfBounds ? pointAt(flame.position) : null;
              if (!point) continue;
              ctx.globalAlpha = alpha * layerOpacity(flame.position, model.layer) * 0.5;
              circle(point.x, point.y, 6, '#ff0000', '#ffa500', 2);
            }
            ctx.restore();
            return;
          }
          let totalX = 0;
          let totalY = 0;
          let totalOpacity = 0;
          let pointCount = 0;
          let processedFlames = 0;
          const worldRadius = 52 * geometry.unitRadius;
          ctx.save();
          ctx.filter = 'blur(5px)';
          ctx.fillStyle = '#e85f2f';
          for (const flame of marker.source.flames) {
            if (flameCount >= RADAR_PRESENTATION.maxFlames) break;
            flameCount += 1;
            processedFlames += 1;
            const projected = flame.position;
            if (!projected || projected.outOfBounds) continue;
            const point = pointAt(projected);
            if (point === null) continue;
            const radius = Math.max(8, Math.min(18, radiusAt(worldRadius, projected.layer)));
            const opacity = layerOpacity(projected, model.layer);
            totalX += point.x;
            totalY += point.y;
            totalOpacity += opacity;
            pointCount += 1;
            ctx.globalAlpha = alpha * opacity * 0.46;
            circle(point.x, point.y, radius * 1.45, '#e85f2f');
          }
          ctx.filter = 'none';
          ctx.globalCompositeOperation = 'lighter';
          let drawnFlames = 0;
          for (const flame of marker.source.flames) {
            if (drawnFlames >= processedFlames) break;
            drawnFlames += 1;
            const projected = flame.position;
            if (!projected || projected.outOfBounds) continue;
            const point = pointAt(projected);
            if (point === null) continue;
            const radius = Math.max(8, Math.min(18, radiusAt(worldRadius, projected.layer)));
            const opacity = layerOpacity(projected, model.layer);
            ctx.globalAlpha = alpha * opacity * 0.58;
            circle(point.x, point.y, radius * 0.9, '#f49b3d');
            ctx.globalAlpha = alpha * opacity * 0.34;
            circle(point.x, point.y, radius * 0.42, '#ffd16a');
          }
          ctx.globalCompositeOperation = 'source-over';
          if (pointCount > 0) {
            const ownerSide =
              payload.players.find(
                (player) => player.sourcePlayerId === marker.source.ownerSourceId,
              )?.side ?? 'unknown';
            ctx.globalAlpha = (totalOpacity / pointCount / 2.5) * alpha;
            circle(totalX / pointCount, totalY / pointCount, 5, sideColor(ownerSide));
          }
          ctx.restore();
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
            drawInferno(exit.marker, Math.max(0, (exit.until - now) / exit.durationMs));
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
            ctx.save();
            ctx.globalAlpha = opacity;
            circle(x, y, radius, '#ffffff80', sideColor(marker.side), 5);
            ctx.restore();
            return;
          }
          const contour = smokeContour(marker.source.sourceEntityId, radius).map((offset) => ({
            x: x + offset.x,
            y: y + offset.y,
          }));

          ctx.save();
          ctx.globalAlpha = opacity;
          smoothClosedPath(contour);
          ctx.fillStyle = '#eef1f23d';
          ctx.fill();

          for (const lobe of smokeLobes(marker.source.sourceEntityId, radius)) {
            const lx = x + lobe.dx;
            const ly = y + lobe.dy;
            const fill = ctx.createRadialGradient(lx, ly, 0, lx, ly, lobe.radius);
            fill.addColorStop(0, '#ffffffb8');
            fill.addColorStop(0.48, '#f4f6f69a');
            fill.addColorStop(0.82, '#e2e6e76e');
            fill.addColorStop(1, '#d5dadd12');
            ctx.fillStyle = fill;
            ctx.beginPath();
            ctx.arc(lx, ly, lobe.radius, 0, Math.PI * 2);
            ctx.fill();
          }

          ctx.globalAlpha = opacity * 0.78;
          smoothClosedPath(contour);
          ctx.strokeStyle = '#f7f8f8';
          ctx.lineWidth = 2;
          ctx.stroke();

          const remaining = smokeRemaining(marker.source.effectTimeSeconds);
          if (remaining !== null) {
            const timerRadius = radius * 0.4;
            const remainingRatio = remaining / SMOKE_PRESENTATION_DURATION_SECONDS;
            const startAngle = -Math.PI / 2;
            const endAngle = startAngle + Math.PI * 2 * remainingRatio;

            // Clock-like inner timer: the full face is faint, while the remaining
            // sector stays brighter. The colored rim carries ownership only.
            ctx.globalAlpha = opacity * 0.18;
            circle(x, y, timerRadius - 3, '#ffffff');

            if (remainingRatio > 0) {
              ctx.globalAlpha = opacity * 0.42;
              ctx.beginPath();
              ctx.moveTo(x, y);
              ctx.arc(x, y, timerRadius - 3, startAngle, endAngle);
              ctx.closePath();
              ctx.fillStyle = '#ffffff';
              ctx.fill();
            }

            ctx.globalAlpha = opacity * 0.96;
            ctx.beginPath();
            ctx.arc(x, y, timerRadius, startAngle, endAngle);
            ctx.strokeStyle = sideColor(marker.side);
            ctx.lineWidth = 9;
            ctx.lineCap = 'round';
            ctx.stroke();
          }
          ctx.restore();
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
            drawSmoke(exit.marker, Math.max(0, (exit.until - now) / exit.durationMs));
          }
        }
        const drawTrail = (
          marker: typeof model.grenades extends Map<string, infer V> ? V : never,
          alpha: number,
        ) => {
          if (marker.trail.length < 2) return;
          ctx.save();
          ctx.strokeStyle = sideColor(marker.side);
          ctx.lineWidth = 2;
          ctx.lineCap = 'round';
          ctx.setLineDash(appearance === 'esl' ? [] : [7, 6]);
          for (let index = 1; index < marker.trail.length; index += 1) {
            const before = pointAt(marker.trail[index - 1]!, marker.target.layer);
            const after = pointAt(marker.trail[index]!, marker.target.layer);
            if (before === null || after === null) continue;
            const tailOpacity = 0.2 + 0.8 * (index / (marker.trail.length - 1));
            ctx.globalAlpha = alpha * 0.72 * tailOpacity;
            ctx.beginPath();
            ctx.moveTo(before.x, before.y);
            ctx.lineTo(after.x, after.y);
            ctx.stroke();
          }
          ctx.restore();
        };
        for (const exit of model.exits.values()) {
          if (!exit.marker.positionAvailable) continue;
          const alpha = Math.max(0, (exit.until - now) / exit.durationMs);
          drawTrail(exit.marker, alpha);
          const exitPoint = pointAt(exit.marker.target);
          if (exitPoint === null) continue;

          const kind = exit.marker.source.kind;
          if (exit.marker.phase === 'projectile' && kind === 'firebomb') {
            ctx.save();
            ctx.globalAlpha = alpha * layerOpacity(exit.marker.target, model.layer);
            const icon =
              exit.includeProjectileIcon && exit.marker.iconUrl && imageFor(exit.marker.iconUrl);
            if (icon) drawContainedImage(ctx, icon, exitPoint.x, exitPoint.y, 28, 28);
            ctx.restore();
          }
          if (
            exit.marker.source.moving !== undefined &&
            exit.marker.phase === 'projectile' &&
            (kind === 'frag' || kind === 'hegrenade')
          ) {
            ctx.save();
            ctx.globalAlpha = alpha * 0.8;
            ctx.strokeStyle = '#f3f6fa';
            ctx.lineWidth = 2.5;
            ctx.beginPath();
            ctx.arc(exitPoint.x, exitPoint.y, 10 + (1 - alpha) * 26, 0, Math.PI * 2);
            ctx.stroke();
            ctx.globalAlpha = alpha * 0.36;
            ctx.beginPath();
            ctx.arc(exitPoint.x, exitPoint.y, 5 + (1 - alpha) * 14, 0, Math.PI * 2);
            ctx.fillStyle = '#f0b45e';
            ctx.fill();
            ctx.restore();
            continue;
          }

          if (
            exit.marker.source.moving !== undefined &&
            exit.marker.phase === 'projectile' &&
            kind === 'flashbang'
          ) {
            ctx.save();
            ctx.translate(exitPoint.x, exitPoint.y);
            ctx.globalAlpha = alpha * 0.88;
            ctx.strokeStyle = '#ffffff';
            ctx.lineWidth = 2.5;
            for (let ray = 0; ray < 8; ray += 1) {
              const angle = (ray / 8) * Math.PI * 2;
              const inner = 5 + (1 - alpha) * 3;
              const outer = 14 + (1 - alpha) * 16;
              ctx.beginPath();
              ctx.moveTo(Math.cos(angle) * inner, Math.sin(angle) * inner);
              ctx.lineTo(Math.cos(angle) * outer, Math.sin(angle) * outer);
              ctx.stroke();
            }
            ctx.globalAlpha = alpha * 0.7;
            circle(0, 0, 6 + (1 - alpha) * 4, '#ffffff');
            ctx.restore();
          }
          if (
            exit.marker.phase === 'projectile' &&
            exit.includeProjectileIcon &&
            kind !== 'firebomb' &&
            (exit.marker.source.moving === undefined ||
              (kind !== 'frag' && kind !== 'hegrenade' && kind !== 'flashbang'))
          ) {
            const icon = exit.marker.iconUrl && imageFor(exit.marker.iconUrl);
            ctx.save();
            ctx.globalAlpha = alpha * layerOpacity(exit.marker.target, model.layer);
            if (icon) drawContainedImage(ctx, icon, exitPoint.x, exitPoint.y, 28, 28);
            ctx.restore();
          }
        }
        for (const marker of model.grenades.values()) {
          if (!marker.positionAvailable || marker.phase !== 'projectile') continue;
          drawTrail(marker, 1);
          const point = pointAt({ ...marker.target, x: marker.x, y: marker.y });
          if (point === null) continue;
          const x = point.x;
          const y = point.y;
          ctx.globalAlpha = layerOpacity(marker.target, model.layer);
          const url = marker.iconUrl;
          const icon = url && imageFor(url);
          if (icon) drawContainedImage(ctx, icon, x, y, 28, 28);
          else {
            ctx.fillStyle = '#ecedef';
            ctx.fillRect(x - 6, y - 6, 12, 12);
          }
          ctx.globalAlpha = 1;
        }
        const bomb = payload.bomb;
        const bombIcon = imageFor(bombIconPath);
        if (
          bomb &&
          bomb.state !== 'carried' &&
          bomb.state !== 'unknown' &&
          !(bomb.state === 'planting' && bomb.sourcePlayerId !== null) &&
          model.bombVisible(now)
        ) {
          const p = bomb.position;
          if (p && !p.outOfBounds) {
            const point = pointAt(p);
            if (point !== null) {
              const x = point.x;
              const y = point.y;
              ctx.globalAlpha = layerOpacity(p, model.layer);
              if (appearance === 'esl' && (bomb.state === 'planted' || bomb.state === 'defusing')) {
                // A local decorative pulse, independent of the accepted objective clock.
                const phase = reduceMotion ? 0.5 : (now % 2000) / 2000;
                ctx.save();
                ctx.globalAlpha *= (1 - phase) * 0.5;
                circle(x, y, (24 + phase * 80) / z.scale, '#ff0000');
                ctx.restore();
              }
              if (bombIcon) ctx.drawImage(bombIcon, x - 18, y - 18, 36, 36);
              ctx.globalAlpha = 1;
            }
          }
        }
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
          ctx.globalAlpha = layerOpacity(marker.target, model.layer);
          if (appearance === 'esl' && markerKind === 'dead') {
            ctx.globalAlpha *= 0.2;
            ctx.fillStyle = color;
            ctx.font = `900 ${48 / z.scale}px ESLLegend, SourceHanSans, sans-serif`;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(p.label ?? '', x, y + 1);
            ctx.globalAlpha = 1;
            continue;
          }
          if (markerKind === 'dead') {
            ctx.strokeStyle = color;
            ctx.lineWidth = 7;
            ctx.beginPath();
            ctx.moveTo(x - 19, y - 19);
            ctx.lineTo(x + 19, y + 19);
            ctx.moveTo(x - 19, y + 19);
            ctx.lineTo(x + 19, y - 19);
            ctx.stroke();
            ctx.globalAlpha = 1;
            continue;
          }
          if (appearance === 'esl') {
            const observed = payload.observedPlayerSourceId === p.sourcePlayerId;
            const radius = (observed ? 30 : 27.5) / z.scale;
            if (p.facing) {
              ctx.save();
              ctx.translate(x, y);
              ctx.rotate((marker.angle * Math.PI) / 180);
              const direction = imageFor('brand/hud/esl/playerBg.png');
              if (direction) {
                ctx.save();
                ctx.rotate((135 * Math.PI) / 180);
                ctx.drawImage(
                  direction,
                  -radius * 1.15,
                  -radius * 1.15,
                  radius * 2.3,
                  radius * 2.3,
                );
                ctx.restore();
              }
              if (marker.shootingUntil > now) {
                const fire = imageFor('brand/hud/esl/shootFire.png');
                if (fire) {
                  ctx.globalAlpha *= reduceMotion || Math.floor(now / 125) % 2 === 0 ? 1 : 0;
                  ctx.drawImage(fire, 0, -radius * 2, radius * 4, radius * 4);
                }
              }
              ctx.restore();
            }
            const flashRatio =
              p.flashAmount != null ? Math.min(1, Math.max(0, p.flashAmount / 255)) : 0;
            circle(x, y, radius, markerFill);
            if (flashRatio > 0) {
              ctx.globalAlpha *= flashRatio;
              circle(x, y, radius, '#ffffff');
              ctx.globalAlpha = layerOpacity(marker.target, model.layer);
            }
            ctx.fillStyle = '#000000';
            ctx.font = `900 ${48 / z.scale}px ESLLegend, SourceHanSans, sans-serif`;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(p.label ?? '', x, y + 1);
            ctx.globalAlpha = 1;
            continue;
          }
          if (payload.observedPlayerSourceId === p.sourcePlayerId)
            circle(x, y, 33, '#00000000', '#ffffff', 4);
          if (p.facing) {
            ctx.save();
            ctx.translate(x, y);
            ctx.rotate((marker.angle * Math.PI) / 180);
            ctx.beginPath();
            ctx.moveTo(41, 0);
            ctx.lineTo(18, -12);
            ctx.lineTo(18, 12);
            ctx.closePath();
            ctx.fillStyle = color;
            ctx.fill();
            if (marker.shootingUntil > now) {
              ctx.fillStyle = '#fff4b0';
              ctx.fillRect(38, -4, 15, 8);
            }
            ctx.restore();
          }
          const flashRatio =
            p.flashAmount != null ? Math.min(1, Math.max(0, p.flashAmount / 255)) : 0;
          circle(x, y, 29, '#f3f6fa');
          circle(x, y, 25, markerFill, '#0b1119', 2);
          if (flashRatio > 0) {
            ctx.globalAlpha = flashRatio * 0.9;
            circle(x, y, 24, '#ffffff');
            ctx.globalAlpha = layerOpacity(marker.target, model.layer);
          }
          ctx.fillStyle = flashRatio > 0.72 ? '#5d6670' : '#0b1119';
          ctx.font = '800 28px Inter, sans-serif';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(p.label ?? '', x, y + 1);
          if (marker.damageUntil > now) {
            const damageAlpha = Math.max(
              0,
              Math.min(1, (marker.damageUntil - now) / RADAR_PRESENTATION.damageMs),
            );
            ctx.save();
            ctx.translate(x, y);
            ctx.rotate((marker.angle * Math.PI) / 180);
            ctx.globalAlpha = damageAlpha * 0.95;
            ctx.strokeStyle = '#ff6c69';
            ctx.lineWidth = 5;
            ctx.lineCap = 'round';
            ctx.beginPath();
            ctx.arc(0, 0, 31, Math.PI * 0.72, Math.PI * 1.28);
            ctx.stroke();
            ctx.restore();
          }
          ctx.globalAlpha = 1;
        }
      }
      ctx.restore();
      if (!payload) {
        // Safe fail-closed presentation without disruptive center placeholder
      }
      frame = requestAnimationFrame(render);
    };
    frame = requestAnimationFrame(render);
    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      unsubscribe?.();
      model.reset();
      images.clear();
    };
  }, [client, zoomMode, assetBaseUrl, appearance]);
  return (
    <canvas
      aria-label="比赛雷达"
      className={['mizar-radar-view', className].filter(Boolean).join(' ')}
      ref={canvas}
    />
  );
}

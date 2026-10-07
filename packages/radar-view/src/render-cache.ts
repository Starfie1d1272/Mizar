import { RADAR_CANVAS_GEOMETRY, type RadarCanvasPlacement } from './canvas-geometry.js';
import { smokeLobes } from './effect-geometry.js';

export function radarArtworkFilter(
  appearance: 'default' | 'shanghai' | 'esl',
  rasterScale = 1,
): string {
  if (appearance === 'esl') return 'none';
  const outline = 3 * rasterScale;
  return (
    (appearance === 'shanghai'
      ? 'grayscale(1) contrast(1.08) '
      : 'grayscale(0.82) saturate(0.1) contrast(1.16) ') +
    `drop-shadow(${outline}px 0 0 rgba(243,246,250,.72)) ` +
    `drop-shadow(-${outline}px 0 0 rgba(243,246,250,.72)) ` +
    `drop-shadow(0 ${outline}px 0 rgba(243,246,250,.72)) ` +
    `drop-shadow(0 -${outline}px 0 rgba(243,246,250,.72))`
  );
}

/** Per-surface, bounded raster cache. Geometry remains owned by radar's calibration. */
export class RadarRenderCache {
  private readonly entries = new Map<string, HTMLCanvasElement>();

  clear(): void {
    this.entries.clear();
  }

  private get(
    key: string,
    width: number,
    height: number,
    draw: (context: CanvasRenderingContext2D) => void,
  ): HTMLCanvasElement | null {
    const prior = this.entries.get(key);
    if (prior) {
      this.entries.delete(key);
      this.entries.set(key, prior);
      return prior;
    }
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.ceil(width));
    canvas.height = Math.max(1, Math.ceil(height));
    const context = canvas.getContext('2d');
    if (!context) return null;
    draw(context);
    this.entries.set(key, canvas);
    while (this.entries.size > 48) this.entries.delete(this.entries.keys().next().value!);
    return canvas;
  }

  artwork(
    image: HTMLImageElement,
    placement: RadarCanvasPlacement | null,
    size: number,
    appearance: 'default' | 'shanghai' | 'esl',
  ): HTMLCanvasElement | null {
    const logical = RADAR_CANVAS_GEOMETRY.logicalSize;
    // Keep map detail available during focus zoom, including compact surfaces.
    const rasterSize = Math.max(size, Math.min(logical, size * 2));
    return this.get(
      JSON.stringify(['map', image.src, placement, size, appearance]),
      rasterSize,
      rasterSize,
      (ctx) => {
        ctx.setTransform(rasterSize / logical, 0, 0, rasterSize / logical, 0, 0);
        // A thin logical outline scales with the radar surface and its DPI.
        ctx.filter = radarArtworkFilter(appearance, rasterSize / logical);
        if (placement) {
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
        } else {
          ctx.drawImage(
            image,
            RADAR_CANVAS_GEOMETRY.inset,
            RADAR_CANVAS_GEOMETRY.inset,
            RADAR_CANVAS_GEOMETRY.artworkSize,
            RADAR_CANVAS_GEOMETRY.artworkSize,
          );
        }
      },
    );
  }

  smoke(seed: string): HTMLCanvasElement | null {
    const radius = 128;
    return this.get(`smoke:${seed}`, radius * 2, radius * 2, (ctx) => {
      ctx.translate(radius, radius);
      ctx.beginPath();
      ctx.arc(0, 0, radius, 0, Math.PI * 2);
      ctx.fillStyle = '#eef1f23d';
      ctx.fill();
      ctx.clip();
      for (const lobe of smokeLobes(seed, radius)) {
        const fill = ctx.createRadialGradient(lobe.dx, lobe.dy, 0, lobe.dx, lobe.dy, lobe.radius);
        fill.addColorStop(0, '#ffffffb8');
        fill.addColorStop(0.48, '#f4f6f69a');
        fill.addColorStop(0.82, '#e2e6e76e');
        fill.addColorStop(1, '#d5dadd12');
        ctx.fillStyle = fill;
        ctx.beginPath();
        ctx.arc(lobe.dx, lobe.dy, lobe.radius, 0, Math.PI * 2);
        ctx.fill();
      }
    });
  }

  glow(radius: number, blurRadius = 5): HTMLCanvasElement | null {
    // Auto zoom changes the inverse screen-space blur every frame. Quantize
    // raster precision, not world geometry or motion, to reuse near-identical
    // masks (at most 1/8 logical pixel difference in the blur radius).
    const blur = Math.round(blurRadius * 4) / 4;
    const extent = Math.ceil(radius * 1.45 + blur * 3);
    return this.get(`fire:${radius}:${blur}`, extent * 2, extent * 2, (ctx) => {
      ctx.filter = `blur(${blur}px)`;
      ctx.fillStyle = '#e85f2f';
      ctx.beginPath();
      ctx.arc(extent, extent, radius * 1.45, 0, Math.PI * 2);
      ctx.fill();
    });
  }

  tint(image: HTMLImageElement, color: string): HTMLCanvasElement | null {
    return this.get(
      `tint:${image.src}:${color}`,
      image.naturalWidth,
      image.naturalHeight,
      (ctx) => {
        ctx.drawImage(image, 0, 0);
        ctx.globalCompositeOperation = 'source-in';
        ctx.fillStyle = color;
        ctx.fillRect(0, 0, image.naturalWidth, image.naturalHeight);
      },
    );
  }
}

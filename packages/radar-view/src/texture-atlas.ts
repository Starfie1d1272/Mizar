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

interface TextureEntry {
  readonly texture: WebGLTexture;
  readonly width: number;
  readonly height: number;
}

const MAX_TEXTURE_CACHE_ENTRIES = 64;

/**
 * Per-WebGL2-context LRU texture cache for static map artwork, icons,
 * procedural smoke puffs, site badges, and player number labels.
 */
export class RadarTextureAtlas {
  private readonly entries = new Map<string, TextureEntry>();
  private readonly scratchCanvas: HTMLCanvasElement;
  private readonly scratchCtx: CanvasRenderingContext2D | null;

  constructor() {
    this.scratchCanvas = document.createElement('canvas');
    this.scratchCtx = this.scratchCanvas.getContext('2d');
  }

  clear(gl: WebGL2RenderingContext): void {
    for (const entry of this.entries.values()) {
      gl.deleteTexture(entry.texture);
    }
    this.entries.clear();
  }

  private getOrCreate(
    gl: WebGL2RenderingContext,
    key: string,
    width: number,
    height: number,
    draw: (ctx: CanvasRenderingContext2D, w: number, h: number) => void,
  ): TextureEntry | null {
    const existing = this.entries.get(key);
    if (existing) {
      this.entries.delete(key);
      this.entries.set(key, existing);
      return existing;
    }

    const ctx = this.scratchCtx;
    if (!ctx) return null;

    const w = Math.max(1, Math.ceil(width));
    const h = Math.max(1, Math.ceil(height));
    if (this.scratchCanvas.width !== w || this.scratchCanvas.height !== h) {
      this.scratchCanvas.width = w;
      this.scratchCanvas.height = h;
    } else {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, w, h);
    }
    ctx.filter = 'none';
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    draw(ctx, w, h);

    const texture = gl.createTexture();
    if (!texture) return null;
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, this.scratchCanvas);

    const entry: TextureEntry = { texture, width: w, height: h };
    this.entries.set(key, entry);
    while (this.entries.size > MAX_TEXTURE_CACHE_ENTRIES) {
      const oldestKey = this.entries.keys().next().value;
      if (oldestKey === undefined) break;
      const oldest = this.entries.get(oldestKey);
      this.entries.delete(oldestKey);
      if (oldest) gl.deleteTexture(oldest.texture);
    }
    return entry;
  }

  artwork(
    gl: WebGL2RenderingContext,
    image: HTMLImageElement,
    placement: RadarCanvasPlacement | null,
    size: number,
    appearance: 'default' | 'shanghai' | 'esl',
  ): TextureEntry | null {
    const logical = RADAR_CANVAS_GEOMETRY.logicalSize;
    const rasterSize = Math.max(size, Math.min(logical, size * 2));
    const key = `map:${image.src}:${appearance}:${rasterSize}:${
      placement
        ? `${placement.viewport.x},${placement.viewport.y},${placement.viewport.width},${placement.viewport.height}|${placement.rect.x},${placement.rect.y},${placement.rect.width},${placement.rect.height}`
        : 'full'
    }`;
    return this.getOrCreate(gl, key, rasterSize, rasterSize, (ctx) => {
      ctx.setTransform(rasterSize / logical, 0, 0, rasterSize / logical, 0, 0);
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
    });
  }

  smoke(gl: WebGL2RenderingContext, seed: string): TextureEntry | null {
    const radius = 128;
    return this.getOrCreate(gl, `smoke:${seed}`, radius * 2, radius * 2, (ctx) => {
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

  image(
    gl: WebGL2RenderingContext,
    image: HTMLImageElement,
    tintColor?: string,
  ): TextureEntry | null {
    if (!image.complete || image.naturalWidth <= 0 || image.naturalHeight <= 0) return null;
    const key = tintColor ? `img:${image.src}:tint:${tintColor}` : `img:${image.src}`;
    return this.getOrCreate(gl, key, image.naturalWidth, image.naturalHeight, (ctx, w, h) => {
      ctx.drawImage(image, 0, 0, w, h);
      if (tintColor) {
        ctx.globalCompositeOperation = 'source-in';
        ctx.fillStyle = tintColor;
        ctx.fillRect(0, 0, w, h);
      }
    });
  }

  label(
    gl: WebGL2RenderingContext,
    text: string,
    fontSpec: string,
    color: string,
    pixelSize = 64,
  ): TextureEntry | null {
    if (!text) return null;
    const key = `lbl:${text}:${fontSpec}:${color}:${pixelSize}`;
    return this.getOrCreate(gl, key, pixelSize, pixelSize, (ctx, w, h) => {
      ctx.font = fontSpec;
      ctx.fillStyle = color;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(text, w / 2, h / 2 + 1);
    });
  }

  siteBadge(gl: WebGL2RenderingContext, label: 'A' | 'B'): TextureEntry | null {
    const size = 112;
    return this.getOrCreate(gl, `site:${label}`, size, size, (ctx, w, h) => {
      ctx.fillStyle = '#f3ce22';
      ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = '#0b1119';
      ctx.font = '900 64px Inter, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, w / 2, h / 2 + 2);
    });
  }
}

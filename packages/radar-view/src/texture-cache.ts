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

export interface TextureRegion {
  readonly texture: WebGLTexture;
  readonly width: number;
  readonly height: number;
  readonly u0: number;
  readonly v0: number;
  readonly u1: number;
  readonly v1: number;
}

const MAX_TEXTURE_CACHE_ENTRIES = 64;
const GRID_GLYPHS = '0123456789AB';
const GRID_COLS = 4;
const GRID_CELL = 64;

/**
 * Bounded LRU texture cache for map artwork, icons, procedural smoke puffs,
 * and shared static glyph grids (0-9, A, B). Texture upload/binding is delegated
 * to WebGL2RadarRenderer so GL texture state has a single owner.
 */
export class RadarTextureCache {
  private readonly entries = new Map<string, TextureRegion>();
  private readonly scratchCanvas: HTMLCanvasElement;
  private readonly scratchCtx: CanvasRenderingContext2D | null;
  private readonly uploadTexture: (canvas: HTMLCanvasElement) => WebGLTexture | null;
  private readonly deleteTexture: (texture: WebGLTexture) => void;

  constructor(
    uploadTexture: (canvas: HTMLCanvasElement) => WebGLTexture | null,
    deleteTexture: (texture: WebGLTexture) => void,
  ) {
    this.uploadTexture = uploadTexture;
    this.deleteTexture = deleteTexture;
    this.scratchCanvas = document.createElement('canvas');
    this.scratchCtx = this.scratchCanvas.getContext('2d');
  }

  clear(): void {
    for (const entry of this.entries.values()) {
      this.deleteTexture(entry.texture);
    }
    this.entries.clear();
  }

  clearGlyphs(): void {
    for (const [key, entry] of this.entries) {
      if (key.startsWith('grid:') || key.startsWith('lbl:')) {
        this.deleteTexture(entry.texture);
        this.entries.delete(key);
      }
    }
  }

  private getOrCreate(
    key: string,
    width: number,
    height: number,
    draw: (ctx: CanvasRenderingContext2D, w: number, h: number) => void,
  ): TextureRegion | null {
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
    }
    ctx.save();
    try {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, w, h);
      ctx.filter = 'none';
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
      draw(ctx, w, h);
    } finally {
      ctx.restore();
    }

    const texture = this.uploadTexture(this.scratchCanvas);
    if (!texture) return null;

    const entry: TextureRegion = { texture, width: w, height: h, u0: 0, v0: 0, u1: 1, v1: 1 };
    this.entries.set(key, entry);
    while (this.entries.size > MAX_TEXTURE_CACHE_ENTRIES) {
      const oldestKey = this.entries.keys().next().value;
      if (oldestKey === undefined) break;
      const oldest = this.entries.get(oldestKey);
      this.entries.delete(oldestKey);
      if (oldest) this.deleteTexture(oldest.texture);
    }
    return entry;
  }

  artwork(
    image: HTMLImageElement,
    placement: RadarCanvasPlacement | null,
    size: number,
    appearance: 'default' | 'shanghai' | 'esl',
  ): TextureRegion | null {
    const logical = RADAR_CANVAS_GEOMETRY.logicalSize;
    const rasterSize = Math.max(size, Math.min(logical, size * 2));
    const key = `map:${image.src}:${appearance}:${rasterSize}:${
      placement
        ? `${placement.viewport.x},${placement.viewport.y},${placement.viewport.width},${placement.viewport.height}|${placement.rect.x},${placement.rect.y},${placement.rect.width},${placement.rect.height}`
        : 'full'
    }`;
    return this.getOrCreate(key, rasterSize, rasterSize, (ctx) => {
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

  smoke(seed: string): TextureRegion | null {
    const radius = 128;
    return this.getOrCreate(`smoke:${seed}`, radius * 2, radius * 2, (ctx) => {
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

  image(image: HTMLImageElement, tintColor?: string): TextureRegion | null {
    if (!image.complete || image.naturalWidth <= 0 || image.naturalHeight <= 0) return null;
    const key = tintColor ? `img:${image.src}:tint:${tintColor}` : `img:${image.src}`;
    return this.getOrCreate(key, image.naturalWidth, image.naturalHeight, (ctx, w, h) => {
      ctx.drawImage(image, 0, 0, w, h);
      if (tintColor) {
        ctx.globalCompositeOperation = 'source-in';
        ctx.fillStyle = tintColor;
        ctx.fillRect(0, 0, w, h);
      }
    });
  }

  /**
   * Returns a UV region inside a shared 4x4 static glyph grid for 0-9, A, B;
   * falls back to a per-string cached texture for custom multi-character labels.
   */
  glyph(text: string, fontSpec: string, color: string): TextureRegion | null {
    if (!text) return null;
    const idx = text.length === 1 ? GRID_GLYPHS.indexOf(text) : -1;
    if (idx !== -1) {
      const gridSize = GRID_COLS * GRID_CELL;
      const base = this.getOrCreate(`grid:${fontSpec}:${color}`, gridSize, gridSize, (ctx) => {
        ctx.font = fontSpec;
        ctx.fillStyle = color;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        for (let i = 0; i < GRID_GLYPHS.length; i += 1) {
          const col = i % GRID_COLS;
          const row = Math.floor(i / GRID_COLS);
          ctx.fillText(
            GRID_GLYPHS[i]!,
            col * GRID_CELL + GRID_CELL * 0.5,
            row * GRID_CELL + GRID_CELL * 0.5,
          );
        }
      });
      if (!base) return null;
      const col = idx % GRID_COLS;
      const row = Math.floor(idx / GRID_COLS);
      const cellUv = 1 / GRID_COLS;
      return {
        texture: base.texture,
        width: GRID_CELL,
        height: GRID_CELL,
        u0: col * cellUv,
        v0: row * cellUv,
        u1: (col + 1) * cellUv,
        v1: (row + 1) * cellUv,
      };
    }

    return this.getOrCreate(
      `lbl:${text}:${fontSpec}:${color}`,
      GRID_CELL,
      GRID_CELL,
      (ctx, w, h) => {
        ctx.font = fontSpec;
        ctx.fillStyle = color;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(text, w / 2, h / 2);
      },
    );
  }
}

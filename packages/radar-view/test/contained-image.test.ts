import { describe, expect, it, vi } from 'vitest';

import { drawContainedImage } from '../src/draw-contained-image.js';

describe('Radar contained image geometry', () => {
  it.each([
    [15, 32, 28, 28], // Real smoke asset: tall image in a square box.
    [32, 15, 28, 28],
    [20, 20, 80, 30],
    [120, 60, 30, 80],
  ])(
    'contains %s×%s in %s×%s without distortion',
    (imageWidth, imageHeight, boxWidth, boxHeight) => {
      const drawImage = vi.fn();
      const image = { naturalWidth: imageWidth, naturalHeight: imageHeight } as HTMLImageElement;
      const centerX = 50;
      const centerY = -12;
      const bounds = drawContainedImage(
        { drawImage },
        image,
        centerX,
        centerY,
        boxWidth,
        boxHeight,
      );

      expect(bounds).not.toBeNull();
      const { x, y, width, height } = bounds!;
      expect(width).toBeGreaterThan(0);
      expect(height).toBeGreaterThan(0);
      expect(width / height).toBeCloseTo(imageWidth / imageHeight, 12);
      expect(x + width / 2).toBeCloseTo(centerX, 12);
      expect(y + height / 2).toBeCloseTo(centerY, 12);
      expect(width).toBeLessThanOrEqual(boxWidth);
      expect(height).toBeLessThanOrEqual(boxHeight);
      expect(width === boxWidth || height === boxHeight).toBe(true);
      // The geometry must reach the renderer, not just be returned to the caller.
      expect(drawImage).toHaveBeenCalledWith(image, x, y, width, height);
    },
  );

  it('uses canvas dimensions for canvas-backed images', () => {
    const drawImage = vi.fn();
    const image = { width: 40, height: 20 } as HTMLCanvasElement;
    const bounds = drawContainedImage({ drawImage }, image, 0, 0, 40, 40);
    expect(bounds).toEqual({ x: -20, y: -10, width: 40, height: 20 });
    expect(drawImage).toHaveBeenCalledWith(image, -20, -10, 40, 20);
  });

  it.each([
    [0, 32, 28, 28],
    [15, 0, 28, 28],
    [15, 32, 0, 28],
    [15, 32, 28, 0],
    [-1, 32, 28, 28],
    [15, -1, 28, 28],
    [15, 32, -1, 28],
    [15, 32, 28, -1],
  ])(
    'does not draw non-positive dimensions %s×%s into %s×%s',
    (naturalWidth, naturalHeight, boxWidth, boxHeight) => {
      const drawImage = vi.fn();
      const image = { naturalWidth, naturalHeight } as HTMLImageElement;
      expect(drawContainedImage({ drawImage }, image, 0, 0, boxWidth, boxHeight)).toBeNull();
      expect(drawImage).not.toHaveBeenCalled();
    },
  );
});

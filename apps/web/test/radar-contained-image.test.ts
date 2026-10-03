import { describe, expect, it, vi } from 'vitest';

import { drawContainedImage } from '@mizar-hud/radar-view/images';

describe('Radar contained projectile assets', () => {
  it('preserves the 15:32 smoke asset ratio inside a 28 by 28 box', () => {
    const drawImage = vi.fn();
    const context = {
      drawImage: drawImage as unknown as CanvasRenderingContext2D['drawImage'],
    };
    const image = { naturalWidth: 15, naturalHeight: 32 } as HTMLImageElement;

    const bounds = drawContainedImage(context, image, 50, 50, 28, 28);

    expect(bounds).not.toBeNull();
    expect(bounds!.width / bounds!.height).toBeCloseTo(15 / 32, 12);
    expect(bounds).toMatchObject({ x: 43.4375, y: 36, width: 13.125, height: 28 });
    expect(drawImage).toHaveBeenCalledWith(image, 43.4375, 36, 13.125, 28);
  });
});

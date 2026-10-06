// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { RadarRenderCache } from '../src/render-cache.js';

afterEach(() => vi.restoreAllMocks());

it('rasterizes static artwork/effects once and rebuilds for resolution, appearance, tint and explicit invalidation', () => {
  const gradient = { addColorStop: vi.fn() };
  const radial = vi.fn(() => gradient);
  const draw = vi.fn();
  const context = new Proxy(
    {},
    { get: (_, key) => (key === 'createRadialGradient' ? radial : draw), set: () => true },
  ) as CanvasRenderingContext2D;
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context);
  const image = new Image();
  image.src = '/map.png';
  Object.defineProperties(image, { naturalWidth: { value: 1024 }, naturalHeight: { value: 1024 } });
  const cache = new RadarRenderCache();
  const map = cache.artwork(image, null, 539, 'default');
  expect(cache.artwork(image, null, 539, 'default')).toBe(map);
  expect(cache.artwork(image, null, 1080, 'default')).not.toBe(map);
  expect(cache.artwork(image, null, 539, 'esl')).not.toBe(map);
  const smoke = cache.smoke('actual-entity-95');
  expect(radial).toHaveBeenCalledTimes(9);
  expect(cache.smoke('actual-entity-95')).toBe(smoke);
  expect(radial).toHaveBeenCalledTimes(9);
  const icon = cache.tint(image, '#ff0000');
  expect(cache.tint(image, '#ff0000')).toBe(icon);
  expect(cache.tint(image, '#ffffff')).not.toBe(icon);
  const glow = cache.glow(24);
  expect(cache.glow(24)).toBe(glow);
  cache.clear();
  expect(cache.artwork(image, null, 539, 'default')).not.toBe(map);
  expect(cache.smoke('actual-entity-95')).not.toBe(smoke);
  expect(radial).toHaveBeenCalledTimes(18);
});

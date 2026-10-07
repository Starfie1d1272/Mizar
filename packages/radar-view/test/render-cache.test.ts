// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { RadarRenderCache } from '../src/render-cache.js';

afterEach(() => vi.restoreAllMocks());

it('reuses fire rasters during continuous auto zoom instead of allocating a canvas every frame', () => {
  const draw = vi.fn();
  const context = new Proxy({}, { get: () => draw, set: () => true }) as CanvasRenderingContext2D;
  const getContext = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context);
  const image = new Image();
  image.src = '/map.png';
  Object.defineProperties(image, { naturalWidth: { value: 1024 }, naturalHeight: { value: 1024 } });
  const cache = new RadarRenderCache();
  const map = cache.artwork(image, null, 506, 'default');
  for (let frame = 0; frame < 240; frame++) {
    const scale = 1 + (1.5 * frame) / 239;
    expect(cache.artwork(image, null, 506, 'default')).toBe(map);
    cache.glow(24, (5 * 1024) / (506 * scale));
  }
  // The renderer's normal 1→2.5 zoom must not make each frame a new raster.
  expect(getContext.mock.calls.length).toBeLessThan(32);
  const rasterCount = getContext.mock.calls.length;
  for (let frame = 0; frame < 240; frame++) {
    const scale = 1 + (1.5 * frame) / 239;
    cache.glow(24, (5 * 1024) / (506 * scale));
  }
  expect(getContext.mock.calls.length).toBe(rasterCount);
});

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

it('keeps the hot map reusable and evicts cold fire rasters during compact-surface auto zoom', () => {
  const draw = vi.fn();
  const context = new Proxy({}, { get: () => draw, set: () => true }) as CanvasRenderingContext2D;
  const getContext = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context);
  const image = new Image();
  image.src = '/map.png';
  Object.defineProperties(image, { naturalWidth: { value: 1024 }, naturalHeight: { value: 1024 } });
  const cache = new RadarRenderCache();
  const map = cache.artwork(image, null, 256, 'default');
  const firstBlur = (5 * 1024) / 256;
  const firstFire = cache.glow(24, firstBlur);
  let lastFire;
  let lastBlur = firstBlur;
  for (let frame = 0; frame < 240; frame++) {
    const scale = 1 + (1.5 * frame) / 239;
    expect(cache.artwork(image, null, 256, 'default')).toBe(map);
    lastBlur = (5 * 1024) / (256 * scale);
    lastFire = cache.glow(24, lastBlur);
  }
  // Compact surfaces span more blur buckets than the shared cache can retain.
  // The hot map survives pressure; recent effects reuse, while cold masks leave.
  expect(getContext.mock.calls.length).toBeGreaterThan(48);
  expect(getContext.mock.calls.length).toBeLessThan(64);
  expect(cache.artwork(image, null, 256, 'default')).toBe(map);
  expect(cache.glow(24, lastBlur)).toBe(lastFire);
  expect(cache.glow(24, firstBlur)).not.toBe(firstFire);
  expect(cache.artwork(image, null, 256, 'default')).toBe(map);
});

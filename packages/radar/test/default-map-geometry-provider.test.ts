import { describe, expect, it } from 'vitest';
import { defaultMapGeometryProvider } from '../src/default-map-geometry-provider.js';
import { classifyRadarLayer, projectWorldPosition } from '../src/map-geometry.js';

// Pinned CS2 overview coordinates are an independent geometry oracle.
const CALIBRATIONS = [
  ['de_dust2', -2476, 3239, 4.4],
  ['de_mirage', -3230, 1713, 5],
  ['de_inferno', -2087, 3870, 4.9],
  ['de_nuke', -3453, 2887, 7],
  ['de_ancient', -2953, 2164, 5],
  ['de_anubis', -2796, 3328, 5.22],
  ['de_cache', -2000, 3250, 5.5],
  ['de_overpass', -4831, 1781, 5.2],
  ['de_train', -2308, 2078, 4.082077],
  ['de_vertigo', -3168, 1762, 4],
] as const;

describe('default radar map geometry provider', () => {
  it.each(CALIBRATIONS)('projects the pinned %s overview coordinates', (mapName, x, y, scale) => {
    const geometry = defaultMapGeometryProvider.resolve(mapName)!;
    const projected = projectWorldPosition(
      { x: x + scale * 512, y: y - scale * 512, z: 0 },
      geometry,
    );
    expect(projected?.x).toBeCloseTo(0.5, 12);
    expect(projected?.y).toBeCloseTo(0.5, 12);
    expect(projected?.outOfBounds).toBe(false);
  });
  it('supports only the explicit display aliases and rejects unknown maps', () => {
    const aliases = {
      dust2: 'de_dust2',
      'dust 2': 'de_dust2',
      'dust ii': 'de_dust2',
      mirage: 'de_mirage',
      inferno: 'de_inferno',
      nuke: 'de_nuke',
      ancient: 'de_ancient',
      anubis: 'de_anubis',
      cache: 'de_cache',
      overpass: 'de_overpass',
      train: 'de_train',
      vertigo: 'de_vertigo',
    } as const;

    for (const [alias, mapKey] of Object.entries(aliases)) {
      expect(defaultMapGeometryProvider.resolve(alias)?.mapKey).toBe(mapKey);
      expect(defaultMapGeometryProvider.resolve(`  ${alias.toUpperCase()} `)?.mapKey).toBe(mapKey);
    }

    for (const mapName of [null, '', 'de_workshop_custom', 'workshop/de_mirage', 'custom-map']) {
      expect(defaultMapGeometryProvider.resolve(mapName)).toBeNull();
    }
  });

  it('preserves calibration landmarks and split-map layer thresholds', () => {
    const mirage = defaultMapGeometryProvider.resolve('de_mirage');
    const nuke = defaultMapGeometryProvider.resolve('de_nuke');
    const cache = defaultMapGeometryProvider.resolve('de_cache');
    const train = defaultMapGeometryProvider.resolve('de_train');
    const vertigo = defaultMapGeometryProvider.resolve('de_vertigo');

    expect(mirage).not.toBeNull();
    expect(projectWorldPosition({ x: -3230, y: 1713, z: 0 }, mirage!)).toMatchObject({
      x: 0,
      y: 0,
      layer: 'single',
      outOfBounds: false,
    });
    const mirageBombA = projectWorldPosition({ x: -465.2, y: -2178.2, z: 0 }, mirage!);
    expect(mirageBombA?.x).toBeCloseTo(0.54, 12);
    expect(mirageBombA?.y).toBeCloseTo(0.76, 12);

    expect(nuke).not.toBeNull();
    expect(classifyRadarLayer(-496, nuke!)).toBe('lower');
    expect(classifyRadarLayer(-495, nuke!)).toBe('upper');
    expect(classifyRadarLayer(null, nuke!)).toBe('unknown');
    const nukeBombA = projectWorldPosition({ x: 704.44, y: -553.64, z: 0 }, nuke!);
    expect(nukeBombA?.x).toBeCloseTo(0.58, 12);
    expect(nukeBombA?.y).toBeCloseTo(0.48, 12);

    expect(cache).not.toBeNull();
    const cacheCenter = projectWorldPosition(
      { x: -2000 + (5.5 * 1024) / 2, y: 3250 - (5.5 * 1024) / 2, z: 0 },
      cache!,
    );
    expect(cacheCenter).toMatchObject({ x: 0.5, y: 0.5, outOfBounds: false, layer: 'single' });
    const cacheBombA = projectWorldPosition({ x: -169.6, y: 1785.68, z: 0 }, cache!);
    expect(cacheBombA?.x).toBeCloseTo(0.325, 12);
    expect(cacheBombA?.y).toBeCloseTo(0.26, 12);

    expect(train).not.toBeNull();
    expect(classifyRadarLayer(-51, train!)).toBe('lower');
    expect(classifyRadarLayer(-50, train!)).toBe('upper');
    expect(classifyRadarLayer(-49, train!)).toBe('upper');

    expect(vertigo).not.toBeNull();
    expect(classifyRadarLayer(11699, vertigo!)).toBe('lower');
    expect(classifyRadarLayer(11700, vertigo!)).toBe('upper');
    expect(classifyRadarLayer(11701, vertigo!)).toBe('upper');
  });
});

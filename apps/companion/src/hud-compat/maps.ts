import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { getRadarMapAsset } from '@mizar/cs2-assets';
import { defaultMapGeometryProvider, SUPPORTED_RADAR_MAP_KEYS } from '@mizar/radar';

export type LhmMap = {
  bytes: Buffer;
  config: { origin: { x: number; y: number }; pxPerUX: number; pxPerUY: number };
};

export async function loadLhmMaps(webRoot: string) {
  const maps = new Map<string, LhmMap>();
  for (const name of SUPPORTED_RADAR_MAP_KEYS) {
    const geometry = defaultMapGeometryProvider.resolve(name);
    const asset = getRadarMapAsset(name, 'overview');
    if (!geometry || geometry.layerRule.kind !== 'single' || !asset) continue;
    try {
      const bytes = await readFile(join(webRoot, asset.outputPath.slice(1)));
      if (createHash('sha256').update(bytes).digest('hex') !== asset.outputSha256) continue;
      const factor = 1024 / geometry.referenceSize.width / geometry.scaleWorldUnitsPerPixel;
      maps.set(name, {
        bytes,
        config: {
          origin: { x: -geometry.originWorld.x * factor, y: geometry.originWorld.y * factor },
          pxPerUX: factor,
          pxPerUY: -factor,
        },
      });
    } catch {
      /* Missing web assets remain unavailable. */
    }
  }
  return maps;
}

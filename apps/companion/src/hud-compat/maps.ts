import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { getRadarMapAsset, type RadarMapAsset } from '@mizar/cs2-assets';
import { defaultMapGeometryProvider, SUPPORTED_RADAR_MAP_KEYS } from '@mizar/radar';

type Config = { origin: { x: number; y: number }; pxPerUX: number; pxPerUY: number };
type Layer = {
  lhmId: string;
  originX: number;
  originY: number;
  pxPerUX: number;
  pxPerUY: number;
  visibleUnderHeight: number | null;
  visibleOverHeight: number | null;
};
export type LhmMap = { bytes: Buffer; mime: string; radars: Layer[]; config: Config | null };

async function readAsset(webRoot: string, asset: RadarMapAsset | null): Promise<Buffer> {
  if (!asset) throw new Error('Missing radar asset');
  const bytes = await readFile(join(webRoot, asset.outputPath.slice(1)));
  if (createHash('sha256').update(bytes).digest('hex') !== asset.outputSha256)
    throw new Error('Invalid radar asset');
  return bytes;
}

// The official client compares heights strictly. The predecessor includes the
// exact split height in the upper layer without changing the lower boundary.
function predecessor(value: number): number {
  if (value === 0) return -Number.MIN_VALUE;
  const data = new DataView(new ArrayBuffer(8));
  data.setFloat64(0, value);
  const bits = data.getBigUint64(0);
  data.setBigUint64(0, value > 0 ? bits - 1n : bits + 1n);
  return data.getFloat64(0);
}

export async function loadLhmMaps(webRoot: string) {
  const maps = new Map<string, LhmMap>();
  for (const name of SUPPORTED_RADAR_MAP_KEYS) {
    // The official template hard-codes Vertigo zoom origins for its own artwork.
    if (name === 'de_vertigo') continue;
    const geometry = defaultMapGeometryProvider.resolve(name);
    if (!geometry) continue;
    try {
      const factor = 1024 / geometry.referenceSize.width / geometry.scaleWorldUnitsPerPixel;
      const config: Config = {
        origin: { x: -geometry.originWorld.x * factor, y: geometry.originWorld.y * factor },
        pxPerUX: factor,
        pxPerUY: -factor,
      };
      if (geometry.layerRule.kind === 'single') {
        const bytes = await readAsset(webRoot, getRadarMapAsset(name, 'overview'));
        maps.set(name, {
          bytes,
          mime: 'image/png',
          config,
          radars: [
            {
              lhmId: 'default',
              originX: config.origin.x,
              originY: config.origin.y,
              pxPerUX: factor,
              pxPerUY: -factor,
              visibleUnderHeight: null,
              visibleOverHeight: null,
            },
          ],
        });
      } else {
        const upper = await readAsset(webRoot, getRadarMapAsset(name, 'upper'));
        const lower = await readAsset(webRoot, getRadarMapAsset(name, 'lower'));
        const image = (bytes: Buffer, y: number) =>
          `<image x="256" y="${y}" width="512" height="512" href="data:image/png;base64,${bytes.toString('base64')}"/>`;
        const bytes = Buffer.from(
          `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">${image(upper, 0)}${image(lower, 512)}</svg>`,
        );
        const layer = (
          lhmId: string,
          y: number,
          visibleUnderHeight: number | null,
          visibleOverHeight: number | null,
        ): Layer => ({
          lhmId,
          originX: 256 + config.origin.x / 2,
          originY: y + config.origin.y / 2,
          pxPerUX: factor / 2,
          pxPerUY: -factor / 2,
          visibleUnderHeight,
          visibleOverHeight,
        });
        maps.set(name, {
          bytes,
          mime: 'image/svg+xml',
          config: null,
          radars: [
            layer('upper', 0, predecessor(geometry.layerRule.splitZ), null),
            layer('lower', 512, null, geometry.layerRule.splitZ),
          ],
        });
      }
    } catch {
      /* Missing or damaged assets remain unavailable. */
    }
  }
  return maps;
}

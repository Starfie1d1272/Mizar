import { radarAssets } from './assets.generated.js';
import type { RadarLayer } from './types.js';
export interface RadarArtwork {
  readonly mapKey: string;
  readonly calibrationRevision: string;
  readonly layers: readonly RadarLayer[];
  readonly unitRadius: number;
  readonly artwork: Readonly<Partial<Record<'overview' | 'upper' | 'lower', string>>>;
}
export function getRadarArtwork(mapName: string): RadarArtwork | null {
  return (radarAssets.maps as Record<string, RadarArtwork>)[mapName] ?? null;
}
export function utilityIcon(name: string): string | null {
  return (radarAssets.icons as Record<string, string>)[name] ?? null;
}
export const bombIconPath = radarAssets.bomb;
/** Base points to the package's copied assets/ directory, including any CDN prefix. */
export function radarAssetUrl(path: string, base: string): string {
  return `${base.replace(/\/$/, '')}/${path.replace(/^\//, '')}`;
}

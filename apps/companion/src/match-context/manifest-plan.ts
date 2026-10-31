import { isDeepStrictEqual } from 'node:util';
import { createHash } from 'node:crypto';
import type { BroadcastManifest } from '@mizar/rivalhub';

/** Identity and plan only: scores and completion timestamps do not define a plan. */
export function manifestPlanIdentity(manifest: BroadcastManifest) {
  return {
    competitionId: manifest.match.competition?.competitionId ?? null,
    format: manifest.match.format,
    entryAId: manifest.entrants.a.entryId,
    entryBId: manifest.entrants.b.entryId,
    maps: manifest.maps.map((map) => ({
      mapId: map.mapId,
      mapOrder: map.mapOrder,
      mapName: map.mapName,
      pickedByEntryId: map.pickedByEntryId,
      teamAStartSide: map.teamAStartSide,
    })),
    veto: manifest.veto,
  };
}

export function sameManifestPlan(current: BroadcastManifest, next: BroadcastManifest): boolean {
  return isDeepStrictEqual(manifestPlanIdentity(current), manifestPlanIdentity(next));
}

/** Hash a canonical form of exactly the identity and plan used by the controller. */
export function manifestPlanFingerprint(manifest: BroadcastManifest): string {
  const canonical = (value: unknown): unknown => {
    if (value === undefined) return { $undefined: true };
    if (Array.isArray(value)) return value.map(canonical);
    if (value !== null && typeof value === 'object')
      return Object.fromEntries(
        Object.entries(value)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, item]) => [key, canonical(item)]),
      );
    return value;
  };
  return createHash('sha256')
    .update(JSON.stringify(canonical(manifestPlanIdentity(manifest))))
    .digest('hex');
}

import type { ProgramProjection } from '@mizar/core/projection';
import type { ProgramSceneId } from '@mizar/protocol/program-scenes';
import type { MusicGroup, MusicTrack } from '@mizar/protocol/music';
import { musicMapScope } from '../scope/identities.js';
import { isRegulationHalftime } from '../program-scenes/presentation.js';

export interface MusicTruth {
  program: ProgramProjection;
  active: ProgramSceneId;
  production: boolean;
}
export interface MusicCue {
  group: MusicGroup;
  key: string;
  track?: MusicTrack;
  scope?: string;
}
export const musicMapKey = musicMapScope;
export function musicPause(p: ProgramProjection) {
  return ['paused', 'timeout_ct', 'timeout_t'].includes(p.clock?.phase ?? '');
}
export function musicSafe(p: ProgramProjection) {
  return (
    p.status.context === 'fresh' &&
    p.status.identity !== 'mismatch' &&
    p.series?.bindingState === 'bound'
  );
}
/** Facts remain in Core. This consumer only maps trustworthy facts and actual presentation to cues. */
export function musicCue(truth: MusicTruth, pauseId: string | null): MusicCue | null {
  const { program: p, active, production } = truth;
  if (
    !production ||
    !p.match ||
    p.status.context !== 'fresh' ||
    p.status.identity === 'mismatch' ||
    p.series?.bindingState === 'needs_operator'
  )
    return null;
  const match = p.match.matchId,
    map = musicMapKey(p);
  const waiting = { group: 'waiting', key: `waiting:${match}` } as const;
  // A selected pre-game match need not have a game execution bound yet.
  if (
    (p.status.telemetry === 'awaiting' ||
      (p.status.telemetry === 'fresh' && p.map.name === null)) &&
    p.map.phase === null &&
    ['waiting', 'bp'].includes(active)
  )
    return waiting;
  if (!musicSafe(p) || p.status.telemetry !== 'fresh') return null;
  if (p.map.phase === 'gameover') {
    if (p.series?.status === 'completed')
      return ['map_result', 'match_result'].includes(active)
        ? { group: 'matchVictory', key: `matchVictory:${match}` }
        : null;
    if (
      ['map_result', 'intermap'].includes(active) &&
      p.series?.maps.some(
        (m) =>
          m.status === 'completed' &&
          m.finalScore &&
          m.mapName === p.map.name &&
          m.mapOrder === p.series?.currentMapOrder,
      )
    )
      return { group: 'mapVictory', key: `mapVictory:${map}` };
    return active === 'waiting' || active === 'bp' ? waiting : null;
  }
  // The same halftime survives paused -> freezetime until actual gameplay is due.
  const halftime =
    isRegulationHalftime(p) ||
    (active === 'halftime' && p.map.roundNumber === 12 && p.clock?.phase === 'freezetime');
  if (halftime) {
    const remaining = p.clock?.endsInSeconds;
    if (
      p.clock?.phase === 'freezetime' &&
      remaining !== null &&
      remaining !== undefined &&
      remaining <= 5
    )
      return null;
    return { group: 'halftime', key: `halftime:${map}` };
  }
  if (musicPause(p) && pauseId)
    return {
      group:
        p.clock?.phase === 'timeout_ct' || p.clock?.phase === 'timeout_t'
          ? 'tactical'
          : 'technical',
      key: `pause:${pauseId}`,
    };
  if (p.map.phase === 'warmup') return waiting;
  // Formal play always wins over a stale waiting / result picture.
  if (p.map.phase === 'live') return null;
  return ['waiting', 'bp', 'intermap'].includes(active) ? waiting : null;
}

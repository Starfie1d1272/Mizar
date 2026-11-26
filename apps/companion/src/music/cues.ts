import { completedSeriesMapForProgram, type ProgramProjection } from '@mizar/core/projection';
import type { ProgramPresentation, ProgramSceneId } from '@mizar/protocol/program-scenes';
import type { MusicGroup, MusicStatus, MusicTrack } from '@mizar/protocol/music';
import { musicMapScope, musicOpeningScope } from '../scope/identities.js';
import { hasFrozenMapResult, isRegulationHalftime } from '../program-scenes/presentation.js';
import type { MusicMediaState, MusicMonitorMode } from './device.js';

export interface MusicTruth {
  program: ProgramProjection;
  active: ProgramSceneId;
  production: boolean;
  presentation?: ProgramPresentation;
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
  if (!musicSafe(p)) return null;
  // Only a result already frozen for this execution can outlive live telemetry.
  const offlineResult =
    p.map.phase === 'gameover' &&
    ['map_result', 'intermap', 'match_result'].includes(active) &&
    truth.presentation !== undefined &&
    hasFrozenMapResult(p, truth.presentation);
  if (p.status.telemetry !== 'fresh' && !offlineResult) return null;
  if (p.map.phase === 'gameover') {
    if (p.series?.status === 'completed')
      return ['map_result', 'match_result'].includes(active)
        ? { group: 'matchVictory', key: `matchVictory:${match}` }
        : null;
    if (['map_result', 'intermap'].includes(active) && completedSeriesMapForProgram(p))
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

export function desiredMusicMonitorMode(wanted: boolean): MusicMonitorMode {
  return wanted ? 'monitor-and-output' : 'off';
}

export function observedPlayback(state: MusicMediaState): MusicStatus['playback'] {
  if (state === 'playing') return 'playing';
  if (state === 'paused') return 'paused';
  if (state === 'stopped' || state === 'ended') return 'stopped';
  return 'unknown';
}

export function tailVolume(
  track: MusicTrack,
  cursor: number | null,
  duration: number | null,
  volume: number,
  fadeOutMs: number,
): number {
  if (cursor === null || fadeOutMs <= 0) return volume;
  const end = Math.min(
    track.endMs ?? Infinity,
    duration !== null && duration > 0 ? duration : Infinity,
  );
  if (!Number.isFinite(end)) return volume;
  return volume * Math.min(1, Math.max(0, (end - cursor) / fadeOutMs));
}

export function resolveEffectiveBgmCue(
  truth: MusicTruth,
  map: string,
  pauseId: string | null,
  current: { readonly group: MusicGroup; readonly key: string; readonly finished: boolean } | null,
  consumed: readonly string[],
): MusicCue | null {
  let cue = musicCue(truth, pauseId);
  const waitingKey = `waiting:${truth.program.match?.matchId ?? ''}`;
  if (
    cue?.group === 'waiting' &&
    truth.program.map.phase === 'gameover' &&
    current?.group === 'mapVictory' &&
    !current.finished &&
    current.key === `mapVictory:${map}`
  )
    cue = { group: current.group, key: current.key };
  if (cue?.group === 'mapVictory' && truth.active === 'intermap' && current?.key !== cue.key)
    cue = { group: 'waiting', key: waitingKey };
  if (cue?.key.startsWith('pause:') && current?.key === cue.key)
    cue = { ...cue, group: current.group };
  if (cue?.group === 'mapVictory' && current?.key === cue.key && current.finished)
    cue = { group: 'waiting', key: waitingKey };
  if (cue && consumed.includes(cue.key))
    cue = cue.group === 'mapVictory' ? { group: 'waiting', key: waitingKey } : null;
  return cue;
}

export function resolveRetainedStingerCue(
  truth: MusicTruth,
  manual: boolean,
  held: boolean,
  stinger: {
    readonly key: string;
    readonly scope?: string | undefined;
    readonly track: MusicTrack;
    readonly finished: boolean;
  } | null,
): MusicCue | null {
  const safe =
    !manual &&
    truth.production &&
    musicSafe(truth.program) &&
    truth.program.status.telemetry === 'fresh' &&
    !held;
  return safe &&
    stinger &&
    !stinger.finished &&
    (!stinger.scope || stinger.scope === musicOpeningScope(truth.program))
    ? { group: 'opening', key: stinger.key, track: stinger.track }
    : null;
}

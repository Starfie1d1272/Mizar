import type { ProgramProjection } from '@mizar/core/projection';
import type { ProgramSceneId } from '@mizar/protocol/program-scenes';
import { isRegulationHalftime } from '../program-scenes/presentation.js';

export function gameAudioTruth(
  p: ProgramProjection,
  active: ProgramSceneId,
  production: boolean,
): 'halftime' | 'gameplay' | 'unknown' {
  if (
    !production ||
    p.status.context !== 'fresh' ||
    p.status.telemetry !== 'fresh' ||
    p.status.identity === 'mismatch' ||
    p.series?.bindingState !== 'bound'
  )
    return 'unknown';
  const half =
    (isRegulationHalftime(p) && (p.map.phase === 'intermission' || p.map.roundNumber === 12)) ||
    (active === 'halftime' && p.map.roundNumber === 12 && p.clock?.phase === 'freezetime');
  if (
    half &&
    !(
      p.clock?.phase === 'freezetime' &&
      p.clock.endsInSeconds !== null &&
      p.clock.endsInSeconds <= 5
    )
  )
    return 'halftime';
  if ((half && p.clock?.phase === 'freezetime') || p.map.phase === 'live') return 'gameplay';
  return 'unknown';
}

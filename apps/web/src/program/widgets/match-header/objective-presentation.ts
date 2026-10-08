import type { ProgramPayload } from '@mizar/protocol/program';
import type { MatchHeaderTeamPresentation } from './presentation';

export interface ObjectiveCenterPresentation {
  readonly mode: 'normal' | 'paused' | 'planting' | 'planted' | 'defusing';
  readonly stateOnly: boolean;
  readonly fuse: number | null;
  readonly action: number | null;
  readonly danger: boolean;
  readonly hasKit: boolean;
  readonly playerName: string | null;
  readonly aliveCount: string | null;
  readonly aliveSample: string | null;
}

function progress(
  clock: { remainingSeconds: number | null; durationSeconds: number | null } | null | undefined,
  completion: boolean,
): number | null {
  if (
    clock?.remainingSeconds == null ||
    clock.durationSeconds == null ||
    !Number.isFinite(clock.remainingSeconds) ||
    !Number.isFinite(clock.durationSeconds) ||
    clock.durationSeconds <= 0
  )
    return null;
  const remaining = Math.max(0, Math.min(1, clock.remainingSeconds / clock.durationSeconds));
  return completion ? 1 - remaining : remaining;
}

export function buildObjectiveCenterPresentation(
  payload: ProgramPayload,
  teamA: MatchHeaderTeamPresentation,
  teamB: MatchHeaderTeamPresentation,
): ObjectiveCenterPresentation {
  const phase = payload.clock?.phase;
  const bomb = payload.bomb;
  const paused = phase === 'paused';
  const terminal =
    payload.round?.phase === 'over' ||
    phase === 'over' ||
    bomb?.state === 'defused' ||
    bomb?.state === 'exploded';
  const mode = paused
    ? 'paused'
    : terminal
      ? 'normal'
      : bomb?.state === 'planting'
        ? 'planting'
        : bomb?.state === 'planted'
          ? 'planted'
          : bomb?.state === 'defusing'
            ? 'defusing'
            : bomb?.state == null || bomb.state === 'unknown'
              ? phase === 'bomb'
                ? 'planted'
                : phase === 'defuse'
                  ? 'defusing'
                  : 'normal'
              : 'normal';
  const ct = payload.players.filter((p) => p.side === 'CT');
  const t = payload.players.filter((p) => p.side === 'T');
  const complete =
    ct.length === 5 &&
    t.length === 5 &&
    new Set(payload.players.map((p) => p.sourcePlayerId)).size === 10 &&
    [...ct, ...t].every(
      (p) => p.lineupEvidence === 'current' && (p.lifeState === 'alive' || p.lifeState === 'dead'),
    );
  const alive = {
    CT: ct.filter((p) => p.lifeState === 'alive').length,
    T: t.filter((p) => p.lifeState === 'alive').length,
  };
  const showAlive =
    payload.status.telemetry === 'fresh' &&
    complete &&
    !paused &&
    !terminal &&
    phase !== 'timeout_ct' &&
    phase !== 'timeout_t' &&
    phase !== 'freezetime' &&
    payload.round?.phase !== 'freezetime' &&
    (mode !== 'normal' || phase === 'live' || payload.round?.phase === 'live');
  const action = bomb?.action;
  const players = payload.players.filter(
    (p) => p.sourcePlayerId === action?.sourcePlayerId && p.lineupEvidence === 'current',
  );
  return {
    mode,
    stateOnly: bomb == null || bomb.state == null || bomb.state === 'unknown',
    fuse: mode === 'planted' || mode === 'defusing' ? progress(bomb?.explosion, false) : null,
    action:
      (mode === 'planting' && action?.kind === 'plant') ||
      (mode === 'defusing' && action?.kind === 'defuse')
        ? progress(action, true)
        : null,
    danger: bomb?.explosion?.remainingSeconds != null && bomb.explosion.remainingSeconds <= 10,
    hasKit: mode === 'defusing' && action?.kind === 'defuse' && action.hasDefuseKit === true,
    playerName:
      mode === 'defusing' && action?.kind === 'defuse' && players.length === 1
        ? players[0]!.displayName
        : null,
    aliveSample:
      showAlive && teamA.side !== null && teamB.side !== null
        ? `${alive[teamA.side]}v${alive[teamB.side]}`
        : null,
    aliveCount:
      showAlive && (alive.CT !== 5 || alive.T !== 5) && teamA.side !== null && teamB.side !== null
        ? `${alive[teamA.side]}v${alive[teamB.side]}`
        : null,
  };
}

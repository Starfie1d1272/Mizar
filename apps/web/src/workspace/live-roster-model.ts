import type { MatchDocumentV1 } from '@mizar/protocol/context';
import type { OperatorPayload } from '@mizar/protocol/operator';
import type { ProgramPayload, ProgramSnapshot } from '@mizar/protocol/program';

export interface LiveRosterConnection {
  readonly paired: boolean;
  readonly activeMatchId: string | null;
  readonly activeSourceMatchId: string | null;
  readonly sourceReady?: boolean;
  readonly liveDelivery?: { readonly status: 'idle' | 'accepted' | 'dropped' | 'failing' };
}

export interface LiveRosterDifference {
  readonly key: string;
  readonly displayName: string;
  readonly avatarUrl: string | null;
}

export interface LiveRosterAlert {
  readonly key: string;
  readonly observed: readonly LiveRosterDifference[];
  readonly absent: readonly LiveRosterDifference[];
  readonly syncStatus: string;
}

/** A current, complete observation and complete source roster prove a difference.
 * Names are presentation only; never infer which account belongs to an absent starter.
 */
export function workspaceLiveRosterAlert(
  operator: OperatorPayload | null,
  program: ProgramPayload | null,
  document: MatchDocumentV1 | null,
  connection: LiveRosterConnection | null,
  programCursor: ProgramSnapshot['cursor'] | null,
): LiveRosterAlert | null {
  const matchId = operator?.matchContext.summary?.matchId;
  if (
    !operator ||
    !program ||
    !programCursor ||
    !document ||
    !connection?.paired ||
    !matchId ||
    document.matchId !== matchId ||
    connection.activeMatchId !== matchId ||
    program.match?.matchId !== matchId ||
    programCursor.programReceiveSequence !== operator.runtime.lastAccepted?.receiveSequence ||
    programCursor.mapEpoch !== operator.activeLineup.mapEpoch ||
    programCursor.programSourceGeneration !== operator.activeLineup.sourceGeneration ||
    operator.matchContext.rosterAuthority !== 'rivalhub' ||
    operator.matchContext.freshness !== 'fresh' ||
    operator.runtime.telemetryFreshness !== 'fresh' ||
    program.status.telemetry !== 'fresh' ||
    operator.identity.state === 'mismatch' ||
    operator.activeLineup.state !== 'complete' ||
    operator.activeLineup.retainedCount !== 0
  )
    return null;
  const codes = new Set(operator.identity.issues.map((issue) => issue.code));
  if (!codes.has('unexpected_human_steam64') && !codes.has('lineup_differs_from_expected'))
    return null;
  if (
    operator.identity.issues.some(
      (issue) =>
        [
          'roster_incomplete',
          'duplicate_canonical_player_id',
          'duplicate_canonical_steam64',
          'map_mismatch',
          'map_not_confirmed',
          'side_mapping_conflict',
          'ambiguous_side_mapping',
          'duplicate_observed_identity',
          'partial_roster_evidence',
          'allplayers_unavailable',
          'allplayers_degraded',
        ].includes(issue.code) ||
        (issue.code === 'missing_canonical_steam64' && issue.affectsExpectedLineup !== false),
    )
  )
    return null;
  const starters = Object.values(document.entrants).flatMap((team) =>
    team.players.filter((player) => player.isStarter),
  );
  if (
    Object.values(document.entrants).some(
      (team) => team.players.filter((p) => p.isStarter).length !== 5,
    ) ||
    starters.some((p) => !p.steam64 || !/^\d{17}$/.test(p.steam64)) ||
    new Set(starters.map((p) => p.steam64)).size !== 10
  )
    return null;
  const current = program.players.filter((p) => p.lineupEvidence === 'current');
  if (
    current.length !== 10 ||
    new Set(current.map((p) => p.sourcePlayerId)).size !== 10 ||
    current.some((p) => !/^\d{17}$/.test(p.sourcePlayerId)) ||
    current.filter((p) => p.side === 'CT').length !== 5 ||
    current.filter((p) => p.side === 'T').length !== 5
  )
    return null;
  const expectedIds = new Set(starters.map((p) => p.steam64));
  const observedIds = new Set(current.map((p) => p.sourcePlayerId));
  const observed = current
    .filter((p) => !expectedIds.has(p.sourcePlayerId))
    .map((p) => ({
      key: p.sourcePlayerId,
      displayName: p.displayName?.trim() || '未读取到游戏昵称',
      avatarUrl: p.avatarUrl,
    }));
  const absent = starters
    .filter((p) => !observedIds.has(p.steam64!))
    .map((p) => ({
      key: p.playerId,
      displayName: p.displayName?.trim() || '网站未提供昵称',
      avatarUrl: p.avatarUrl,
    }));
  if (observed.length === 0 || absent.length === 0) return null;
  const isSource = connection.activeSourceMatchId === matchId;
  const syncStatus =
    connection.sourceReady === false
      ? '网站实时同步尚未就绪：当前人员差异仍需核对。'
      : isSource && connection.liveDelivery?.status === 'accepted'
        ? '网站实时同步仍在进行，人员差异待核对。'
        : isSource && connection.liveDelivery?.status === 'failing'
          ? '网站实时同步接收失败，请打开比赛同步检查。'
          : isSource
            ? '本机已认领数据源，网站实时接收状态待确认。'
            : '本机尚未成为本场数据源，请打开比赛同步检查。';
  return {
    key: JSON.stringify([
      matchId,
      observed.map((p) => p.key).sort(),
      absent.map((p) => p.key).sort(),
    ]),
    observed,
    absent,
    syncStatus,
  };
}

import type { ProgramPayload } from '@mizar/protocol/program';

type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as RecordValue) : null;
const text = (value: unknown): string | null =>
  typeof value === 'string' && value.length > 0 && value.length <= 256 ? value : null;
const score = (value: unknown): number | null =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;

type Team = { id: string; name: string; logo: string | null; wins: number | null };
type Veto = {
  mapName: string;
  type: 'pick' | 'ban' | 'decider';
  entryId: string | null;
  reverseSide: boolean;
  completed: boolean;
  scoreA: number | null;
  scoreB: number | null;
  winner: string | null;
};
export type LhmMatch = {
  id: string;
  format: 'bo1' | 'bo3' | 'bo5';
  a: Team;
  b: Team;
  veto: Veto[];
};

export function matchTeamIds(input: unknown): [string, string] | null {
  const value = record(input);
  const a = text(record(value?.left)?.id);
  const b = text(record(value?.right)?.id);
  return value?.current === true && a && b && a !== b ? [a, b] : null;
}

export function avatarUrl(value: unknown, origin: string): string | null {
  const entry = record(value);
  for (const candidate of [entry?.custom, entry?.steam]) {
    if (typeof candidate !== 'string' || !candidate.trim() || candidate.length > 2048) continue;
    try {
      const url = new URL(candidate, origin);
      if (!url.username && !url.password && (url.origin === origin || url.protocol === 'https:'))
        return url.href;
    } catch {
      /* Ignore malformed media references. */
    }
  }
  return null;
}

export function parseMatch(input: unknown, teamA: unknown, teamB: unknown): LhmMatch | null {
  const m = record(input);
  const left = record(m?.left);
  const right = record(m?.right);
  const a = record(teamA);
  const b = record(teamB);
  const id = text(m?.id);
  const aId = text(left?.id);
  const bId = text(right?.id);
  const aName = text(a?.name);
  const bName = text(b?.name);
  if (
    !m ||
    m.current !== true ||
    !id ||
    !aId ||
    !bId ||
    aId === bId ||
    a?._id !== aId ||
    b?._id !== bId ||
    !aName ||
    !bName ||
    !['bo1', 'bo3', 'bo5'].includes(String(m.matchType)) ||
    !Array.isArray(m.vetos) ||
    m.vetos.length > 32
  )
    return null;
  const veto: Veto[] = [];
  for (const value of m.vetos as unknown[]) {
    const item = record(value);
    const mapName = text(item?.mapName);
    const type = item?.type;
    if (
      !item ||
      !mapName ||
      typeof item.mapEnd !== 'boolean' ||
      (type !== 'pick' && type !== 'ban' && type !== 'decider')
    )
      continue;
    const teamId = item.teamId === aId || item.teamId === bId ? item.teamId : null;
    const scores = record(item.score);
    veto.push({
      mapName,
      type,
      entryId: teamId,
      reverseSide: item.reverseSide === true,
      completed: item.mapEnd === true,
      scoreA: score(scores?.[aId]),
      scoreB: score(scores?.[bId]),
      winner: item.winner === aId || item.winner === bId ? item.winner : null,
    });
  }
  return {
    id,
    format: m.matchType as LhmMatch['format'],
    a: {
      id: aId,
      name: aName,
      logo: a?.logo ? `/api/teams/logo/${encodeURIComponent(aId)}` : null,
      wins: score(left?.wins),
    },
    b: {
      id: bId,
      name: bName,
      logo: b?.logo ? `/api/teams/logo/${encodeURIComponent(bId)}` : null,
      wins: score(right?.wins),
    },
    veto,
  };
}

/** LHM assigns left/right using observer slots and the current map's reverseSide. */
export function applyMatch(
  payload: ProgramPayload,
  match: LhmMatch | null,
  avatars: ReadonlyMap<string, string>,
  ctLeft: boolean | null,
): ProgramPayload {
  const players = payload.players.map((player) => ({
    ...player,
    avatarUrl: avatars.get(player.sourcePlayerId) ?? null,
  }));
  if (!match || payload.status.telemetry !== 'fresh') return { ...payload, players };
  if (ctLeft === null || !payload.map.name) return { ...payload, players };
  const mapName = payload.map.name.slice(payload.map.name.lastIndexOf('/') + 1);
  const matches = match.veto.filter((item) => item.mapName === mapName);
  if (matches.length > 1) return { ...payload, players };
  const reversed = matches[0]?.reverseSide ?? false;
  const left = reversed ? match.b : match.a;
  const right = reversed ? match.a : match.b;
  const asTeam = (team: Team) => ({
    mode: 'canonical' as const,
    entryId: team.id,
    name: team.name,
    logoUrl: team.logo,
    seriesScore: team.wins,
  });
  const maps = match.veto
    .filter((item) => item.type !== 'ban')
    .map((item, index) => ({
      mapId: null,
      mapOrder: index + 1,
      mapName: item.mapName,
      selection:
        item.type === 'decider'
          ? { kind: 'decider' as const }
          : item.entryId
            ? { kind: 'pick' as const, entryId: item.entryId }
            : { kind: 'unknown' as const },
      teamAStartSide: null,
      status: item.completed
        ? ('completed' as const)
        : item.mapName === mapName
          ? ('current' as const)
          : ('pending' as const),
      finalScore:
        item.scoreA !== null && item.scoreB !== null ? { a: item.scoreA, b: item.scoreB } : null,
      winnerEntryId: item.winner,
    }));
  const requiredWins = match.format === 'bo1' ? 1 : match.format === 'bo3' ? 2 : 3;
  return {
    ...payload,
    players,
    teams: { ct: asTeam(ctLeft ? left : right), t: asTeam(ctLeft ? right : left) },
    match: { matchId: match.id, competition: null, format: match.format, stage: null },
    series:
      !payload.map.phase || payload.map.phase === 'unknown'
        ? null
        : {
            format: match.format,
            requiredWins,
            entrants: {
              a: { entryId: match.a.id, name: match.a.name, logoUrl: match.a.logo },
              b: { entryId: match.b.id, name: match.b.name, logoUrl: match.b.logo },
            },
            score: { a: match.a.wins, b: match.b.wins },
            status:
              (match.a.wins !== null && match.a.wins >= requiredWins) ||
              (match.b.wins !== null && match.b.wins >= requiredWins)
                ? 'completed'
                : payload.map.phase === 'warmup'
                  ? 'planned'
                  : 'live',
            bindingState: 'bound',
            currentMapOrder: maps.find((item) => item.status === 'current')?.mapOrder ?? null,
            maps,
            veto: match.veto.map((item, index) => ({
              stepOrder: index + 1,
              actionType: item.type,
              mapName: item.mapName,
              entryId: item.entryId,
              side: null,
            })),
            roundHistory: null,
          },
  };
}

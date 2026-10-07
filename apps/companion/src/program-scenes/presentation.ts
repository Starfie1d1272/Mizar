import {
  deriveScheduleNeighborhood,
  type MatchDocumentV1,
  type ScheduleWindow,
  type ScheduleMatchContext,
} from '@mizar/core/match-context';
import type { ProgramProjection } from '@mizar/core/projection';
import {
  programPresentationSchema,
  type MapSummary,
  type ProgramPresentation,
} from '@mizar/protocol/program-scenes';

export function isRegulationHalftime(p: ProgramProjection): boolean {
  const { ct, t } = p.map.score;
  return (
    ct !== null &&
    t !== null &&
    ct + t === 12 &&
    (p.map.phase === 'intermission' || p.clock?.phase === 'paused')
  );
}

export function summarizeMap(
  p: ProgramProjection,
  mapOrder: number,
  finalScore?: { a: number; b: number },
): MapSummary | null {
  if (!p.match || !p.series) return null;
  const sideFor = (entryId: string) =>
    p.teams.ct.mode === 'canonical' && p.teams.ct.entryId === entryId
      ? 'CT'
      : p.teams.t.mode === 'canonical' && p.teams.t.entryId === entryId
        ? 'T'
        : null;
  const players = (entryId: string) => {
    const side = sideFor(entryId);
    return side === null
      ? []
      : p.players
          .filter((player) => player.side === side && player.lineupEvidence === 'current')
          .slice(0, 5)
          .map((player) => ({
            id: player.sourcePlayerId,
            name: player.displayName,
            avatarUrl: player.avatarUrl,
            kills: player.matchStats?.kills ?? null,
            assists: player.matchStats?.assists ?? null,
            deaths: player.matchStats?.deaths ?? null,
          }));
  };
  const score = (entryId: string) =>
    sideFor(entryId) === 'CT' ? p.map.score.ct : sideFor(entryId) === 'T' ? p.map.score.t : null;
  return {
    matchId: p.match.matchId,
    mapOrder,
    mapName: p.map.name ?? '',
    cursor: { ...p.cursor },
    score: finalScore ?? {
      a: score(p.series.entrants.a.entryId),
      b: score(p.series.entrants.b.entryId),
    },
    players: { a: players(p.series.entrants.a.entryId), b: players(p.series.entrants.b.entryId) },
  };
}

/** Scores freeze at map-ended; terminal KAD may settle within that exact execution. */
export class ProgramPresentationStore {
  private key: string | null = null;
  private value: ProgramPresentation = this.empty();
  private empty(): ProgramPresentation {
    return {
      schemaVersion: 'mizar.program-presentation.v1',
      packageId: 'builtin:mizar-default',
      match: null,
      series: null,
      halftime: null,
      completed: [],
      eventLogoUrl: null,
      scheduledAt: null,
      previous: null,
      next: null,
    };
  }
  update(p: ProgramProjection, _contextRevision: string): void {
    void _contextRevision; // Ordinary metadata refreshes do not discard frozen map summaries.
    const key =
      p.match && p.series
        ? JSON.stringify([
            p.match.matchId,
            p.series.format,
            p.series.entrants.a.entryId,
            p.series.entrants.b.entryId,
            p.series.maps.map((map) => [map.mapOrder, map.mapId, map.mapName]),
          ])
        : null;
    if (key !== this.key) {
      this.key = key;
      this.value = this.empty();
    }
    if (!p.match || !p.series || p.status.context !== 'fresh' || p.status.identity === 'mismatch')
      return;
    this.value.match = structuredClone(p.match);
    this.value.series = programPresentationSchema.shape.series.parse(p.series);
    if (p.status.telemetry !== 'fresh' || p.series.bindingState !== 'bound') return;
    if (isRegulationHalftime(p) && p.series.currentMapOrder !== null) {
      this.value.halftime = summarizeMap(p, p.series.currentMapOrder);
    }
    if (p.map.phase !== 'gameover') return;
    const completed = p.series.maps.find(
      (map) =>
        map.status === 'completed' &&
        map.finalScore &&
        map.mapName === p.map.name &&
        (p.series?.currentMapOrder === null || map.mapOrder === p.series?.currentMapOrder),
    );
    if (!completed?.finalScore) return;
    const snapshot = summarizeMap(p, completed.mapOrder, completed.finalScore);
    if (!snapshot) return;
    const prior = this.value.completed.find((item) => item.mapOrder === completed.mapOrder);
    if (!prior) {
      this.value.completed = [...this.value.completed, snapshot].slice(-5);
      return;
    }
    const before = prior.cursor;
    const after = snapshot.cursor;
    if (
      before.producerInstanceId !== after.producerInstanceId ||
      before.liveSessionId !== after.liveSessionId ||
      before.mapEpoch !== after.mapEpoch ||
      before.programSourceGeneration !== after.programSourceGeneration ||
      before.programReceiveSequence === null ||
      after.programReceiveSequence === null ||
      after.programReceiveSequence <= before.programReceiveSequence ||
      prior.mapName !== snapshot.mapName ||
      prior.score.a !== snapshot.score.a ||
      prior.score.b !== snapshot.score.b
    )
      return;
    for (const side of ['a', 'b'] as const) {
      const oldPlayers = prior.players[side];
      const newPlayers = snapshot.players[side];
      if (
        oldPlayers.length === 0 ||
        oldPlayers.length !== newPlayers.length ||
        oldPlayers.some((player) => !newPlayers.some((item) => item.id === player.id))
      )
        return;
    }
    // Keep the captured identities/media and authoritative score. Only directly
    // observed KAD can settle; missing fields cannot erase an established value.
    const players = (side: 'a' | 'b') =>
      prior.players[side].map((player) => {
        const latest = snapshot.players[side].find((item) => item.id === player.id)!;
        return {
          ...player,
          kills: latest.kills ?? player.kills,
          assists: latest.assists ?? player.assists,
          deaths: latest.deaths ?? player.deaths,
        };
      });
    const nextPlayers = { a: players('a'), b: players('b') };
    if (JSON.stringify(nextPlayers) === JSON.stringify(prior.players)) return;
    this.value.completed = this.value.completed.map((item) =>
      item === prior ? { ...prior, cursor: after, players: nextPlayers } : item,
    );
  }
  get(document?: MatchDocumentV1 | null, schedule?: ScheduleWindow | null): ProgramPresentation {
    const value = programPresentationSchema.parse(this.value);
    if (!document || document.matchId !== value.match?.matchId) return value;
    value.eventLogoUrl = document.competition?.logoUrl ?? null;
    value.scheduledAt = document.scheduledAt;
    const neighborhood = deriveScheduleNeighborhood(
      schedule &&
        document.competition &&
        schedule.competition.competitionId === document.competition.competitionId
        ? schedule
        : null,
      document.matchId,
    );
    const card = (match: ScheduleMatchContext | null): ProgramPresentation['next'] =>
      match
        ? {
            matchId: match.matchId,
            a: match.entrants.a.name,
            b: match.entrants.b.name,
            scheduledAt: match.scheduledAt,
            stage: match.stage,
            format: match.format,
            score:
              match.scoreA !== null && match.scoreB !== null
                ? `${match.scoreA} : ${match.scoreB}`
                : null,
          }
        : null;
    value.previous = card(neighborhood.previous);
    value.next = card(neighborhood.next);
    this.value.eventLogoUrl = value.eventLogoUrl;
    this.value.scheduledAt = value.scheduledAt;
    this.value.previous = value.previous;
    this.value.next = value.next;
    return value;
  }
}

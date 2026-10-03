import type {
  ProgramSceneId,
  ProgramPresentation,
  MapSummary,
} from '@mizar/protocol/program-scenes';
import type { ProgramSnapshot } from '@mizar/protocol/program';
import { getProgramFixture } from './fixtures';
import waitingSchedule from './fixtures/waiting-schedule.json';

/** Renderer-only samples; never posted to Companion or Runtime. */
export function programPreviewSnapshot(
  scene: ProgramSceneId,
  variant: string | null,
): ProgramSnapshot {
  const snapshot = getProgramFixture(
    scene === 'halftime'
      ? 'real-halftime-after'
      : scene === 'waiting' || scene === 'matchup' || scene === 'gameplay'
        ? 'real-live-rich'
        : 'real-gameover',
  )!;
  const result = structuredClone(snapshot);
  const p = result.payload;
  // Reuse the existing BO3 presentation plan, independently of the real telemetry.
  // Never infer a production decider from its position in the series.
  const bpPlan = getProgramFixture('series-bo3-map1')?.payload.series;
  if (p.series && bpPlan) {
    p.series.maps = p.series.maps.map((map) => {
      const planned = bpPlan.maps.find(
        (item) => item.mapOrder === map.mapOrder && item.mapName === map.mapName,
      );
      return map.selection.kind === 'unknown' && planned?.selection.kind === 'decider'
        ? { ...map, selection: planned.selection }
        : map;
    });
  }
  if (p.series && variant === 'no-media') {
    p.series.entrants.a.logoUrl = null;
    p.series.entrants.b.logoUrl = null;
  }
  if (p.series && variant === 'long-names') {
    p.series.entrants.a.name = '长名称战队 · North Star International';
    p.series.entrants.b.name = '长名称战队 · Southern Cross International';
  }
  if (p.series && (variant === 'bo1' || variant === 'bo5')) {
    const base = p.series.maps[0];
    p.series.format = variant;
    p.series.requiredWins = variant === 'bo1' ? 1 : 3;
    if (p.match) p.match.format = variant;
    if (base)
      p.series.maps = Array.from({ length: variant === 'bo1' ? 1 : 5 }, (_, i) => ({
        ...base,
        mapOrder: i + 1,
        status: i === 0 ? base.status : 'pending',
        finalScore: i === 0 ? base.finalScore : null,
        winnerEntryId: i === 0 ? base.winnerEntryId : null,
      }));
  }
  for (const team of Object.values(p.teams)) {
    if (team.mode !== 'canonical' || !p.series) continue;
    const entrant = Object.values(p.series.entrants).find((item) => item.entryId === team.entryId);
    if (entrant) {
      team.name = entrant.name;
      team.logoUrl = entrant.logoUrl;
    }
  }
  for (const player of p.players) {
    if (variant === 'no-media') player.avatarUrl = null;
    if (variant === 'long-names') player.displayName = 'Very Long Player Display Name';
  }
  return result;
}

export function presentationPreview(
  scene: ProgramSceneId,
  variant: string | null,
): ProgramPresentation {
  const snapshot = programPreviewSnapshot(scene, variant);
  const p = snapshot.payload;
  const map = p.series?.maps.find((item) => item.mapName === p.map.name);
  const rows = (entryId: string | undefined) => {
    const side = p.teams.ct.entryId === entryId ? 'CT' : p.teams.t.entryId === entryId ? 'T' : null;
    return p.players
      .filter((player) => side !== null && player.side === side)
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
  const summary: MapSummary = {
    matchId: p.match?.matchId ?? 'preview',
    mapOrder: map?.mapOrder ?? 1,
    mapName: p.map.name ?? '',
    cursor: snapshot.cursor,
    score: map?.finalScore ?? {
      a: p.teams.ct.entryId === p.series?.entrants.a.entryId ? p.map.score.ct : p.map.score.t,
      b: p.teams.ct.entryId === p.series?.entrants.b.entryId ? p.map.score.ct : p.map.score.t,
    },
    players: { a: rows(p.series?.entrants.a.entryId), b: rows(p.series?.entrants.b.entryId) },
  };
  if (scene === 'waiting' && p.series && p.match) {
    const [previous, current, next] = waitingSchedule.matches;
    if (previous && current && next) {
      p.match = {
        ...p.match,
        matchId: current.matchId,
        competition: waitingSchedule.competition,
        stage: current.stageLabel,
      };
      p.series.entrants = { a: current.entrantA, b: current.entrantB };
      if (variant === 'no-media') {
        p.series.entrants.a = { ...p.series.entrants.a, logoUrl: null };
        p.series.entrants.b = { ...p.series.entrants.b, logoUrl: null };
      }
      if (variant === 'long-names') {
        p.series.entrants.a = {
          ...p.series.entrants.a,
          name: 'North Star International · 长名称战队',
        };
        p.series.entrants.b = {
          ...p.series.entrants.b,
          name: 'Southern Cross International · 长名称战队',
        };
      }
      const card = (match: typeof current, result: boolean) => ({
        matchId: match.matchId,
        a: match.entrantA.name,
        b: match.entrantB.name,
        stage: match.stageLabel,
        format: match.format,
        scheduledAt: match.scheduledAt,
        score: result ? `${match.scoreA} : ${match.scoreB}` : null,
      });
      return {
        schemaVersion: 'mizar.program-presentation.v1',
        packageId: 'builtin:mizar-default',
        match: p.match,
        series: p.series,
        halftime: null,
        completed: [],
        eventLogoUrl: waitingSchedule.competition.logoUrl,
        scheduledAt: current.scheduledAt,
        previous: variant === 'no-schedule' ? null : card(previous, true),
        next: variant === 'no-schedule' ? null : card(next, false),
      };
    }
  }
  return {
    schemaVersion: 'mizar.program-presentation.v1',
    packageId: 'builtin:mizar-default',
    match: p.match,
    series: p.series,
    halftime: summary,
    completed: scene === 'halftime' ? [] : [summary],
    eventLogoUrl: null,
    scheduledAt: null,
    previous: null,
    next: null,
  };
}

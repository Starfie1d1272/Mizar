import type {
  ProgramSceneId,
  ProgramPresentation,
  MapSummary,
} from '@mizar/protocol/program-scenes';
import { getProgramFixture } from './fixtures';

/** Renderer-only samples; never posted to Companion or Runtime. */
export function presentationPreview(
  scene: ProgramSceneId,
  variant: string | null,
): ProgramPresentation {
  const snapshot = getProgramFixture(
    scene === 'halftime'
      ? 'real-halftime-after'
      : scene === 'waiting' || scene === 'matchup'
        ? 'real-live-rich'
        : 'real-gameover',
  )!;
  const p = structuredClone(snapshot.payload);
  const map = p.series?.maps.find((item) => item.mapName === p.map.name);
  const rows = (entryId: string | undefined) => {
    const side = p.teams.ct.entryId === entryId ? 'CT' : p.teams.t.entryId === entryId ? 'T' : null;
    return p.players
      .filter((player) => side !== null && player.side === side)
      .slice(0, 5)
      .map((player) => ({
        id: player.sourcePlayerId,
        name: variant === 'long-names' ? 'Very Long Player Display Name' : player.displayName,
        avatarUrl: variant === 'no-media' ? null : player.avatarUrl,
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
    if (base)
      p.series.maps = Array.from({ length: variant === 'bo1' ? 1 : 5 }, (_, i) => ({
        ...base,
        mapOrder: i + 1,
        status: i === 0 ? base.status : 'pending',
        finalScore: i === 0 ? base.finalScore : null,
        winnerEntryId: i === 0 ? base.winnerEntryId : null,
      }));
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

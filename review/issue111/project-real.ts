import { it } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { broadcastStatsSchema, type BroadcastStats } from '@mizar/protocol/broadcast-stats';
import type { MatchContextBinding } from '../src/match-context/lkg-store.js';
import { projectHistoricalProgram } from '../src/projections/historical-program.js';

it('projects supplied real snapshots without adding unknown match facts', () => {
  for (const name of ['real-match-1930', 'rivalhub-match-2000-c400']) {
    const raw = broadcastStatsSchema.parse(JSON.parse(readFileSync(name === 'real-match-1930' ? process.env.ISSUE111_REAL_1930! : process.env.ISSUE111_REAL_2000!, 'utf8')));
    const team = (entry: BroadcastStats['entrants'][number]) => ({ entryId: entry.entryId, name: entry.name, logoUrl: entry.logoUrl, players: entry.starters.map((player) => ({ playerId: player.userId, displayName: player.nickname, avatarUrl: player.avatarUrl, isStarter: true })) });
    const manifestTeam = (entry: BroadcastStats['entrants'][number]) => ({ entryId: entry.entryId, roster: { players: entry.starters.map((player) => ({ playerId: player.userId, isStarter: true })) } });
    const binding = { origin: 'online', context: { matchId: raw.matchId, competition: { competitionId: raw.competitionId }, entrants: { a: team(raw.entrants[0]!), b: team(raw.entrants[1]!) } }, manifest: { match: { matchId: raw.matchId }, entrants: { a: manifestTeam(raw.entrants[0]!), b: manifestTeam(raw.entrants[1]!) } } } as unknown as MatchContextBinding;
    const projection = projectHistoricalProgram(binding, raw, null, 'waiting');
    writeFileSync(`${process.env.ISSUE111_TEMP}/issue111-${name}-projection.json`, JSON.stringify(projection, null, 2));
  }
});

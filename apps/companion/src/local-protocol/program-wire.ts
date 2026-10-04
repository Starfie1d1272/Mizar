import type { ProgramPayload } from '@mizar/protocol/program';
import type { ProgramProjection } from '@mizar/core/projection';

function mapSeries(projection: ProgramProjection['series']): ProgramPayload['series'] {
  if (projection === null) return null;
  return {
    ...projection,
    entrants: {
      a: { ...projection.entrants.a },
      b: { ...projection.entrants.b },
    },
    maps: projection.maps.map((map) => ({
      ...map,
      selection: { ...map.selection },
      finalScore: map.finalScore === null ? null : { ...map.finalScore },
    })),
    veto: projection.veto.map((step) => ({ ...step })),
    roundHistory:
      projection.roundHistory === null
        ? null
        : {
            ...projection.roundHistory,
            rounds: projection.roundHistory.rounds.map((round) => ({ ...round })),
          },
  };
}

export function mapProgramProjection(projection: ProgramProjection): ProgramPayload {
  return {
    status: projection.status,
    bombDamage: {
      ...projection.bombDamage,
      players: projection.bombDamage.players.map((player) =>
        player.status === 'predicted'
          ? {
              ...player,
              assumptions: [...player.assumptions],
              unknownInputs: [...player.unknownInputs],
            }
          : { ...player },
      ),
    },
    match: projection.match,
    teams: projection.teams,
    series: mapSeries(projection.series),
    map: projection.map,
    round: projection.round,
    clock: projection.clock,
    observedPlayerSourceId: projection.observedPlayerSourceId,
    players: projection.players.map((player) => ({
      ...player,
      state: player.state === null ? null : { ...player.state },
      matchStats: player.matchStats === null ? null : { ...player.matchStats },
      weapons: player.weapons.map((weapon) => ({ ...weapon })),
    })),
    bomb: projection.bomb,
    coverage: projection.coverage,
  };
}

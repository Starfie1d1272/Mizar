import type { ProgramPayload } from '@mizar/protocol/program';
import type { RadarPayload } from '@mizar/protocol/radar';

/** LHM's csgogsi parser requires map, clock and complete player positions. */
export function projectLhm(
  program: ProgramPayload,
  radar: RadarPayload,
): { available: false; missing: string[] } | { available: true; raw: object } {
  const missing: string[] = [];
  if (program.status.telemetry !== 'fresh' || radar.telemetryFreshness !== 'fresh')
    missing.push('telemetry');
  if (
    !program.map.name ||
    program.map.name !== radar.mapName ||
    program.map.roundNumber === null ||
    program.map.score.ct === null ||
    program.map.score.t === null ||
    !program.map.phase ||
    program.map.phase === 'unknown'
  )
    missing.push('map');
  if (
    !program.clock ||
    !program.clock.phase ||
    program.clock.phase === 'unknown' ||
    program.clock.endsInSeconds === null
  )
    missing.push('clock');
  if (program.coverage.allPlayers !== 'present' || radar.coverage.allPlayers !== 'present')
    missing.push('players');
  const vectors = new Map(radar.players.map((player) => [player.sourcePlayerId, player]));
  const players: Record<string, object> = {};
  for (const player of program.players) {
    const position = vectors.get(player.sourcePlayerId);
    if (
      !position?.position ||
      !position.forward ||
      position.side !== player.side ||
      player.side === 'unknown' ||
      !player.displayName ||
      !player.state ||
      !player.matchStats ||
      player.state.health === null ||
      player.state.armor === null ||
      player.state.money === null ||
      player.state.equipValue === null ||
      player.state.roundTotalDamage === null ||
      player.state.flashed === null ||
      player.state.smoked === null ||
      player.state.burning === null ||
      player.state.hasHelmet === null ||
      Object.values(player.matchStats).some((value) => value === null) ||
      !player.weaponsAvailable ||
      player.weapons.some((weapon) => !weapon.name)
    ) {
      missing.push(`player:${player.sourcePlayerId}`);
      continue;
    }
    const vector = (v: { x: number; y: number; z: number }) => `${v.x}, ${v.y}, ${v.z}`;
    const state = player.state;
    const stats = player.matchStats;
    players[player.sourcePlayerId] = {
      name: player.displayName,
      team: player.side,
      observer_slot: player.observerSlot ?? undefined,
      position: vector(position.position),
      forward: vector(position.forward),
      state: {
        health: state.health,
        armor: state.armor,
        helmet: state.hasHelmet,
        defusekit: state.hasDefuser,
        flashed: state.flashed,
        smoked: state.smoked,
        burning: state.burning,
        money: state.money,
        round_kills: state.roundKills,
        round_killhs: state.roundKillHeadshots,
        round_totaldmg: state.roundTotalDamage,
        equip_value: state.equipValue,
      },
      match_stats: stats,
      weapons: Object.fromEntries(
        player.weapons.map((w) => [
          w.sourceWeaponId,
          {
            name: w.name,
            paintkit: w.paintKit,
            type: w.type,
            ammo_clip: w.ammoClip,
            ammo_clip_max: w.ammoClipMax,
            ammo_reserve: w.ammoReserve,
            state: w.state,
          },
        ]),
      ),
    };
  }
  const bombState = program.bomb?.state;
  const bombCountdown =
    bombState === 'planting'
      ? program.bomb?.action?.kind === 'plant'
        ? program.bomb.action.remainingSeconds
        : null
      : bombState === 'defusing'
        ? program.bomb?.action?.kind === 'defuse'
          ? program.bomb.action.remainingSeconds
          : null
        : bombState === 'planted'
          ? program.bomb?.explosion?.remainingSeconds
          : undefined;
  if (
    (bombState === 'planting' || bombState === 'defusing' || bombState === 'planted') &&
    bombCountdown == null
  )
    missing.push('bomb:countdown');
  if (missing.length) return { available: false, missing };
  const observed = program.observedPlayerSourceId && players[program.observedPlayerSourceId];
  const bombPosition = radar.bomb?.position;
  const bomb =
    program.bomb &&
    radar.bomb &&
    bombPosition &&
    program.bomb.state === radar.bomb.state &&
    program.bomb.state &&
    program.bomb.state !== 'unknown'
      ? {
          state: program.bomb.state,
          position: `${bombPosition.x}, ${bombPosition.y}, ${bombPosition.z}`,
          ...(program.bomb.sourcePlayerId ? { player: program.bomb.sourcePlayerId } : {}),
          ...(bombCountdown != null ? { countdown: String(bombCountdown) } : {}),
        }
      : undefined;
  const team = (side: 'ct' | 't') => ({
    name: program.teams[side].name,
    score: program.map.score[side],
    consecutive_round_losses: program.map.consecutiveRoundLosses[side],
    timeouts_remaining: program.map.timeoutsRemaining[side],
    matches_won_this_series: program.teams[side].seriesScore,
  });
  return {
    available: true,
    raw: {
      map: {
        name: program.map.name,
        mode: program.map.mode,
        phase: program.map.phase,
        round: program.map.roundNumber,
        team_ct: team('ct'),
        team_t: team('t'),
      },
      phase_countdowns: {
        phase: program.clock!.phase,
        phase_ends_in: String(program.clock!.endsInSeconds),
      },
      ...(program.round
        ? {
            round: {
              phase: program.round.phase,
              ...(program.round.winnerSide !== 'unknown'
                ? { win_team: program.round.winnerSide }
                : {}),
            },
          }
        : {}),
      allplayers: players,
      ...(observed ? { player: { ...observed, steamid: program.observedPlayerSourceId } } : {}),
      ...(bomb ? { bomb } : {}),
    },
  };
}

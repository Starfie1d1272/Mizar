import type { ProgramCue } from '@mizar/core/game-events';
import type { ProgramCueWire } from '@mizar/protocol/program-cue';

/** Map the Core semantic cue into the protocol-owned DTO without exposing parser types. */
export function mapProgramCue(cue: ProgramCue): ProgramCueWire {
  switch (cue.kind) {
    case 'player-impact':
      return {
        id: cue.id,
        mapEpoch: cue.mapEpoch,
        source: { ...cue.source },
        kind: cue.kind,
        effect: cue.effect,
        targetSourcePlayerId: cue.targetSourcePlayerId,
        attackerSourcePlayerId: cue.attackerSourcePlayerId,
        weapon: cue.weapon,
        damageHealth: cue.damageHealth,
        healthRemaining: cue.healthRemaining,
        hitgroup: cue.hitgroup,
        lethal: cue.lethal,
      };
    case 'player-elimination':
      return {
        id: cue.id,
        mapEpoch: cue.mapEpoch,
        source: { ...cue.source },
        kind: cue.kind,
        victimSourcePlayerId: cue.victimSourcePlayerId,
        attackerSourcePlayerId: cue.attackerSourcePlayerId,
        assisterSourcePlayerId: cue.assisterSourcePlayerId,
        weapon: cue.weapon,
        weaponFamily: cue.weaponFamily,
        modifiers: { ...cue.modifiers },
      };
  }
}

import type { ProgramPayload } from '@mizar/protocol/program';

export interface PlayerStatusEffectState {
  readonly flashed: number | null;
  readonly smoked: number | null;
  readonly burning: number | null;
}

const EMPTY_PLAYER_STATUS_EFFECTS: PlayerStatusEffectState = Object.freeze({
  flashed: null,
  smoked: null,
  burning: null,
});

export function playerStatusEffectState(
  player: ProgramPayload['players'][number],
  visible: boolean,
): PlayerStatusEffectState {
  if (!visible || player.state === null) return EMPTY_PLAYER_STATUS_EFFECTS;
  return {
    flashed: player.state.flashed,
    smoked: player.state.smoked,
    burning: player.state.burning,
  };
}

import { createContext, useContext, useMemo, type ReactNode } from 'react';
import type { ProgramCueWire } from '@mizar/protocol/program-cue';

export interface ProgramCueEffect {
  readonly cue: ProgramCueWire;
  readonly expiresAtMonotonicMs: number;
}

export interface ProgramCueEffectSnapshot {
  readonly effects: readonly ProgramCueEffect[];
}

const EMPTY_PROGRAM_CUE_EFFECTS: ProgramCueEffectSnapshot = Object.freeze({ effects: [] });
const ProgramCueEffectContext = createContext<ProgramCueEffectSnapshot>(EMPTY_PROGRAM_CUE_EFFECTS);

export interface ProgramCueEffectProviderProps {
  readonly snapshot: ProgramCueEffectSnapshot;
  readonly children?: ReactNode;
}

export function ProgramCueEffectProvider({ snapshot, children }: ProgramCueEffectProviderProps) {
  return (
    <ProgramCueEffectContext.Provider value={snapshot}>{children}</ProgramCueEffectContext.Provider>
  );
}

export function useProgramCueEffectsForPlayer(sourcePlayerId: string) {
  const snapshot = useContext(ProgramCueEffectContext);
  return useMemo(
    () =>
      snapshot.effects.filter(({ cue }) => {
        if (cue.kind === 'player-impact') return cue.targetSourcePlayerId === sourcePlayerId;
        return cue.kind === 'player-elimination' && cue.victimSourcePlayerId === sourcePlayerId;
      }),
    [snapshot, sourcePlayerId],
  );
}

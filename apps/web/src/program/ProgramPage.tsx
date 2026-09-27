import { getBuiltinResolvedPreset, type HudResolvedPreset } from '@mizar/hud-config';
import type { ProgramSnapshot } from '@mizar/protocol/program';

import type { RadarProps } from './widgets/radar/Radar';
import type { LocalChannelConnectionState } from '../realtime';
import { ProgramCanvas } from './ProgramCanvas';
import { GameplayHud } from './GameplayHud';
import { hasAcceptedProgramSnapshot } from './presentation-boundary';

export { presentationBoundaryKey as programPresentationBoundaryKey } from './presentation-boundary';

export interface ProgramPageProps {
  readonly radarClient?: RadarProps['client'];
  readonly radarSnapshot?: RadarProps['snapshot'];
  readonly snapshot?: ProgramSnapshot | null;
  readonly connectionState?: LocalChannelConnectionState;
  readonly resolvedPreset?: HudResolvedPreset;
}

export function ProgramPage({
  snapshot,
  connectionState,
  resolvedPreset,
  radarClient,
  radarSnapshot,
}: ProgramPageProps = {}) {
  if (snapshot === undefined && connectionState === undefined && resolvedPreset === undefined) {
    return <ProgramCanvas />;
  }
  const candidateSnapshot = snapshot ?? null;
  const presentationSnapshot = hasAcceptedProgramSnapshot(candidateSnapshot, connectionState)
    ? candidateSnapshot
    : null;
  return (
    <ProgramCanvas>
      <GameplayHud
        radarClient={radarClient}
        radarSnapshot={radarSnapshot}
        resolvedPreset={resolvedPreset ?? getBuiltinResolvedPreset()}
        snapshot={presentationSnapshot}
      />
    </ProgramCanvas>
  );
}

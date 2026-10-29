import { getBuiltinResolvedPreset, type HudResolvedPreset } from '@mizar/hud-config';
import type { ProgramSnapshot } from '@mizar/protocol/program';

import type { RadarProps } from '@mizar/hud-view';
import type { LocalChannelConnectionState } from '../realtime';
import { ProgramCanvas } from '@mizar/hud-view';
import { ProgramView } from '@mizar/hud-view';
import { hasAcceptedProgramSnapshot } from '@mizar/hud-view';

export { presentationBoundaryKey as programPresentationBoundaryKey } from '@mizar/hud-view';

export interface ProgramPageProps {
  readonly radarSource?: RadarProps['source'];
  readonly radarSnapshot?: RadarProps['snapshot'];
  readonly snapshot?: ProgramSnapshot | null;
  readonly connectionState?: LocalChannelConnectionState;
  readonly resolvedPreset?: HudResolvedPreset;
  readonly gg?: boolean;
}

export function ProgramPage({
  snapshot,
  connectionState,
  resolvedPreset,
  radarSource,
  radarSnapshot,
  gg = false,
}: ProgramPageProps = {}) {
  if (snapshot === undefined && connectionState === undefined && resolvedPreset === undefined) {
    return <ProgramCanvas />;
  }
  const isPreview =
    typeof window !== 'undefined' &&
    new URLSearchParams(window.location.search).get('preview') === '1';
  const candidateSnapshot = snapshot ?? null;
  const presentationSnapshot = hasAcceptedProgramSnapshot(candidateSnapshot, connectionState)
    ? candidateSnapshot
    : isPreview
      ? candidateSnapshot
      : null;
  return (
    <ProgramCanvas>
      <ProgramView
        kind="hud"
        radarSource={radarSource}
        radarSnapshot={radarSnapshot}
        resolvedPreset={resolvedPreset ?? getBuiltinResolvedPreset()}
        snapshot={presentationSnapshot}
        gg={gg}
      />
    </ProgramCanvas>
  );
}

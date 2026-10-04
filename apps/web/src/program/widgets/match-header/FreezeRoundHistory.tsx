import { useEffect, useState } from 'react';
import type { HudWidgetRendererProps } from '../../hud-renderer-registry';
import { presentationBoundaryKey } from '../../presentation-boundary';
import { buildMatchHeaderPresentation } from './presentation';
import type { MatchHeaderRoundHistoryPresentation } from './presentation';
import { freezeHistoryEligible } from './round-history-presentation';
import { RoundHistoryPanel } from './RoundHistoryPanel';

export const FREEZE_HISTORY_DISPLAY_MS = 5_000;

function HistoryWindow({ history }: { readonly history: MatchHeaderRoundHistoryPresentation }) {
  const [expired, setExpired] = useState(false);
  useEffect(() => {
    const timer = window.setTimeout(() => setExpired(true), FREEZE_HISTORY_DISPLAY_MS);
    return () => window.clearTimeout(timer);
  }, []);
  return expired ? null : <RoundHistoryPanel history={history} mode="freeze" />;
}

export function FreezeRoundHistory({ snapshot, presentationRevision = 0 }: HudWidgetRendererProps) {
  if (!freezeHistoryEligible(snapshot.payload)) return null;
  const history = buildMatchHeaderPresentation(snapshot.payload).roundHistory;
  if (!history) return null;
  return (
    <HistoryWindow
      history={history}
      key={`${presentationBoundaryKey(snapshot, undefined)}:${snapshot.payload.map.roundNumber}:${presentationRevision}`}
    />
  );
}

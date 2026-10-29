import { useEffect, useState } from 'react';
import type { HudWidgetRendererProps } from '../../hud-renderer-registry.js';
import { presentationBoundaryKey } from '../../presentation-boundary.js';
import { buildMatchHeaderPresentation } from './presentation.js';
import type { MatchHeaderRoundHistoryPresentation } from './presentation.js';
import { freezeHistoryEligible } from './round-history-presentation.js';
import { RoundHistoryPanel } from './RoundHistoryPanel.js';

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

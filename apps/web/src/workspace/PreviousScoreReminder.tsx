import { useState } from 'react';
import type { ContextEnvelope } from '@mizar/core/match-context';
import type { MatchDocumentV1 } from '@mizar/protocol/context';
import type { OperatorPayload } from '@mizar/protocol/operator';
import type { ProgramPayload } from '@mizar/protocol/program';
import { ReviewDialog, isReviewWindow } from './ReviewDialog';

const dismissedKey = 'mizar.previous-score-reminder.v1';

export function PreviousScoreReminder({
  operator,
  program,
  document,
}: {
  operator: OperatorPayload | null;
  program: ProgramPayload | null;
  document: ContextEnvelope<MatchDocumentV1> | null;
}) {
  const [dismissed, setDismissed] = useState<string | null>(null);
  const series = program?.series;
  const order = series?.currentMapOrder;
  const current = series?.maps.find((map) => map.mapOrder === order);
  const previous =
    order && order > 1 ? series?.maps.find((map) => map.mapOrder === order - 1) : undefined;
  const website =
    previous &&
    document?.document.maps.find(
      (map) => map.mapId === previous.mapId && map.mapOrder === previous.mapOrder,
    );
  if (
    !previous ||
    !website ||
    !current ||
    !program ||
    !document ||
    document.source !== 'rivalhub' ||
    document.freshness !== 'fresh' ||
    document.document.matchId !== program.match?.matchId ||
    operator?.matchContext.summary?.matchId !== program.match.matchId ||
    program.status.telemetry !== 'fresh' ||
    program.map.phase !== 'warmup' ||
    program.map.name !== current.mapName ||
    series?.bindingState !== 'bound' ||
    previous.finalScore !== null ||
    website.scoreA !== null ||
    website.scoreB !== null
  )
    return null;
  const key = `${document.document.matchId}:${current.mapId ?? current.mapOrder}`;
  let saved: string | null = null;
  try {
    saved = localStorage.getItem(`${dismissedKey}:${key}`);
  } catch {
    /* The current window still remembers dismissal. */
  }
  const review = isReviewWindow();
  const selected =
    review && new URLSearchParams(window.location.search).get('kind') === 'previous-score';
  const open = selected || (!review && dismissed !== key && saved !== '1');
  return (
    <ReviewDialog
      kind="previous-score"
      open={open}
      title="上一图比分尚未记录"
      modal={false}
      onClose={() => {
        setDismissed(key);
        try {
          localStorage.setItem(`${dismissedKey}:${key}`, '1');
        } catch {
          /* The current window still remembers dismissal. */
        }
      }}
    >
      <p>第 {previous.mapOrder} 图的比分尚未记录，请在 RivalHub 填写。当前热身可以继续。</p>
    </ReviewDialog>
  );
}

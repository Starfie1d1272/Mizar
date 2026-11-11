import { useState } from 'react';
import type { OperatorPayload } from '@mizar/protocol/operator';
import type { ProgramPayload, ProgramSnapshot } from '@mizar/protocol/program';
import { Button } from '../ui';
import { ReviewDialog, isReviewWindow } from './ReviewDialog';
import { currentRosterEvidence } from './live-roster-model';
import './preflight-review.css';

type Props = {
  operator: OperatorPayload | null;
  program: ProgramPayload | null;
  cursor: ProgramSnapshot['cursor'] | null;
  onOpen: (path: string) => Promise<void>;
};
/** Optional read-only detail, never a completion gate or an automatic focused window. */
export function PreflightReview({ operator, program, cursor, onOpen }: Props) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState('');
  const { current, complete } = currentRosterEvidence(operator, program, cursor);
  if (!operator?.matchContext.summary) return null;
  const close = () => setOpen(false);
  return (
    <>
      <Button onClick={() => setOpen(true)}>查看本图资料</Button>
      <ReviewDialog
        kind="preflight"
        open={open || isReviewWindow()}
        title="本图资料"
        onClose={close}
      >
        <p>
          {operator.matchContext.summary.entryAName} 对阵 {operator.matchContext.summary.entryBName}
        </p>
        {program?.map.name ? <p>{program.map.name}</p> : null}
        {!complete ? (
          <p>尚未收到新鲜完整名单，暂不判断人员差异。</p>
        ) : (
          <div className="preflight-rosters">
            {(['CT', 'T'] as const).map((side) => (
              <section key={side}>
                <h3>{side}</h3>
                <ul>
                  {current
                    .filter((p) => p.side === side)
                    .map((p) => (
                      <li key={p.sourcePlayerId}>{p.displayName ?? p.sourcePlayerId}</li>
                    ))}
                </ul>
              </section>
            ))}
          </div>
        )}
        <Button
          onClick={() =>
            void onOpen('/matches?tab=roster').catch((reason: unknown) => setError(String(reason)))
          }
        >
          查看比赛资料
        </Button>
        <Button
          onClick={() =>
            void onOpen('/settings?tab=obs').catch((reason: unknown) => setError(String(reason)))
          }
        >
          核对实际画面与声音
        </Button>
        {error ? <p role="alert">{error}</p> : null}
      </ReviewDialog>
    </>
  );
}

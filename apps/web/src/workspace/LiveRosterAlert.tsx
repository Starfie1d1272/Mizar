import { ReviewDialog } from './ReviewDialog';
import { useState } from 'react';
import { Button, StatusBanner } from '../ui';
import type { LiveRosterAlert as Alert, LiveRosterDifference } from './live-roster-model';

function Player({ player }: { player: LiveRosterDifference }) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  return (
    <li>
      <span className="workspace-roster-avatar" aria-hidden="true">
        {player.avatarUrl && failedUrl !== player.avatarUrl ? (
          <img src={player.avatarUrl} alt="" onError={() => setFailedUrl(player.avatarUrl)} />
        ) : (
          player.displayName.slice(0, 1)
        )}
      </span>
      <span>{player.displayName}</span>
    </li>
  );
}

/** Opens a focused, centered review window without changing OBS. */
export function LiveRosterAlert({
  alert,
  onReview,
  error,
  recovered,
  suppressAutomatic = false,
}: {
  alert: Alert | null;
  recovered: boolean;
  suppressAutomatic?: boolean;
  onReview: () => void;
  error: string | null;
}) {
  const [requested, setRequested] = useState(false);
  const [dismissedKey, setDismissedKey] = useState<string | null>(null);
  // Temporary missing HTTP/telemetry data does not erase an acknowledgement.
  // Only a positively recovered current lineup permits the same difference to alert again.
  if (recovered && dismissedKey !== null) setDismissedKey(null);
  if (!alert) return null;
  const open = requested || (!suppressAutomatic && dismissedKey !== alert.key);
  return (
    <>
      <StatusBanner tone="warning">
        <strong>上场选手／账号与网站首发不一致</strong>
        <p>{alert.syncStatus}</p>
        <Button onClick={() => setRequested(true)}>查看人员差异</Button>
        <Button onClick={onReview}>核对网站名单</Button>
      </StatusBanner>
      <ReviewDialog
        kind="roster"
        open={open}
        modal={false}
        className="workspace-live-roster-alert"
        title="本场上场选手／账号与网站首发不一致"
        onClose={() => {
          setDismissedKey(alert.key);
          setRequested(false);
        }}
      >
        <p role="status">{alert.syncStatus}</p>
        <p>可能存在临时换人或借用账号。先确认所选比赛与服务器，再由赛务核对网站首发。</p>
        <section aria-label="游戏中额外出现的账号">
          <h3>游戏中额外出现的账号</h3>
          <ul>
            {alert.observed.map((player) => (
              <Player key={player.key} player={player} />
            ))}
          </ul>
        </section>
        <section aria-label="网站首发中未观测到的账号">
          <h3>网站首发中未观测到的账号</h3>
          <ul>
            {alert.absent.map((player) => (
              <Player key={player.key} player={player} />
            ))}
          </ul>
        </section>
        <p>两组账号不自动对应；昵称不能证明借号或换人关系。未知账号不会套用登记选手的统计。</p>
        <p>
          在比赛资料页打开网站本场工作台；赛务修正后返回刷新比赛资料。OBS 播出继续由原有控制管理。
        </p>
        <Button variant="primary" onClick={onReview}>
          核对网站名单
        </Button>
        {error ? <p role="alert">{error}</p> : null}
      </ReviewDialog>
    </>
  );
}

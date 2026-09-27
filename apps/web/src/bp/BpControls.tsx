import { useState } from 'react';
import type { BpSnapshot } from '@rivalhub-broadcast/protocol/bp';
import { sendBpCommand, useBpSession } from './client';
import './bp.css';
const labels = {
  hidden: '已收起',
  revealing: '正在播放',
  shown: '完整 BP · 保持显示',
  hiding: '正在收起',
} as const;
export function BpControls({
  snapshot,
  showStatus = true,
}: {
  readonly snapshot: BpSnapshot | null;
  readonly showStatus?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function send(kind: 'play' | 'hide') {
    if (!snapshot || busy) return;
    setBusy(true);
    setError(null);
    try {
      await sendBpCommand(kind, snapshot.revision);
    } catch (error) {
      setError(error instanceof Error ? error.message : '操作未确认，请检查连接。');
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="bp-controls">
      {showStatus ? (
        <p role="status">
          {snapshot === null
            ? '制作服务断开'
            : snapshot.projection === null
              ? '当前比赛尚未录入可播放 BP。'
              : labels[snapshot.state]}
        </p>
      ) : null}
      <div className="bp-actions">
        <button
          disabled={busy || !snapshot?.projection || snapshot.state !== 'hidden'}
          onClick={() => void send('play')}
        >
          播放 BP
        </button>
        <button
          disabled={busy || !snapshot || snapshot.state === 'hidden' || snapshot.state === 'hiding'}
          onClick={() => void send('hide')}
        >
          收起 BP
        </button>
      </div>
      {error ? <p role="alert">{error}</p> : null}
    </div>
  );
}
export function BpDashboardControl() {
  const { snapshot } = useBpSession();
  return (
    <section className="dashboard-bp" aria-label="BP 播放">
      <h2>地图禁选</h2>
      <BpControls snapshot={snapshot} />
      <a href="/operator/bp">打开 BP 预览 →</a>
    </section>
  );
}

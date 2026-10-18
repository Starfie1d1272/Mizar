import { useState } from 'react';
import type { ContextEnvelope } from '@mizar/core/match-context';
import type { MatchDocumentV1 } from '@mizar/protocol/context';
import { Button, StatusPill } from '../ui';
import { desktopInvoke } from '../workspace/client';
import { useObsStatus } from '../workspace/obs-client';
import { useLocalRead, productionAction, type Production } from './client';
import './session-context.css';

/** Persistent context for preparation and independent tools; never inferred from the URL. */
export function SessionContext({ returnToWorkspace = false }: { returnToWorkspace?: boolean }) {
  const envelope = useLocalRead<ContextEnvelope<MatchDocumentV1>>('/local/v1/match-document');
  const production = useLocalRead<Production>('/local/v1/production');
  const obs = useObsStatus();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const match = envelope?.document;
  const live = production?.mode === 'live' || production?.mode === 'hidden';
  const returnToSession = async () => {
    setBusy(true);
    setError('');
    try {
      if (live && production) await productionAction('enter', production);
      else if (window.__TAURI_INTERNALS__) await desktopInvoke('open_main', { path: '/' });
      else window.location.href = '/';
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '返回本场失败，请重试。');
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="session-context" aria-label="本场与输出状态">
      <StatusPill tone={live ? 'success' : 'info'}>
        {live ? '现场' : production ? '准备' : '状态待确认'}
      </StatusPill>
      <strong title={match ? `${match.entrants.a.name} · ${match.entrants.b.name}` : undefined}>
        {match ? `${match.entrants.a.name} vs ${match.entrants.b.name}` : '尚未选择比赛'}
      </strong>
      <span>{match?.format.toUpperCase()}</span>
      <div className="session-context__outputs">
        <span>OBS · {obs?.connection === 'connected' ? '已连接' : '未连接'}</span>
        <span>
          直播 · {obs?.connection !== 'connected' ? '待确认' : obs.streaming ? '进行中' : '未开始'}
        </span>
        <span>
          录像 · {obs?.connection !== 'connected' ? '待确认' : obs.recording ? '进行中' : '未开始'}
        </span>
      </div>
      {returnToWorkspace ? (
        <Button disabled={busy} onClick={() => void returnToSession()}>
          {live ? '返回现场' : '返回本场'}
        </Button>
      ) : null}
      {error ? <span role="alert">{error}</span> : null}
    </section>
  );
}

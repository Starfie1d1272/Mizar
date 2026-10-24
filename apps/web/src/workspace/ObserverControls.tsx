import { useState } from 'react';
import { Button, Dialog, Field, StatusPill } from '../ui';
import { useLocalRead } from '../preparation/client';
import { desktopInvoke } from './client';

export function ObserverControls() {
  const view = useLocalRead<{ version: string; active: boolean; health: { state: string } }>(
    '/local/v1/observer',
    1000,
  );
  const [open, setOpen] = useState(false);
  const [endpoint, setEndpoint] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  if (!view || !window.__TAURI_INTERNALS__) return null;
  const send = async (action: 'start' | 'stop') => {
    setBusy(true);
    setError('');
    try {
      await desktopInvoke('observer_command', {
        action,
        ...(action === 'start' ? { endpoint: endpoint.trim(), password } : {}),
      });
      setPassword('');
      setOpen(false);
    } catch (error) {
      setError(error instanceof Error ? error.message : '请检查连接信息后重试。');
    } finally {
      setBusy(false);
    }
  };
  const labels: Record<string, string> = {
    disabled: '待连接',
    stopped: '已停止',
    connecting: '连接中',
    reconnecting: '重连中',
    live: '接收中',
    ended: '来源结束',
    failed: '需要处理',
  };
  return (
    <>
      <div className="workspace-section-heading">
        <strong>观察辅助</strong>
        <StatusPill tone={view.health.state === 'live' ? 'success' : 'info'}>
          {labels[view.health.state] ?? '待确认'}
        </StatusPill>
        <Button
          disabled={busy}
          aria-busy={busy}
          onClick={() => (view.active ? void send('stop') : setOpen(true))}
        >
          {view.active ? '停止观察器' : '连接早源'}
        </Button>
      </div>
      {error && !open ? <p role="alert">{error}</p> : null}
      <Dialog
        open={open}
        title="连接观察辅助早源"
        onClose={() => {
          if (!busy) {
            setOpen(false);
            setPassword('');
          }
        }}
        canClose={() => !busy}
      >
        <p>填写获授权的早源地址。观察器跟随本次 Mizar 与游戏会话运行，事件供私有观察辅助使用。</p>
        <Field
          label="GOTV 地址"
          placeholder="IP:端口"
          value={endpoint}
          onChange={(event) => setEndpoint(event.target.value)}
          disabled={busy}
        />
        <Field
          label="观战密码"
          type="password"
          autoComplete="off"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          disabled={busy}
        />
        {error ? <p role="alert">{error}</p> : null}
        <Button
          variant="primary"
          disabled={busy || !endpoint.trim()}
          aria-busy={busy}
          onClick={() => void send('start')}
        >
          连接
        </Button>
      </Dialog>
    </>
  );
}

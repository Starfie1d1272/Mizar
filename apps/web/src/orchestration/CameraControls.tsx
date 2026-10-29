import { useState } from 'react';
import type { OrchestrationView } from '@mizar/protocol/orchestration';
import { Button, StatusPill } from '../ui';
import { command, useLocalRead } from '../preparation/client';

export function CameraControls({
  setup = false,
  workspace = false,
  simple = false,
}: {
  setup?: boolean;
  workspace?: boolean;
  simple?: boolean;
}) {
  const view = useLocalRead<OrchestrationView>('/local/v1/orchestration', 1000);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  if (!view || (!setup && !workspace && !simple && !view.preset.maps.length))
    return workspace ? (
      <p className="workspace-camera-empty">运镜状态暂不可用，请检查本地服务。</p>
    ) : null;
  const s = view.status;
  const send = async (action: string) => {
    setBusy(true);
    setError('');
    try {
      await command('/operator/orchestration', {
        action,
        ...(action === 'resume'
          ? { expected: { context: s.context, connection: s.connection } }
          : {}),
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : '运镜操作未完成');
    } finally {
      setBusy(false);
    }
  };
  if (simple) {
    const unavailable = !view.ready
      ? '预设暂不可用，请检查设置。'
      : !s.connected
        ? '请先连接运镜工具。'
        : !s.map || !s.pack || !s.isolated
          ? '请先准备当前地图的镜头。'
          : s.control.state === 'blocked'
            ? '运镜工具尚未准备好。'
            : '';
    return (
      <div className="music-controls" aria-label="自动运镜">
        <span>{s.held ? '自动运镜已关闭' : '自动运镜已开启'}</span>
        <Button
          variant={s.held ? 'primary' : 'secondary'}
          disabled={busy || (s.held && (Boolean(unavailable) || Boolean(s.current)))}
          onClick={() => void send(s.held ? 'resume' : 'hold')}
        >
          {s.held ? '开启自动运镜' : '关闭自动运镜'}
        </Button>
        {s.held && unavailable ? <span>{unavailable}</span> : null}
        {s.held && s.current ? <span>请先停止当前镜头。</span> : null}
        {s.preparation === 'preparing' ? <span>正在准备运镜…</span> : null}
        {s.preparation === 'error' ? <span>运镜准备失败，请检查连接后重试。</span> : null}
        {error ? <span role="alert">{error}</span> : null}
      </div>
    );
  }
  return (
    <div
      className={workspace ? 'workspace-camera-controls' : 'music-controls'}
      aria-label="自动运镜"
    >
      {workspace ? (
        <div className="workspace-camera-summary">
          <StatusPill tone={s.held ? 'warning' : 'info'}>
            {s.held ? '人工保持' : '自动运镜'}
          </StatusPill>
          <strong>{s.map ?? '地图待确认'}</strong>
          <span title={s.pack ?? undefined}>{s.pack ?? '未配运镜包'}</span>
        </div>
      ) : null}
      <span
        className="music-controls__track"
        title={error || s.message}
        role={workspace && error ? 'alert' : undefined}
      >
        {workspace && error ? (
          error
        ) : (
          <>
            {workspace ? '本次请求' : `运镜 · ${s.held ? '手动' : '自动'}`}
            {s.current ? ` · ${s.current}` : ''} ·{' '}
            {setup
              ? s.control.state === 'blocked'
                ? '等待工具准备'
                : s.connected
                  ? '工具已连接'
                  : '工具未连接'
              : s.control.state === 'blocked'
                ? '原生交接待确认'
                : s.message}
          </>
        )}
      </span>
      {setup ? (
        <span>
          {s.map ?? '地图待确认'} · {s.pack ?? '未配置镜头包'} ·{' '}
          {s.isolated ? '镜头已准备' : '请准备镜头包'}
        </span>
      ) : null}
      {setup ? (
        <Button
          disabled={busy || (!s.connected && s.control.state === 'blocked')}
          onClick={() => void send(s.connected ? 'disconnect' : 'connect')}
        >
          {s.connected ? '断开 MulNX' : '连接 MulNX'}
        </Button>
      ) : null}
      {!s.held || s.current ? (
        <>
          <Button
            disabled={busy}
            onClick={() => void send('hold')}
            title="停止当前运镜并切换为手动，请在游戏内确认画面"
          >
            接管运镜
          </Button>
          <Button disabled={busy || !s.connected || !s.current} onClick={() => void send('skip')}>
            跳过本次
          </Button>
        </>
      ) : null}
      {s.held ? (
        <Button
          variant="primary"
          disabled={
            busy ||
            !s.connected ||
            !view.ready ||
            !s.pack ||
            !s.isolated ||
            s.control.state === 'blocked'
          }
          title={`准备当前地图 ${s.map ?? '未知'} 的镜头包 ${s.pack ?? '未配置'}`}
          onClick={() => void send('resume')}
        >
          {workspace ? '准备运镜并恢复自动' : '开启自动运镜'}
        </Button>
      ) : null}
      {error && !workspace ? <span role="alert">{error}</span> : null}
    </div>
  );
}

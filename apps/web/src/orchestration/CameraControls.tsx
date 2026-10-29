import { useState } from 'react';
import type { OrchestrationView } from '@mizar/protocol/orchestration';
import { Button, StatusPill } from '../ui';
import { command, useLocalRead } from '../preparation/client';

export function CameraControls({
  setup = false,
  workspace = false,
}: {
  setup?: boolean;
  workspace?: boolean;
}) {
  const view = useLocalRead<OrchestrationView>('/local/v1/orchestration', 1000);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  if (!view || (!setup && !workspace && !view.preset.maps.length))
    return workspace ? (
      <p className="workspace-camera-empty">运镜状态暂不可用，请检查本地服务。</p>
    ) : null;
  const s = view.status;
  const preparation = s.preparation;
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
  return (
    <div
      className={workspace ? 'workspace-camera-controls' : 'music-controls'}
      aria-label="自动运镜"
    >
      {workspace ? (
        <div className="workspace-camera-summary">
          <StatusPill tone={s.held ? 'warning' : 'info'}>
            {s.held ? '人工运镜' : '自动运镜'}
          </StatusPill>
        </div>
      ) : null}
      {!workspace || error || s.current || preparation !== 'ready' ? (
        <span
          className="music-controls__track"
          title={error || s.message}
          role={workspace && error ? 'alert' : undefined}
        >
          {workspace && error ? (
            error
          ) : (
            <>
              {workspace
                ? s.current
                  ? `已提交 · ${s.current}`
                  : preparation === 'preparing'
                    ? '正在准备运镜'
                    : preparation === 'error'
                      ? s.message
                      : preparation === 'waiting'
                        ? '等待运镜准备'
                        : preparation === 'ready'
                          ? '运镜已就绪'
                          : s.message
                : `运镜 · ${s.held ? '人工' : '自动'}${s.current ? ` · ${s.current}` : ''} · ${s.control.state === 'blocked' ? '原生交接待确认' : s.message}`}
            </>
          )}
        </span>
      ) : null}
      {setup ? (
        <span>
          {s.map ?? '地图待确认'} · {s.pack ?? '未配运镜包'} ·{' '}
          {s.isolated ? '隔离文件已验证' : '需准备隔离包'}
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
      {!s.held ? (
        <>
          <Button
            disabled={busy}
            onClick={() => void send('hold')}
            title="请求清空 MulNX 全部运镜槽；实际停止需在游戏内确认；不会关闭其他包的自动列表"
          >
            接管运镜
          </Button>
        </>
      ) : null}
      {s.current ? (
        <Button disabled={busy || !s.connected} onClick={() => void send('skip')}>
          跳过本次
        </Button>
      ) : null}
      {s.held ? (
        <Button
          variant="primary"
          disabled={
            busy ||
            (workspace && Boolean(s.current)) ||
            (workspace && preparation === 'preparing') ||
            !s.connected ||
            !view.ready ||
            !s.pack ||
            !s.isolated ||
            s.control.state === 'blocked'
          }
          title={`应用并核对当前地图 ${s.map ?? '未知'} 的隔离包 ${s.pack ?? '未配置'}`}
          onClick={() => void send('resume')}
        >
          {workspace ? '恢复运镜自动' : '准备隔离包并启用自动'}
        </Button>
      ) : null}
      {error && !workspace ? <span role="alert">{error}</span> : null}
    </div>
  );
}

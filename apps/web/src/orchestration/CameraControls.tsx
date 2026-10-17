import { useState } from 'react';
import type { OrchestrationView } from '@mizar/protocol/orchestration';
import { Button } from '../ui';
import { command, useLocalRead } from '../preparation/client';

export function CameraControls({ setup = false }: { setup?: boolean }) {
  const view = useLocalRead<OrchestrationView>('/local/v1/orchestration', 1000);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  if (!view || (!setup && !view.preset.maps.length)) return null;
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
  return (
    <div className="music-controls" aria-label="自动运镜">
      <span className="music-controls__track">
        运镜 · {s.held ? '人工' : '自动'}
        {s.current ? ` · ${s.current}` : ''} · {s.message}
      </span>
      {setup ? (
        <span>
          {s.map ?? '地图待确认'} · {s.pack ?? '未配运镜包'}
        </span>
      ) : null}
      {setup ? (
        <Button disabled={busy} onClick={() => void send(s.connected ? 'disconnect' : 'connect')}>
          {s.connected ? '断开 MulNX' : '连接 MulNX'}
        </Button>
      ) : null}
      <Button
        onClick={() => void send('hold')}
        title="请求清空 MulNX 全部运镜槽；实际停止需在游戏内确认"
      >
        接管运镜
      </Button>
      <Button disabled={busy || !s.connected || !s.current} onClick={() => void send('skip')}>
        跳过本次
      </Button>
      {s.held && s.connected ? (
        <Button
          disabled={busy || !view.ready || !s.pack}
          title={`确认游戏内当前地图 ${s.map ?? '未知'}，活动包 ${s.pack ?? '未配置'}，并允许清空全部运镜槽`}
          onClick={() => void send('resume')}
        >
          确认活动包并启用自动
        </Button>
      ) : null}
      {error ? <span role="alert">{error}</span> : null}
    </div>
  );
}

import { useState } from 'react';
import type { MulnxToolView } from '@mizar/protocol/orchestration';
import { Button, StatusBanner } from '../ui';
import { command } from '../preparation/client';
import { desktopInvoke } from '../workspace/client';

export function MulnxToolControls({ tool }: { tool: MulnxToolView | undefined }) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  if (!tool) return null;
  async function run(launch: boolean) {
    setBusy(true);
    setMessage('');
    try {
      if (launch) {
        await desktopInvoke('launch_mulnx');
        setMessage('已打开 MulNX，启动游戏后选择下方游戏实例。');
      } else await command('/operator/orchestration', { action: 'check-tool' });
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '操作失败，请重试。');
    } finally {
      setBusy(false);
    }
  }
  return (
    <div>
      <p>
        MulNX · {tool.installed ?? '首次启动时准备'}
        {tool.latest && tool.latest !== tool.installed ? ` · 可更新至 ${tool.latest}` : ''}
      </p>
      <Button disabled={busy || tool.busy} onClick={() => void run(false)}>
        检查更新
      </Button>
      {window.__TAURI_INTERNALS__ ? (
        <Button disabled={busy || tool.busy} onClick={() => void run(true)}>
          更新并打开 MulNX
        </Button>
      ) : null}
      {message ? <StatusBanner tone="info">{message}</StatusBanner> : null}
    </div>
  );
}

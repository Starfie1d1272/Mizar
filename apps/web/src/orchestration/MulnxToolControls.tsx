import { useState } from 'react';
import type { MulnxToolView } from '@mizar/protocol/orchestration';
import { Button, StatusBanner } from '../ui';
import { command } from '../preparation/client';
import { desktopInvoke } from '../workspace/client';

export function MulnxToolControls({
  tool,
}: {
  tool: (MulnxToolView & { launchProtocol?: 1 | null }) | undefined;
}) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  if (!tool) return null;
  async function run(action: 'check' | 'open' | 'update') {
    setBusy(true);
    setMessage('');
    try {
      if (action === 'open') {
        await desktopInvoke('launch_mulnx');
        setMessage('已打开 MulNX，启动游戏后选择下方游戏实例。');
      } else if (action === 'update') {
        await desktopInvoke('mulnx_control', { action: 'update' });
        setMessage('MulNX 更新已完成，请核对版本后继续。');
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
        启动前请先退出完美世界竞技平台、其他竞技平台和游戏，再在 MulNX 完成环境检查。仅用于离线 Demo
        或已授权观战。
      </p>
      <p>
        MulNX · {tool.installed ?? '首次启动时准备'}
        {tool.latest && tool.latest !== tool.installed ? ` · 可更新至 ${tool.latest}` : ''}
      </p>
      {tool.launchProtocol === 1 ? (
        <p>支持自动启动。</p>
      ) : tool.installed ? (
        <StatusBanner tone="warning">
          {tool.launchProtocol === null
            ? '当前 MulNX 不支持自动启动，请先更新。'
            : '自动启动能力尚未确认，请检查版本后更新。'}
        </StatusBanner>
      ) : null}
      <Button disabled={busy || tool.busy} onClick={() => void run('check')}>
        检查更新
      </Button>
      {window.__TAURI_INTERNALS__ ? (
        <Button disabled={busy || tool.busy} onClick={() => void run('update')}>
          更新 MulNX
        </Button>
      ) : null}
      {window.__TAURI_INTERNALS__ ? (
        <Button disabled={busy || tool.busy} onClick={() => void run('open')}>
          打开本机 MulNX
        </Button>
      ) : null}
      {message ? <StatusBanner tone="info">{message}</StatusBanner> : null}
    </div>
  );
}

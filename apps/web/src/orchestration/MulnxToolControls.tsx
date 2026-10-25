import { useRef, useState } from 'react';
import type { MulnxToolView } from '@mizar/protocol/orchestration';
import { Button, Dialog, StatusBanner } from '../ui';
import { command } from '../preparation/client';
import { desktopInvoke } from '../workspace/client';

export function MulnxToolControls({
  tool,
  allowStop = true,
}: {
  allowStop?: boolean;
  tool: (MulnxToolView & { launchProtocol?: 1 | null }) | undefined;
}) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [failed, setFailed] = useState(false);
  const [confirmStop, setConfirmStop] = useState(false);
  const [stopSubmitted, setStopSubmitted] = useState(false);
  const running = useRef(false);
  if (!tool) return null;
  async function run(action: 'check' | 'open' | 'update' | 'stop') {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setMessage('');
    setFailed(false);
    try {
      if (action === 'open') {
        await desktopInvoke('launch_mulnx');
        setStopSubmitted(false);
        setMessage('已打开 MulNX，启动游戏后选择下方游戏实例。');
      } else if (action === 'update') {
        await desktopInvoke('mulnx_control', { action: 'update' });
        setMessage(
          'MulNX 版本准备已完成；是否支持自动启动请核对上方状态，不支持时仍需在官方启动器完成检查后启动。',
        );
      } else if (action === 'stop') {
        const result = await desktopInvoke<{ result?: string; cleanupPending?: boolean } | null>(
          'mulnx_control',
          {
            action: 'stop',
          },
        );
        setStopSubmitted(true);
        setMessage(
          result?.result === 'queued'
            ? '停止控制请求已入队，执行结果待确认。请返回游戏核对。该实例不再重复发送；需要继续控制时请正常重启该游戏。'
            : '停止控制结果待确认，请勿重复发送。请返回游戏核对，需要继续控制时先正常重启该游戏。',
        );
        if (result?.cleanupPending)
          setMessage((value) => `${value} 工作台收尾尚未完成，请检查退出状态。`);
      } else await command('/operator/orchestration', { action: 'check-tool' });
    } catch (error) {
      setFailed(true);
      setMessage(
        error instanceof Error
          ? error.message
          : action === 'stop'
            ? '停止操作未完成；请核对游戏与退出状态，结果不明确时不要重复发送。'
            : '操作失败，请重试。',
      );
    } finally {
      running.current = false;
      if (action === 'stop') setConfirmStop(false);
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
            ? '当前安装的 MulNX 版本需在官方启动器完成环境检查后启动；请使用下方打开按钮，再明确交接游戏实例。'
            : '本机自动启动能力尚未确认；可使用下方官方启动器完成环境检查后启动，再明确交接游戏实例。'}
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
      {window.__TAURI_INTERNALS__ && allowStop ? (
        <details>
          <summary>停止控制</summary>
          <Button
            disabled={busy || tool.busy || stopSubmitted}
            onClick={() => setConfirmStop(true)}
          >
            停止 MulNX 控制
          </Button>
        </details>
      ) : null}
      <Dialog
        open={confirmStop}
        title="停止 MulNX 控制"
        onClose={() => setConfirmStop(false)}
        canClose={() => !busy}
      >
        <p>
          将结束本场制作、恢复游戏 HUD，并解除 MulNX 控制；CS2 保持运行。停止结果需要在游戏内核对。
        </p>
        <Button disabled={busy} onClick={() => setConfirmStop(false)}>
          取消
        </Button>
        <Button variant="primary" disabled={busy} aria-busy={busy} onClick={() => void run('stop')}>
          {busy ? '正在请求停止…' : '结束制作并停止控制'}
        </Button>
      </Dialog>
      {message ? <StatusBanner tone={failed ? 'danger' : 'info'}>{message}</StatusBanner> : null}
    </div>
  );
}

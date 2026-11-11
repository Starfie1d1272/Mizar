import type { DesktopResult } from '@mizar/protocol/desktop-ipc';
import { useState } from 'react';
import { ControlTask } from '../debug/control-task';
import { Cs2LaunchSettings } from '../preparation/Cs2LaunchSettings';
import { Button, Panel, Select, StatusBanner } from '../ui';
import { desktopInvoke } from './client';
import { ToolShell } from '../patterns';
import '../preparation/match-connection.css';

type FrameRateReading = DesktopResult<'control_cs2_frame_rate'>;

/** A production tool, never a production lifecycle transition. */
export function GamePictureTool() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [limit, setLimit] = useState<30 | 60>(60);
  const [reading, setReading] = useState<FrameRateReading | null>(null);
  const desktop = Boolean(window.__TAURI_INTERNALS__);
  async function returnToGame() {
    setError('');
    try {
      const focused = await desktopInvoke('restore_cs2_focus');
      if (!focused) setError('未能切回游戏，请用 Alt+Tab 返回 CS2。');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '请用 Alt+Tab 返回 CS2。');
    }
  }
  async function inspect(action: 'inspect' | 'apply' | 'restore' = 'inspect') {
    if (busy) return;
    setBusy(true);
    setError('');
    setReading(null);
    const task = new ControlTask('cs2_frame_rate', 'user', {
      action,
      ...(action === 'apply' ? { frameRateLimit: limit } : {}),
    });
    try {
      const result = await desktopInvoke(
        'control_cs2_frame_rate',
        { action, ...(action === 'apply' ? { frameRateLimit: limit } : {}) },
        task,
      );
      setReading(result);
      task.finish(result.status === 'confirmed' ? 'confirmed' : 'unconfirmed', {
        status: result.status,
        transaction: result.transaction,
        current: result.current,
      });
    } catch (reason) {
      task.fail(reason);
      setError(reason instanceof Error ? reason.message : '当前帧率尚未确认，请返回游戏核对。');
    } finally {
      setBusy(false);
    }
  }
  return (
    <ToolShell title="游戏画面" responsive>
      <main className="workbench-tool">
        <Panel className="settings-card">
          <h1>游戏画面</h1>
          <p>
            现场调整请返回 CS2，按 Esc 打开设置 → 视频。调整期间制作继续，本机 HUD
            跟随实际游戏画面。
          </p>
          <Button variant="primary" onClick={() => void returnToGame()} disabled={!desktop}>
            返回游戏
          </Button>
          <p>下方画质偏好只在下次启动生效。</p>
          <details className="settings-details">
            <summary>本次帧率上限</summary>
            <p>MulNX 启动时可尝试在这里调整；不支持时请在 CS2 视频设置中调整。</p>
            <p>结束制作时恢复原帧率；你之后在游戏内调整的值会保留。</p>
            <Button disabled={!desktop || busy} aria-busy={busy} onClick={() => void inspect()}>
              {busy
                ? '正在核对…'
                : reading?.status === 'unconfirmed'
                  ? '复查原操作结果'
                  : '读取当前上限'}
            </Button>
            {reading?.status === 'confirmed' && reading.canApply ? (
              <div className="settings-save-row">
                <Select
                  label="本次帧率上限"
                  value={limit}
                  disabled={busy}
                  onChange={(event) => setLimit(Number(event.target.value) as 30 | 60)}
                >
                  <option value={60}>60 帧／秒</option>
                  <option value={30}>30 帧／秒</option>
                </Select>
                <Button disabled={busy} onClick={() => void inspect('apply')}>
                  应用并核对
                </Button>
              </div>
            ) : null}
            {reading?.canRestore ? (
              <Button disabled={busy} onClick={() => void inspect('restore')}>
                恢复本次原值并核对
              </Button>
            ) : null}
            {reading ? (
              <p role="status">
                {reading.message}
                {reading.status === 'confirmed'
                  ? ` 当前值：${reading.current === 0 ? '不限帧' : `${reading.current} 帧／秒`}。`
                  : ''}
              </p>
            ) : null}
          </details>
          {error ? <StatusBanner tone="warning">{error}</StatusBanner> : null}
        </Panel>
        <Cs2LaunchSettings />
      </main>
    </ToolShell>
  );
}

import { useState } from 'react';
import { ControlTask } from '../debug/control-task';
import { Cs2LaunchSettings } from '../preparation/Cs2LaunchSettings';
import { Button, Panel, Select, StatusBanner } from '../ui';
import { desktopInvoke } from './client';

interface FrameRateReading {
  status: 'confirmed' | 'unsupported' | 'unconfirmed';
  current?: number;
  transaction: 'idle' | 'pending' | 'applied' | 'restored' | 'relinquished' | 'ended';
  canApply: boolean;
  canRestore: boolean;
  message: string;
}

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
      const focused = await desktopInvoke<boolean>('restore_cs2_focus');
      if (!focused) setError('未能切回已核验的游戏窗口，请用 Alt+Tab 返回 CS2。');
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
      const result = await desktopInvoke<FrameRateReading>(
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
      setError(reason instanceof Error ? reason.message : '本次读回尚未确认，请返回游戏核对。');
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="settings-fields">
      <Panel className="settings-card">
        <h1>游戏画面</h1>
        <p>
          现场调整请返回 CS2，按 Esc 打开设置 → 视频。调整期间制作继续，本机 HUD 跟随实际游戏画面。
        </p>
        <Button variant="primary" onClick={() => void returnToGame()} disabled={!desktop}>
          返回游戏
        </Button>
        <p>
          当前版本尚未验证完整画质预设的直接热改，请使用游戏原生设置；下方偏好只影响下一次启动。
        </p>
        <details className="settings-details">
          <summary>本次帧率上限</summary>
          <p>
            先读取当前值。仅在受管 MulNX
            与已有本机控制台记录可用时调整30或60帧，不开启采集或改变启动方式。
          </p>
          <p>
            应用前保存原值，仅实际执行并读回一致后显示成功。退出前尝试恢复；检测到游戏内后续修改时保留人工设置。未知结果只能复查，不会重复写入。
          </p>
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
  );
}

import { useState } from 'react';
import { Button, Panel, Select, StatusBanner } from '../ui';
import { desktopInvoke } from '../workspace/client';
import { checkObsBeforeLaunch, useLocalRead, type Production } from './client';

import { useCs2Status, type Cs2ConfigStatus } from './cs2-status';
import { Cs2Recovery } from './Cs2Recovery';

export function Cs2LaunchSettings() {
  const desktop = Boolean(window.__TAURI_INTERNALS__);
  const production = useLocalRead<Production>(desktop ? '/local/v1/production' : null);
  const { status, phase, refresh } = useCs2Status();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const disabled = !status || busy || Boolean(phase) || status.pending;
  const qualityLabels = { 'very-high': '最高', high: '高', medium: '中', preserve: '保留原画质' };
  function save(
    qualityPreset: Cs2ConfigStatus['qualityPreset'],
    frameRateLimit: Cs2ConfigStatus['frameRateLimit'],
  ) {
    return action(() => desktopInvoke('set_cs2_preferences', { qualityPreset, frameRateLimit }));
  }
  async function action(run: () => Promise<unknown>) {
    if (busy || phase) return;
    setBusy(true);
    setError('');
    try {
      await run();
      refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'CS2 操作未完成。');
    } finally {
      setBusy(false);
    }
  }
  return (
    <Panel>
      <h2>CS2 启动设置</h2>
      <p>无边框窗口 · 分辨率适配工作台</p>
      <p>首次先安装 GSI，并在 OBS 启用 WebSocket 服务器、连接并检查场景。</p>
      <p>本次启动使用国际服、开发者控制台与 OBS 游戏捕获兼容选项。</p>
      <details>
        <summary>启动项与工作台尺寸</summary>
        <code>-console -allow_third_party_software -worldwide</code>
        <p>
          仅传给本次 Steam 启动，Steam
          中保存的启动项保持原样。第三方软件选项可能影响信任系数。工作台会按屏幕可用空间调整游戏尺寸。
        </p>
        <p>
          本次帧率同时应用到游戏配置和启动时加载的配置文件，退出后恢复。存在无法处理的冲突时会提示检查配置。
        </p>
      </details>
      <p>退出工作台或退出 Mizar 时关闭本次游戏并恢复原设置；隐藏工作区保留游戏。</p>
      {desktop ? (
        <>
          <Select
            label="游戏画质"
            value={status?.qualityPreset ?? 'very-high'}
            disabled={disabled}
            onChange={(event) => {
              if (status)
                void save(
                  event.target.value as Cs2ConfigStatus['qualityPreset'],
                  status.frameRateLimit,
                );
            }}
          >
            {Object.entries(qualityLabels).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </Select>
          <Select
            label="游戏帧率上限"
            value={status?.frameRateLimit ?? 60}
            disabled={disabled}
            onChange={(event) => {
              if (status)
                void save(
                  status.qualityPreset,
                  Number(event.target.value) as Cs2ConfigStatus['frameRateLimit'],
                );
            }}
          >
            <option value={60}>60 帧／秒（推荐）</option>
            <option value={30}>30 帧／秒（省资源）</option>
            <option value={0}>不限帧（可能导致雷达卡顿）</option>
          </Select>
          <p>默认 60 帧／秒，为雷达与 OBS 留出图形资源。30 帧／秒适合资源紧张或 30 帧播出。</p>
          {status?.frameRateLimit === 0 ? (
            <StatusBanner tone="danger">
              不限帧可能占满图形资源，导致雷达或播出画面卡顿。
            </StatusBanner>
          ) : null}
          {status?.qualityPreset === 'medium' ? (
            <p>中画质采用游戏原生预设，包含 FSR 缩放，画面清晰度会降低。</p>
          ) : null}
          <div className="preparation-actions">
            <Button
              disabled={disabled}
              onClick={() =>
                void action(async () => {
                  if (await checkObsBeforeLaunch()) await desktopInvoke('start_managed_cs2');
                })
              }
            >
              {busy ? '处理中…' : '启动 CS2'}
            </Button>
          </div>
        </>
      ) : (
        <p>请在 Mizar 桌面应用中设置并启动 CS2。</p>
      )}
      <Cs2Recovery production={production} />
      {error ? <StatusBanner tone="danger">{error}</StatusBanner> : null}
    </Panel>
  );
}

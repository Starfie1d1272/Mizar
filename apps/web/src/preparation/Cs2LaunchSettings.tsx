import { useState } from 'react';
import { Button, Panel, Select, StatusBanner } from '../ui';
import { desktopInvoke } from '../workspace/client';
import { useLocalRead, type Production } from './client';

import { useCs2Status, type Cs2ConfigStatus } from './cs2-status';
import { Cs2Recovery } from './Cs2Recovery';

export function Cs2LaunchSettings() {
  const desktop = Boolean(window.__TAURI_INTERNALS__);
  const production = useLocalRead<Production>(desktop ? '/local/v1/production' : null);
  const { status, phase, refresh, error: statusError } = useCs2Status();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const disabled = !status || busy || Boolean(phase) || status.pending;
  const qualityLabels = { 'very-high': '最高', high: '高', medium: '中', preserve: '保留原画质' };
  const [draft, setDraft] = useState<Pick<
    Cs2ConfigStatus,
    'qualityPreset' | 'frameRateLimit' | 'spectatorNumberKeys'
  > | null>(null);
  const [saved, setSaved] = useState(false);
  const preferences = draft ?? status;
  const dirty = Boolean(
    draft &&
    status &&
    (draft.qualityPreset !== status.qualityPreset ||
      draft.frameRateLimit !== status.frameRateLimit ||
      Boolean(draft.spectatorNumberKeys) !== Boolean(status.spectatorNumberKeys)),
  );
  function edit(next: NonNullable<typeof draft>) {
    setDraft(next);
    setSaved(false);
    setError('');
  }
  async function save() {
    if (disabled || !preferences || !dirty) return;
    setBusy(true);
    setError('');
    setSaved(false);
    try {
      await desktopInvoke('set_cs2_preferences', {
        qualityPreset: preferences.qualityPreset,
        frameRateLimit: preferences.frameRateLimit,
        spectatorNumberKeys: Boolean(preferences.spectatorNumberKeys),
      });
      setSaved(true);
      refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '启动设置未保存，请重试。');
    } finally {
      setBusy(false);
    }
  }
  return (
    <Panel className="settings-card">
      <h2>CS2 启动设置</h2>
      <p>保存下次启动使用的画质与帧率，在页面顶部启动游戏并打开工作台。</p>
      {desktop ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <div className="settings-fields">
            <Select
              label="游戏画质"
              value={preferences?.qualityPreset ?? 'very-high'}
              disabled={disabled}
              onChange={(event) => {
                if (preferences)
                  edit({
                    spectatorNumberKeys: Boolean(preferences.spectatorNumberKeys),
                    qualityPreset: event.target.value as Cs2ConfigStatus['qualityPreset'],
                    frameRateLimit: preferences.frameRateLimit,
                  });
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
              value={preferences?.frameRateLimit ?? 60}
              disabled={disabled}
              onChange={(event) => {
                if (preferences)
                  edit({
                    qualityPreset: preferences.qualityPreset,
                    spectatorNumberKeys: Boolean(preferences.spectatorNumberKeys),
                    frameRateLimit: Number(event.target.value) as Cs2ConfigStatus['frameRateLimit'],
                  });
              }}
            >
              <option value={60}>60 帧／秒（推荐）</option>
              <option value={30}>30 帧／秒（省资源）</option>
              <option value={0}>不限帧（可能导致雷达卡顿）</option>
            </Select>
            <Select
              label="数字键观战"
              value={preferences?.spectatorNumberKeys ? 'enabled' : 'preserve'}
              disabled={disabled}
              onChange={(event) => {
                if (preferences)
                  edit({ ...preferences, spectatorNumberKeys: event.target.value === 'enabled' });
              }}
            >
              <option value="preserve">保留原设置</option>
              <option value="enabled">沿用已启用的原始数字键模式</option>
            </Select>
          </div>
          {preferences?.spectatorNumberKeys ? <p>仅用于已启用的观战模式，保留个人键位。</p> : null}
          {status?.spectatorWarning ? (
            <StatusBanner tone="warning">{status.spectatorWarning}</StatusBanner>
          ) : null}
          <p>默认 60 帧／秒，为雷达与 OBS 留出图形资源。30 帧／秒适合资源紧张或 30 帧播出。</p>
          {preferences?.frameRateLimit === 0 ? (
            <StatusBanner tone="danger">
              不限帧可能占满图形资源，导致雷达或播出画面卡顿。
            </StatusBanner>
          ) : null}
          {preferences?.qualityPreset === 'medium' ? (
            <p>中画质采用游戏原生预设，包含 FSR 缩放，画面清晰度会降低。</p>
          ) : null}
          <div className="settings-save-row">
            <Button type="submit" variant="primary" disabled={disabled || !dirty}>
              {busy ? '保存中…' : '保存启动设置'}
            </Button>
            <span role="status">
              {saved
                ? '已保存，下次启动生效。'
                : dirty
                  ? '有未保存的修改'
                  : '修改后保存，下次启动生效。'}
            </span>
          </div>
        </form>
      ) : (
        <p>请在 Mizar 桌面应用中设置并启动 CS2。</p>
      )}
      <details className="settings-details">
        <summary>启动方式与配置恢复</summary>
        <p>无边框窗口 · 分辨率适配工作台</p>
        <p>首次先安装 GSI，并在 OBS 启用 WebSocket 服务器、连接并检查场景。</p>
        <p>本次启动使用国际服、开发者控制台与 OBS 游戏捕获兼容选项。</p>
        <div>
          <code>-console -allow_third_party_software -worldwide</code>
          <p>
            仅传给本次 Steam 启动，Steam
            中保存的启动项保持原样。第三方软件选项可能影响信任系数。工作台会按屏幕可用空间调整游戏尺寸。
          </p>
          <p>
            本次帧率同时应用到游戏配置和启动时加载的配置文件，退出后恢复。存在无法处理的冲突时会提示检查配置。
          </p>
        </div>
        <p>退出工作台或退出 Mizar 时关闭本次游戏并恢复原设置；隐藏工作区保留游戏。</p>
      </details>
      <Cs2Recovery production={production} />
      {error || statusError ? (
        <StatusBanner tone="danger">{error || statusError}</StatusBanner>
      ) : null}
    </Panel>
  );
}

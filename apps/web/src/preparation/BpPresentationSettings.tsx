import { useState } from 'react';
import { bpPreviewSnapshot as preview } from '../bp/preview';
import { BpCompactPresentation, BpPresentation } from '@mizar/hud-view';
import { Button, Panel, StatusBanner } from '../ui';
import { command, useLocalRead } from './client';
import './bp-presentation-settings.css';

type Mode = 'full' | 'compact';
type View = { mode: Mode; revision: string; recovery: { reason: string; message: string } | null };

export function BpPresentationSettingsPanel() {
  const [refresh, setRefresh] = useState(0);
  const view = useLocalRead<View>('/local/v1/bp-presentation', 3000, refresh);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  async function select(mode: Mode) {
    if (!view || busy || (view.mode === mode && !view.recovery)) return;
    setBusy(true);
    setMessage('');
    try {
      await command('/operator/bp-presentation', { mode, expectedRevision: view.revision });
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '保存失败，请重试。');
    } finally {
      setRefresh((value) => value + 1);
      setBusy(false);
    }
  }
  return (
    <Panel className="settings-card bp-presentation-settings">
      <h2>BP 播出样式</h2>
      <p>选择进入 BP 时的画面。预览使用示例数据，设置不影响当前播出。</p>
      <fieldset disabled={!view || busy}>
        <legend>选择 BP 样式</legend>
        {(['full', 'compact'] as const).map((mode) => (
          <label key={mode} className="bp-presentation-choice">
            <input
              type="radio"
              name="bp-presentation"
              value={mode}
              checked={view?.mode === mode}
              onChange={() => void select(mode)}
            />
            <strong>{mode === 'full' ? '全屏 BP' : '游戏画面 + BP 底栏'}</strong>
            <span className="bp-presentation-preview" aria-hidden="true">
              {mode === 'compact' ? (
                <video
                  muted
                  playsInline
                  preload="metadata"
                  src="/fixtures/epl-inferno-video/replay/background.mp4"
                />
              ) : null}
              <span className="bp-presentation-preview-canvas">
                {mode === 'full' ? (
                  <BpPresentation snapshot={preview} />
                ) : (
                  <BpCompactPresentation snapshot={preview} />
                )}
              </span>
            </span>
          </label>
        ))}
      </fieldset>
      {view?.recovery ? (
        <StatusBanner tone="warning">
          BP 样式读取失败，暂用全屏样式。原文件已保留；可重新选择样式，或保存全屏样式。
          <Button disabled={busy} aria-busy={busy} onClick={() => void select(view.mode)}>
            保存全屏样式
          </Button>
        </StatusBanner>
      ) : null}
      {!view ? (
        <StatusBanner tone="warning">展示设置暂不可用，请检查制作服务。</StatusBanner>
      ) : null}
      {message ? <StatusBanner tone="warning">{message}</StatusBanner> : null}
    </Panel>
  );
}

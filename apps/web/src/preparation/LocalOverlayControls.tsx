import { useState } from 'react';
import { Button, StatusBanner } from '../ui';
import { command, useLocalRead } from './client';
import { useHudConfigClient } from '../realtime/hud-config-client';
import { overlayGroups, toggleOverlayGroup, type OverlayPolicy } from './desktop-overlay';
import './spectator-controls.css';

export function LocalOverlayControls({
  onMessage,
}: {
  readonly onMessage?: (message: string) => void;
}) {
  const [refresh, setRefresh] = useState(0);
  const policy = useLocalRead<OverlayPolicy>('/local/v1/desktop-overlay', 2000, refresh);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const hud = useHudConfigClient();
  const presetRadar = hud.current.layout.widgets.radar.visible;
  const groups = policy ? overlayGroups(policy, presetRadar) : null;
  async function toggle(group: 'radar' | 'hud') {
    if (!policy || busy) return;
    setBusy(true);
    setMessage('');
    try {
      // Re-read the revision so another preparation window cannot overwrite this change.
      const response = await fetch('/local/v1/desktop-overlay', {
        cache: 'no-store',
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) throw new Error('无法读取本机 HUD 设置。');
      const current = (await response.json()) as OverlayPolicy;
      await command('/operator/desktop-overlay', toggleOverlayGroup(current, group, presetRadar));
    } catch (error) {
      const text = error instanceof Error ? error.message : '本机 HUD 设置未保存。';
      if (onMessage) onMessage(text);
      else setMessage(text);
    } finally {
      setRefresh((value) => value + 1);
      setBusy(false);
    }
  }
  return (
    <div className="local-overlay-controls" aria-label="本机 HUD 显示">
      <div className="local-overlay-controls__buttons">
        {(
          [
            ['radar', '雷达'],
            ['hud', '其他 HUD'],
          ] as const
        ).map(([group, label]) => (
          <Button
            key={group}
            disabled={!policy || busy}
            aria-pressed={groups?.[group] ?? false}
            title="仅影响本机游戏画面，OBS 播出不变"
            onClick={() => void toggle(group)}
          >
            <span>{label}</span>
            <span
              className="local-overlay-switch"
              data-enabled={groups?.[group] ?? false}
              aria-hidden="true"
            />
          </Button>
        ))}
      </div>
      {message ? <StatusBanner tone="warning">{message}</StatusBanner> : null}
    </div>
  );
}

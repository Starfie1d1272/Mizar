import { useState } from 'react';
import {
  observerSettingsSchema,
  DEFAULT_OBSERVER_SETTINGS,
  DEFAULT_GAME_AUTOMATION_SETTINGS,
  type GameAutomationSettings,
  type ObserverSettings,
} from '@mizar/protocol/assist';
import { Button, Checkbox, Field, Panel, StatusBanner } from '../ui';
import { command, useLocalRead } from './client';
import { desktopInvoke } from '../workspace/client';
import {
  flushObserverPreparation,
  type ConnectionPreparationView,
  type ObserverRuntimeView,
} from './observer-preparation';
import { useCs2Status } from './cs2-status';

type ObserverView = ConnectionPreparationView & {
  settings: ObserverSettings;
  gameAutomation: GameAutomationSettings;
  connection: { earlyEndpoint: string; programEndpoint: string } | null;
};

export function ObserverSettingsPanel() {
  const view = useLocalRead<ObserverView>('/local/v1/observer-assist');
  const production = useLocalRead<{ mode: string }>('/local/v1/production');
  const runtime = useLocalRead<ObserverRuntimeView>('/local/v1/observer');
  const [draft, setDraft] = useState<ObserverSettings | null>(null);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [saved, setSaved] = useState(false);
  const settings = draft ?? view?.settings ?? DEFAULT_OBSERVER_SETTINGS;
  const edit = (value: Partial<ObserverSettings>) => {
    setDraft({ ...settings, ...value });
    setSaved(false);
  };
  const save = async () => {
    if (busy || runtime?.pending) return;
    setBusy(true);
    setError('');
    try {
      const parsed = observerSettingsSchema.safeParse(settings);
      if (!parsed.success)
        throw new Error('请填写有效整数：延迟差 10–600 秒、提前 1–30 秒；提前时间应小于延迟差。');
      const value = parsed.data;
      await command('/operator/observer-assist', { action: 'configure', settings: value });
      setSaved(true);
    } catch (error) {
      setError(error instanceof Error ? error.message : '请核对设置后重试。');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Panel className="settings-card">
      <h2>私有观察辅助</h2>
      <p>使用早源已经发生的事件，提示延迟节目即将出现的击杀，帮助提前选人和准备镜头。</p>
      <Checkbox
        label="启用私有观察辅助"
        checked={settings.enabled}
        onChange={(e) => edit({ enabled: e.target.checked })}
        disabled={busy || runtime?.pending || !view}
        message="开启后，提示显示在工作台左侧雷达下方；关闭后沿用常规工作台布局。"
      />
      <Field
        label="两路预期延迟差（秒）"
        type="number"
        min={10}
        max={600}
        value={settings.expectedDelaySeconds}
        disabled={busy || runtime?.pending || !settings.enabled}
        onChange={(e) => edit({ expectedDelaySeconds: Number(e.target.value) })}
        message="用于辅助匹配同场时间轴，实际提示时刻由后台对齐结果确定。"
      />
      <Field
        label="提示提前时间（秒）"
        type="number"
        min={1}
        max={30}
        value={settings.leadSeconds}
        disabled={busy || runtime?.pending || !settings.enabled}
        onChange={(e) => edit({ leadSeconds: Number(e.target.value) })}
        message="希望在击杀到达节目画面前多久看到提示。"
      />
      <p>
        按当前设置，稳定延迟差下约缓冲 {settings.expectedDelaySeconds - settings.leadSeconds}{' '}
        秒后显示；倒计时归零时自动移除。
      </p>
      <Button
        variant="primary"
        disabled={busy || runtime?.pending || !view}
        aria-busy={busy}
        onClick={() => void save()}
      >
        保存观察辅助设置
      </Button>
      {settings.enabled &&
      production?.mode === 'live' &&
      window.__TAURI_INTERNALS__ &&
      runtime?.retryAvailable ? (
        <Button
          disabled={busy || runtime?.pending}
          onClick={() => {
            if (busy || runtime?.pending) return;
            setBusy(true);
            setError('');
            void desktopInvoke('observer_command', { action: 'start-configured' })
              .catch((reason: unknown) =>
                setError(reason instanceof Error ? reason.message : '早源重试未完成，请重试。'),
              )
              .finally(() => setBusy(false));
          }}
        >
          重新连接早源
        </Button>
      ) : null}
      {runtime?.pending ? <p role="status">正在准备观察辅助…</p> : null}
      {error || runtime?.error ? (
        <StatusBanner tone="warning">
          {error || '观察辅助准备失败，请核对本场连接后重新连接早源。'}
        </StatusBanner>
      ) : saved ? (
        <StatusBanner tone="success">观察辅助设置已保存。</StatusBanner>
      ) : null}
    </Panel>
  );
}

export function GameAutomationSettingsPanel() {
  const view = useLocalRead<ObserverView>('/local/v1/observer-assist');
  const cs2 = useCs2Status();
  const [draft, setDraft] = useState<GameAutomationSettings | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const settings = draft ?? view?.gameAutomation ?? DEFAULT_GAME_AUTOMATION_SETTINGS;
  const useMulnx = cs2.status?.preferMulnx === true;
  const changeConnection = async () => {
    setBusy(true);
    setMessage('');
    try {
      const ready = await flushObserverPreparation(useMulnx, cs2.status?.running);
      if (ready === null) return;
      setMessage('本场连接操作已完成，请在游戏内核对节目源。');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '请重试本场连接。');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Panel className="settings-card">
      <h2>游戏连接与画面准备</h2>
      {cs2.status?.running ? (
        <Button disabled={busy} onClick={() => void changeConnection()}>
          切换本场观战连接
        </Button>
      ) : null}
      <p>MulNX 启动方式提供自动连接和游戏 HUD 控制；打开工作台后填写并确认本场观战连接。</p>
      <Checkbox
        label="自动连接本场节目源"
        checked={settings.autoConnect}
        disabled={busy || !view || !useMulnx}
        onChange={(event) => setDraft({ ...settings, autoConnect: event.target.checked })}
      />
      <Checkbox
        label="自动隐藏游戏内 HUD"
        checked={settings.hideGameHud}
        disabled={busy || !view || !useMulnx}
        onChange={(event) => setDraft({ ...settings, hideGameHud: event.target.checked })}
        message="保留击杀提示，结束时恢复原值。需先在高级设置启用本机控制台记录，并用该设置启动游戏。"
      />
      <Button
        disabled={busy || !view || !useMulnx}
        onClick={() => {
          setBusy(true);
          setMessage('');
          void command('/operator/observer-assist', { action: 'configure-game', settings })
            .then(() => setMessage('游戏自动操作设置已保存。'))
            .catch((error: unknown) =>
              setMessage(error instanceof Error ? error.message : '请重试保存。'),
            )
            .finally(() => setBusy(false));
        }}
      >
        保存游戏自动操作设置
      </Button>
      {cs2.status?.observerHudPending ? (
        <Button
          disabled={busy}
          onClick={() => {
            setBusy(true);
            void desktopInvoke('observer_command', { action: 'restore-hud' })
              .then(() => cs2.refresh())
              .catch((error: unknown) => setMessage(String(error)))
              .finally(() => setBusy(false));
          }}
        >
          恢复游戏 HUD
        </Button>
      ) : null}
      {message ? <p role="status">{message}</p> : null}
    </Panel>
  );
}

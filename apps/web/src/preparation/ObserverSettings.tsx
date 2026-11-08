import { useState } from 'react';
import {
  observerSettingsSchema,
  DEFAULT_OBSERVER_SETTINGS,
  DEFAULT_GAME_AUTOMATION_SETTINGS,
  type GameAutomationSettings,
  type ObserverSettings,
} from '@mizar/protocol/assist';
import { Button, Checkbox, Field, Panel, StatusBanner } from '../ui';
import { command, useLocalRead, openTool } from './client';
import { desktopInvoke } from '../workspace/client';
import {
  resumeObserverReceiver,
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
      if (!parsed.success) throw new Error('请填写有效整数：提前时间为 1–30 秒。');
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
    <>
      <Panel className="settings-card">
        <h2>选手昵称</h2>
        <Checkbox
          label="网站比赛使用网站昵称"
          checked={settings.nicknameSource === 'website'}
          disabled={busy || runtime?.pending || !view}
          onChange={(e) => edit({ nicknameSource: e.target.checked ? 'website' : 'game' })}
          message="默认使用游戏昵称；未绑定网站时仍使用游戏昵称。MulNX 同步遵循此设置。"
        />
        <Button disabled={busy || runtime?.pending || !view} onClick={() => void save()}>
          保存昵称设置
        </Button>
      </Panel>
      <Panel className="settings-card">
        <h2>提前提示</h2>
        <p>在击杀出现在节目画面前提示，帮助提前选人和准备镜头。</p>
        <Checkbox
          label="启用提前提示"
          checked={settings.enabled}
          onChange={(e) => edit({ enabled: e.target.checked })}
          disabled={busy || runtime?.pending || !view}
          message="开启后，提示显示在工作台左侧雷达下方；关闭后沿用常规工作台布局。"
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
        <p>收到可靠比赛数据后自动显示提示。</p>
        <Button
          variant="primary"
          disabled={busy || runtime?.pending || !view}
          aria-busy={busy}
          onClick={() => void save()}
        >
          保存提示设置
        </Button>
        {settings.enabled &&
        production?.mode === 'live' &&
        window.__TAURI_INTERNALS__ &&
        runtime?.retryAvailable &&
        (view?.receiverPaused ||
          runtime.error ||
          runtime.failed ||
          ['failed', 'ended', 'stopped'].includes(runtime.health.state)) ? (
          <Button
            disabled={busy || runtime?.pending}
            onClick={() => {
              if (busy || runtime?.pending || !view) return;
              setBusy(true);
              setError('');
              void resumeObserverReceiver(view)
                .catch((reason: unknown) =>
                  setError(reason instanceof Error ? reason.message : '提示接收未完成，请重试。'),
                )
                .finally(() => setBusy(false));
            }}
          >
            {view?.receiverPaused ? '恢复提前提示接收' : '重试提前提示接收'}
          </Button>
        ) : null}
        {runtime?.pending ? <p role="status">正在准备提前提示…</p> : null}
        {error || runtime?.error ? (
          <StatusBanner tone="warning">
            {error || '提前提示未能准备完成，请核对本图 GoTV 后重试。'}
          </StatusBanner>
        ) : saved ? (
          <StatusBanner tone="success">设置已保存。</StatusBanner>
        ) : null}
      </Panel>
    </>
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
      await openTool('connection');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '请重试本图连接。');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Panel className="settings-card">
      <h2>游戏连接与画面准备</h2>
      {cs2.status?.running ? (
        <Button disabled={busy} onClick={() => void changeConnection()}>
          切换本图观战连接
        </Button>
      ) : null}
      <p>MulNX 启动方式提供自动连接和游戏 HUD 控制；打开工作台后填写并确认本图观战连接。</p>
      <Checkbox
        label="自动连接已提交的 GoTV"
        checked={settings.autoConnect}
        disabled={busy || !view || !useMulnx}
        onChange={(event) => setDraft({ ...settings, autoConnect: event.target.checked })}
      />
      <Checkbox
        label="自动隐藏游戏内 HUD"
        checked={settings.hideGameHud}
        disabled={busy || !view || !useMulnx}
        onChange={(event) => setDraft({ ...settings, hideGameHud: event.target.checked })}
        message="保留击杀提示，结束时恢复原值。开启聊天上屏后，下次启动游戏时生效。"
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

import { useState, useEffect } from 'react';
import {
  observerSettingsSchema,
  DEFAULT_OBSERVER_SETTINGS,
  parseObserverConnection,
  type ObserverSettings,
} from '@mizar/protocol/assist';
import { Button, Checkbox, Field, Panel, StatusBanner } from '../ui';
import { command, useLocalRead } from './client';
import { desktopInvoke } from '../workspace/client';
import { useCs2Status } from './cs2-status';
import { registerObserverPreparation } from './observer-preparation';

type ObserverView = {
  settings: ObserverSettings;
  connection: { earlyEndpoint: string; programEndpoint: string } | null;
};

export function ObserverSettingsPanel() {
  const view = useLocalRead<ObserverView>('/local/v1/observer-assist');
  const cs2 = useCs2Status();
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
    setBusy(true);
    setError('');
    try {
      const parsed = observerSettingsSchema.safeParse(settings);
      if (!parsed.success)
        throw new Error('请填写有效整数：延迟差 10–600 秒、提前 1–30 秒；提前时间应小于延迟差。');
      const value = parsed.data;
      await command('/operator/observer-assist', { action: 'configure', settings: value });
      if (!value.enabled && window.__TAURI_INTERNALS__)
        await desktopInvoke('observer_command', { action: 'stop' });
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
        disabled={busy || !view}
        message="开启后，提示显示在工作台左侧雷达下方；关闭后沿用常规工作台布局。"
      />
      <Field
        label="两路预期延迟差（秒）"
        type="number"
        min={10}
        max={600}
        value={settings.expectedDelaySeconds}
        disabled={busy || !settings.enabled}
        onChange={(e) => edit({ expectedDelaySeconds: Number(e.target.value) })}
        message="用于辅助匹配同场时间轴，实际提示时刻由后台对齐结果确定。"
      />
      <Field
        label="提示提前时间（秒）"
        type="number"
        min={1}
        max={30}
        value={settings.leadSeconds}
        disabled={busy || !settings.enabled}
        onChange={(e) => edit({ leadSeconds: Number(e.target.value) })}
        message="希望在击杀到达节目画面前多久看到提示。"
      />
      <p>
        按当前设置，稳定延迟差下约缓冲 {settings.expectedDelaySeconds - settings.leadSeconds}{' '}
        秒后显示；倒计时归零时自动移除。
      </p>
      <Checkbox
        label="连接节目源时自动隐藏游戏原生 HUD"
        checked={settings.hideGameHud}
        disabled={busy || !settings.enabled}
        onChange={(e) => edit({ hideGameHud: e.target.checked })}
        message="保留游戏击杀提示，结束连接时恢复原值。需在高级设置开启本机控制台记录，并用该设置启动游戏，以核对原值和恢复结果。"
      />
      <p>
        此功能通过 MulNX 启动游戏，进入工作台时使用已准备的观战连接。自动启动需要支持此能力的 MulNX
        版本；环境冲突和更新需求在进入流程中提示。
      </p>
      <Button
        variant="primary"
        disabled={busy || !view}
        aria-busy={busy}
        onClick={() => void save()}
      >
        保存观察辅助设置
      </Button>
      {cs2.status?.observerHudPending ? (
        <StatusBanner tone="warning">
          游戏 HUD 原值恢复记录已保留。可结束游戏后重试，或保持 MulNX 和本机控制台记录可用后恢复。
          <Button
            disabled={busy}
            onClick={() => {
              setBusy(true);
              setError('');
              void desktopInvoke('observer_command', { action: 'stop' })
                .then(() => cs2.refresh())
                .catch((reason: unknown) =>
                  setError(reason instanceof Error ? reason.message : '请重试恢复游戏 HUD。'),
                )
                .finally(() => setBusy(false));
            }}
          >
            停止辅助并恢复游戏 HUD
          </Button>
        </StatusBanner>
      ) : null}
      {error ? (
        <StatusBanner tone="warning">{error}</StatusBanner>
      ) : saved ? (
        <StatusBanner tone="success">观察辅助设置已保存。</StatusBanner>
      ) : null}
    </Panel>
  );
}

export function ObserverConnectionPreparation({ live = false }: { live?: boolean }) {
  const view = useLocalRead<ObserverView>('/local/v1/observer-assist', 1000);
  const [input, setInput] = useState(''),
    [program, setProgram] = useState('');
  const [custom, setCustom] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const commit = async () => {
    if (!view?.settings.enabled) return;
    if (!input.trim()) {
      if (!view.connection) throw new Error('请先填写本场的授权观战连接。');
      return;
    }
    const connection = parseObserverConnection(input, custom ? program : undefined);
    if (custom && !program.trim()) throw new Error('请填写节目源地址。');
    await command('/operator/observer-assist', { action: 'connection', connection });
    setInput('');
    setError('');
  };
  useEffect(() => {
    if (live || !view?.settings.enabled) return;
    return registerObserverPreparation(commit);
  });
  if (!view?.settings.enabled) return null;
  let preview: ReturnType<typeof parseObserverConnection> | undefined;
  try {
    if (input.trim()) preview = parseObserverConnection(input, custom ? program : undefined);
  } catch {
    /* Validate on entry or explicit switching. */
  }
  const change = async () => {
    setBusy(true);
    setError('');
    try {
      await commit();
      await desktopInvoke('observer_command', { action: 'start-configured' });
    } catch (error) {
      setError(error instanceof Error ? error.message : '请检查连接信息后重试。');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Panel className="settings-card">
      <h2>{live ? '切换本场观战连接' : '本场观战连接'}</h2>
      <Field
        label="授权 GOTV 连接（可含 password 密码）"
        placeholder="connect IP:27025;password 密码"
        value={input}
        autoComplete="off"
        disabled={busy}
        onChange={(e) => setInput(e.target.value)}
        message="粘贴一次，进入工作台时自动准备早源与节目源。"
      />
      <Checkbox
        label="单独指定节目源"
        checked={custom}
        disabled={busy}
        onChange={(e) => setCustom(e.target.checked)}
        message="默认采用早源端口＋1的赛事规则，例如 27025 → 27026。"
      />
      {custom ? (
        <Field
          label="节目源 IPv4:端口"
          value={program}
          disabled={busy}
          onChange={(e) => setProgram(e.target.value)}
        />
      ) : null}
      {(preview ?? view.connection) ? (
        <p>
          早源：{(preview ?? view.connection)!.earlyEndpoint} → 游戏节目源：
          {(preview ?? view.connection)!.programEndpoint}
        </p>
      ) : null}
      {live ? (
        <Button disabled={busy} aria-busy={busy} onClick={() => void change()}>
          切换并连接
        </Button>
      ) : null}
      {error ? <StatusBanner tone="warning">{error}</StatusBanner> : null}
    </Panel>
  );
}

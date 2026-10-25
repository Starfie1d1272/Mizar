import type { ObserverSettings, GameAutomationSettings } from '@mizar/protocol/assist';
export type ConnectionPreparationView = {
  settings: ObserverSettings;
  gameAutomation?: GameAutomationSettings;
  connection: { earlyEndpoint: string; programEndpoint: string } | null;
  capabilities?: { skipGameHud?: boolean };
  gameRunning?: boolean;
  gameHudPrepared?: boolean;
};
export type EntryConfirmation = boolean | { skipGameHud: true };
type Confirm = (view: ConnectionPreparationView, useMulnx: boolean) => Promise<EntryConfirmation>;
let confirm: Confirm | undefined;
export function registerObserverPreparation(handler: Confirm) {
  confirm = handler;
  return () => {
    if (confirm === handler) confirm = undefined;
  };
}
/** Confirm the shared match connection before starting either game route. */
export async function flushObserverPreparation(
  useMulnx = false,
  gameRunning = false,
  gameHudPrepared = false,
): Promise<EntryConfirmation | null> {
  const response = await fetch('/local/v1/observer-assist', {
    cache: 'no-store',
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error('请确认游戏与观战设置可读取后重试进入工作台。');
  const view = (await response.json()) as ConnectionPreparationView;
  if (typeof view.settings?.enabled !== 'boolean')
    throw new Error('请刷新准备中心后重试进入工作台。');
  const needsConnection = view.settings.enabled || (useMulnx && view.gameAutomation?.autoConnect);
  if (needsConnection || useMulnx) {
    if (!confirm) throw new Error('请从准备中心打开工作台并确认本场连接。');
    const choice = await confirm({ ...view, gameRunning, gameHudPrepared }, useMulnx);
    if (!choice) return null;
    if (typeof choice === 'object') {
      if (!view.capabilities?.skipGameHud)
        throw new Error('请更新桌面组件后再使用本次禁用自动隐藏。');
      return choice;
    }
  }
  return (
    view.settings.enabled ||
    Boolean(useMulnx && (view.gameAutomation?.autoConnect || view.gameAutomation?.hideGameHud))
  );
}

/** Private runtime status; sourced from the existing observer owner. */
export type ObserverRuntimeView = {
  active: boolean;
  failed: boolean;
  health: {
    state: 'disabled' | 'connecting' | 'live' | 'reconnecting' | 'ended' | 'stopped' | 'failed';
    lastErrorCode?: string;
  };
  terminal?: { reason?: string };
};
export function observerFailureReason(view: ObserverRuntimeView) {
  const code = view.terminal?.reason ?? view.health.lastErrorCode;
  if (code === 'initialization-timeout' || code === 'phase-timeout')
    return '早源连接超时，请核对地址与服务器状态。';
  if (code === 'source-hltv-stop') return '服务器已结束本次观战连接。';
  if (code === 'native-start-failed') return '观察器启动失败，请检查游戏与组件状态。';
  return '早源接收未完成，请核对本场连接后重试。';
}

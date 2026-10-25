import type { ObserverSettings, GameAutomationSettings } from '@mizar/protocol/assist';
export type ConnectionPreparationView = {
  revision?: string;
  settings: ObserverSettings;
  gameAutomation?: GameAutomationSettings;
  connection: { earlyEndpoint: string; programEndpoint: string } | null;
  gameRunning?: boolean;
};
export type EntryConfirmation = boolean;
type Confirm = (view: ConnectionPreparationView, useMulnx: boolean) => Promise<EntryConfirmation>;
let confirm: Confirm | undefined;
export function registerObserverPreparation(handler: Confirm) {
  confirm = handler;
  return () => {
    if (confirm === handler) confirm = undefined;
  };
}
/** Explicit workbench connection confirmation; never part of game/window entry. */
export async function flushObserverPreparation(
  useMulnx = false,
  gameRunning = false,
): Promise<EntryConfirmation | null> {
  const response = await fetch('/local/v1/observer-assist', {
    cache: 'no-store',
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error('本场连接设置未读取，请重试。');
  const view = (await response.json()) as ConnectionPreparationView;
  if (typeof view.settings?.enabled !== 'boolean') throw new Error('请刷新后重试本场连接。');
  if (!confirm) throw new Error('本场连接入口未准备好，请刷新后重试。');
  return (await confirm({ ...view, gameRunning }, useMulnx)) ? true : null;
}

/** Private runtime status; sourced from the existing observer owner. */
export type ObserverRuntimeView = {
  active: boolean;
  failed: boolean;
  pending: boolean;
  error: 'observer_operation_failed' | null;
  retryAvailable: boolean;
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

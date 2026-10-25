import type { ObserverSettings, GameAutomationSettings } from '@mizar/protocol/assist';
export type ConnectionPreparationView = {
  settings: ObserverSettings;
  gameAutomation?: GameAutomationSettings;
  connection: { earlyEndpoint: string; programEndpoint: string } | null;
};
type Confirm = (view: ConnectionPreparationView, useMulnx: boolean) => Promise<boolean>;
let confirm: Confirm | undefined;
export function registerObserverPreparation(handler: Confirm) {
  confirm = handler;
  return () => {
    if (confirm === handler) confirm = undefined;
  };
}
/** Confirm the shared match connection before starting either game route. */
export async function flushObserverPreparation(useMulnx = false): Promise<boolean | null> {
  const response = await fetch('/local/v1/observer-assist', {
    cache: 'no-store',
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error('请确认游戏与观战设置可读取后重试进入工作台。');
  const view = (await response.json()) as ConnectionPreparationView;
  if (typeof view.settings?.enabled !== 'boolean')
    throw new Error('请刷新准备中心后重试进入工作台。');
  const needsConnection = view.settings.enabled || (useMulnx && view.gameAutomation?.autoConnect);
  if (needsConnection) {
    if (!confirm) throw new Error('请从准备中心打开工作台并确认本场连接。');
    if (!(await confirm(view, useMulnx))) return null;
  }
  return (
    view.settings.enabled ||
    Boolean(useMulnx && (view.gameAutomation?.autoConnect || view.gameAutomation?.hideGameHud))
  );
}

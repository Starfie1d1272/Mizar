import type { ObserverSettings, GameAutomationSettings } from '@mizar/protocol/assist';
export type ConnectionPreparationView = {
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
/** Confirm the shared match connection before starting either game route. */
export async function flushObserverPreparation(
  useMulnx = false,
  gameRunning = false,
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
    const choice = await confirm({ ...view, gameRunning }, useMulnx);
    if (!choice) return null;
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
  pending: boolean;
  error: 'observer_operation_failed' | null;
  retryAvailable: boolean;
  health: {
    state: 'disabled' | 'connecting' | 'live' | 'reconnecting' | 'ended' | 'stopped' | 'failed';
    lastErrorCode?: string;
  };
  terminal?: { reason?: string; stage?: string; attemptId?: string; spawnCode?: string };
};
export function observerFailureReason(view: ObserverRuntimeView) {
  const code = view.terminal?.reason ?? view.health.lastErrorCode;
  if (code === 'initialization-timeout' || code === 'phase-timeout')
    return '早源连接超时，请核对地址与服务器状态。';
  if (code === 'source-hltv-stop') return '服务器已结束本次观战连接。';
  if (code === 'native-start-failed') return '观察器启动失败，请检查游戏与组件状态。';
  if (code === 'output-directory-unavailable' || code === 'output-parent-unavailable')
    return '早源输出目录不可用，请检查 Mizar 数据目录是否可写，再重试。';
  if (code === 'configuration-boundary')
    return '观察器未接受连接配置，请重新填写本场观战连接；若仍失败，请导出诊断。';
  if (code?.startsWith('node-runtime-'))
    return '观察器运行环境检查失败，请检查安装包完整性并导出诊断。';
  if (view.terminal?.stage === 'spawn')
    return '观察器进程未能启动，请检查安装包与系统访问权限，并导出诊断。';
  if (view.terminal?.stage === 'cleanup')
    return '观察器收尾未完成，请导出诊断并重启 Mizar 后重试。';
  if (view.terminal?.stage === 'parser-initialization')
    return '早源解析器初始化失败，请导出诊断并检查组件状态。';
  const stage = view.terminal?.stage ?? '未知';
  const id = view.terminal?.attemptId ?? '未提供';
  return `早源接收未完成（阶段：${stage}，诊断编号：${id}），请导出诊断后重试。`;
}

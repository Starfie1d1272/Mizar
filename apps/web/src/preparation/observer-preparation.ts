import type { ObserverSettings, GameAutomationSettings } from '@mizar/protocol/assist';
import { command } from './client';
import { desktopInvoke } from '../workspace/client';
import type { ControlTask } from '../debug/control-task';
export type ConnectionPreparationView = {
  revision: string;
  connectionRequestedAt?: number | null;
  settings: ObserverSettings;
  gameAutomation?: GameAutomationSettings;
  connection: { earlyEndpoint: string; programEndpoint: string } | null;
  mapConnection?: {
    id: string;
    mode: 'connect' | 'seamless' | 'register-current';
    nextMap: boolean;
  } | null;
  waitingForMap?: boolean;
  receiverPaused?: boolean;
  suggestedConnectionMode?: 'connect' | 'register-current';
};
/** Explicit receiver recovery keeps the connection identity and accepted game action. */
export async function resumeObserverReceiver(view: ConnectionPreparationView, task?: ControlTask) {
  if (!view.mapConnection) throw new Error('请先填写本图 GoTV。');
  const expectedRevision = requireConnectionRevision(view.revision);
  await command(
    '/operator/observer-assist',
    {
      action: 'resume-receiver',
      id: view.mapConnection.id,
      expectedRevision,
    },
    task,
  );
  if (window.__TAURI_INTERNALS__)
    return desktopInvoke(
      'observer_command',
      { action: 'start-configured', expectedRevision },
      task,
    );
}
/** Refuse incomplete replies rather than silently dropping the concurrency guard. */
export function requireConnectionRevision(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
  )
    throw new Error('本图连接状态未确认，请重新打开连接入口后重试。');
  return value;
}
/** Private runtime status; sourced from the existing observer owner. */
export type ObserverRuntimeView = {
  gameReady: boolean;
  programCommandQueued: boolean;
  gameCommandState?: 'not-sent' | 'unknown' | 'queued' | 'unavailable' | null;
  active: boolean;
  failed: boolean;
  pending: boolean;
  recovering?: boolean;
  stopReason?:
    | 'paused'
    | 'production-ended'
    | 'connection-changed'
    | 'disabled'
    | 'host-invalid'
    | 'lease-expired'
    | null;
  error: 'observer_operation_failed' | null;
  retryAvailable: boolean;
  health: {
    state: 'disabled' | 'connecting' | 'live' | 'reconnecting' | 'ended' | 'stopped' | 'failed';
    lastErrorCode?: string;
  };
  terminal?: {
    reason?: string;
    stage?: string;
    attemptId?: string;
    spawnCode?: string;
    nativeBootCode?: number;
  };
};
export function observerNeedsRecovery(view: ObserverRuntimeView) {
  if (view.error || view.failed || view.health.state === 'failed') return true;
  if (view.stopReason) return ['lease-expired', 'host-invalid'].includes(view.stopReason);
  return (
    ['stopped', 'ended'].includes(view.health.state) && view.terminal?.reason !== 'source-hltv-stop'
  );
}
export function observerFailureReason(view: ObserverRuntimeView) {
  if (view.terminal?.stage === 'cleanup')
    return '提前提示收尾未完成，请导出诊断并重启 Mizar 后重试。';
  if (!view.failed && view.stopReason === 'lease-expired')
    return '与工作台的连接暂时中断，请重新连接。';
  if (!view.failed && view.stopReason === 'host-invalid')
    return '游戏或工作台已变化，请确认游戏仍在运行后重新连接。';
  const code = view.terminal?.reason ?? view.health.lastErrorCode;
  if (code === 'initialization-timeout' || code === 'phase-timeout')
    return '提前提示连接超时，请核对地址与服务器状态。';
  if (code === 'source-hltv-stop') return '服务器已结束本次观战连接。';
  if (code === 'native-start-failed' && view.terminal?.nativeBootCode === 5)
    return 'Steam 当前未连接在线服务，请确认 Steam 已登录并联网后重试提前提示。';
  if (code === 'native-start-failed') return '提前提示启动失败，请检查游戏与组件状态。';
  if (code === 'output-directory-unavailable' || code === 'output-parent-unavailable')
    return '提前提示输出目录不可用，请检查 Mizar 数据目录是否可写，再重试。';
  if (code === 'configuration-boundary')
    return '提前提示未接受连接配置，请重新填写本场观战连接；若仍失败，请导出诊断。';
  if (code?.startsWith('node-runtime-'))
    return '提前提示运行环境检查失败，请检查安装包完整性并导出诊断。';
  if (view.terminal?.stage === 'spawn')
    return '提前提示进程未能启动，请检查安装包与系统访问权限，并导出诊断。';
  if (view.terminal?.stage === 'parser-initialization')
    return '提前提示未能开始接收数据，请重试；仍失败时请导出诊断。';
  return '提前提示接收未完成，请重试；仍失败时请导出诊断。';
}

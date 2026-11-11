import {
  desktopIpc,
  type DesktopIpcCommand,
  type DesktopArgs,
  type DesktopResult,
} from '@mizar/protocol/desktop-ipc';

interface TauriInternals {
  invoke(command: string, args?: Record<string, unknown>): Promise<unknown>;
}

declare global {
  interface Window {
    __TAURI_INTERNALS__?: TauriInternals;
    __MIZAR_OVERLAY_GENERATION__?: number;
    __MIZAR_OVERLAY_DOCUMENT__?: number;
  }
}

type DiagnosticContext = {
  diagnosticOperationId?: string;
  diagnosticTaskId?: string;
  diagnosticParentOperationId?: string;
  diagnosticTrigger?: string;
};

/** Validated transport shared by product commands and their diagnostic carrier. */
export function desktopTransport<C extends DesktopIpcCommand>(
  command: C,
  args: DesktopArgs<NoInfer<C>>,
  diagnostics?: DiagnosticContext,
): Promise<DesktopResult<C>>;
export async function desktopTransport(
  command: DesktopIpcCommand,
  args: DesktopArgs<DesktopIpcCommand>,
  diagnostics?: DiagnosticContext,
): Promise<unknown> {
  if (!window.__TAURI_INTERNALS__) throw new Error('此操作需要桌面工作区。');
  const contract = desktopIpc[command];
  const input = contract.args.safeParse(args);
  if (!input.success) throw new Error('桌面操作参数无效。');
  const result = await window.__TAURI_INTERNALS__.invoke(command, {
    ...input.data,
    ...diagnostics,
  });
  const output = contract.result.safeParse(result);
  if (!output.success)
    throw new Error('桌面操作结果未确认，请核对当前状态。', { cause: output.error });
  return output.data;
}

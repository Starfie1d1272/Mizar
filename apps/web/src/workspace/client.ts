import { controlEvidence } from '../debug/control-journal';
import { useEffect, useState } from 'react';
import {
  programSceneStateSchema,
  type ProgramSceneId,
  type ProgramSceneState,
} from '@mizar/protocol/program-scenes';

const PROGRAM_SCENE_COMMAND_TIMEOUT_MS = 12_000;

export function useProgramScenes(): ProgramSceneState | null {
  const [state, setState] = useState<ProgramSceneState | null>(null);
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const response = await fetch('/local/v1/program-scenes', {
          cache: 'no-store',
          signal: AbortSignal.timeout(2000),
        });
        if (!response.ok) throw new Error('program scenes unavailable');
        const value = programSceneStateSchema.parse(await response.json());
        if (active) setState(value);
      } catch {
        if (active) setState(null);
      } finally {
        if (active) timer = setTimeout(() => void poll(), 250);
      }
    }
    void poll();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, []);
  return state;
}

export async function selectProgramScene(
  sceneId: ProgramSceneId,
  expectedRevision: string,
): Promise<void> {
  const response = await fetch('/operator/program-scene', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sceneId, expectedRevision }),
    signal: AbortSignal.timeout(PROGRAM_SCENE_COMMAND_TIMEOUT_MS),
  });
  if (!response.ok) {
    const value = (await response.json().catch(() => null)) as { message?: string } | null;
    throw new Error(value?.message ?? '场景切换未完成，请检查当前状态。');
  }
}

interface TauriInternals {
  invoke<T>(command: string, args?: Record<string, unknown>): Promise<T>;
}

declare global {
  interface Window {
    __TAURI_INTERNALS__?: TauriInternals;
  }
}

/** The Host retains this outcome; UI commands must not copy it into local state. */
export class HostWindowControlError extends Error {}

export async function desktopInvoke<T>(
  command: string,
  args?: Record<string, unknown>,
): Promise<T> {
  if (!window.__TAURI_INTERNALS__) return Promise.reject(new Error('此操作需要桌面工作区。'));
  const operationId = crypto.randomUUID();
  const observe =
    !/^(?:gsi_status|cs2_host_status|cs2_config_status|workspace_exit_status|read_obs_configuration_context|save_support_bundle)$/.test(
      command,
    );
  if (observe) controlEvidence(command, 'begin', { operationId, args });
  try {
    const result = await window.__TAURI_INTERNALS__.invoke<T>(command, {
      ...args,
      diagnosticOperationId: operationId,
    });
    if (observe) controlEvidence(command, 'result', { operationId, result });
    return result;
  } catch (error) {
    if (observe)
      controlEvidence(command, 'failure', {
        operationId,
        error:
          error instanceof Error
            ? { name: error.name, message: error.message, stack: error.stack }
            : error,
      });
    if (
      error &&
      typeof error === 'object' &&
      'kind' in error &&
      error.kind === 'window_control' &&
      'message' in error &&
      typeof error.message === 'string'
    ) {
      throw new HostWindowControlError(error.message);
    }
    // Tauri commands returning Result<T, String> reject with a string.
    throw error instanceof Error
      ? error
      : new Error(typeof error === 'string' && error.trim() ? error : '桌面操作失败，请重试。');
  }
}

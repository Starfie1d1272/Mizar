import { useEffect, useRef, useState } from 'react';
import type { ObsOutputCommand, ObsOutputsStatus } from '@mizar/protocol/obs';
import { desktopInvoke } from './client';

export interface ObsStatus {
  readonly connectionFailure?: 'authentication' | 'refused' | 'timeout' | 'unknown';
  readonly connection: 'connected' | 'unavailable' | 'password_required' | 'invalid_password';
  readonly currentScene: string | null;
  readonly expectedScene?: string;
  readonly programEvidence?: null | {
    state: 'measured' | 'changed' | 'failed';
    collection: 'mizar' | 'other';
    sceneId: string | null;
    composition: 'gameplay_overlay' | 'full_screen_graphic' | null;
    sources: readonly { role: 'capture' | 'browser'; present: boolean; enabled: boolean | null }[];
    capture: null | {
      kind: 'game_capture' | 'other' | 'missing';
      mode: 'window' | 'other' | null;
      target: 'cs2.exe' | 'other' | null;
      targetAvailable: boolean | null;
      cs2WindowCount: number;
      videoActive: boolean | null;
      videoShowing: boolean | null;
      width: number | null;
      height: number | null;
    };
  };
  readonly port: number;
  readonly sceneAligned: boolean | null;
  readonly streaming: boolean;
  readonly recording: boolean;
  readonly passwordConfigured: boolean;
  readonly video: null | { canvas: string; output: string; fps: number };
  readonly findings: readonly { code: string; message: string }[];
}

export function useObsStatus(): ObsStatus | null {
  const [value, setValue] = useState<ObsStatus | null>(null);
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const response = await fetch('/local/v1/obs', {
          cache: 'no-store',
          signal: AbortSignal.timeout(5000),
        });
        if (!response.ok) throw new Error('OBS unavailable');
        const status = (await response.json()) as ObsStatus;
        if (active) setValue(status);
      } catch {
        if (active) setValue(null);
      } finally {
        if (active) timer = setTimeout(() => void poll(), 3000);
      }
    }
    void poll();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, []);
  return value;
}

type ObsAction = 'open' | 'check' | 'ensure' | 'repair' | 'configure' | 'audio-setup';
let opening: Promise<unknown> | null = null;
export function obsCommand(
  action: ObsAction,
  body: Record<string, unknown> = {},
): Promise<unknown> {
  if (action !== 'open') return performObsCommand(action, body);
  opening ??= performObsCommand(action, body).finally(() => {
    opening = null;
  });
  return opening;
}

async function performObsCommand(
  action: ObsAction,
  body: Record<string, unknown> = {},
): Promise<unknown> {
  const nativeOpen = action === 'open' && Boolean(window.__TAURI_INTERNALS__);
  const response = await fetch(`/operator/obs/${nativeOpen ? 'launch-target' : action}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(
      ['ensure', 'repair', 'check', 'audio-setup'].includes(action) ? 15_000 : 6000,
    ),
  });
  const value = (await response.json().catch(() => null)) as {
    message?: string;
    executablePath?: string;
  } | null;
  if (!response.ok) throw new Error(value?.message ?? 'OBS 操作未完成，请检查连接与配置。');
  if (nativeOpen) {
    if (!value?.executablePath) throw new Error('未找到 OBS，请在设置中选择 obs64.exe。');
    const alreadyRunning = await desktopInvoke<boolean>('launch_obs', {
      executablePath: value.executablePath,
    });
    return { ...value, alreadyRunning };
  }
  return value;
}

export interface ObsConfigurationResult {
  reason: string;
  message: string;
}

let configurationTarget: Promise<string> | null = null;
function obsConfigurationTarget() {
  configurationTarget ??= (async () => {
    const response = await fetch('/operator/obs/launch-target', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
      signal: AbortSignal.timeout(6000),
    });
    const value = (await response.json()) as { executablePath?: string; message?: string };
    if (!response.ok || !value.executablePath)
      throw new Error(value.message ?? '未找到 OBS，请在设置中选择 obs64.exe。');
    return value.executablePath;
  })().finally(() => {
    configurationTarget = null;
  });
  return configurationTarget;
}

/** Host owns instance identity. A late begin must finish its own session after unmount. */
export function beginObsConfiguration() {
  const sessionId = crypto.randomUUID();
  const ready = obsConfigurationTarget().then((executablePath) =>
    desktopInvoke<boolean>('begin_obs_configuration', { executablePath, sessionId }),
  );
  let finished: Promise<ObsConfigurationResult> | null = null;
  return {
    ready,
    finish: () => {
      finished ??= ready.then(() =>
        desktopInvoke<ObsConfigurationResult>('finish_obs_configuration', { sessionId }),
      );
      return finished;
    },
  };
}

export function useObsOutputs() {
  const [outputs, setOutputs] = useState<ObsOutputsStatus | null>(null);
  const [pending, setPending] = useState<ObsOutputCommand | null>(null);
  const revision = useRef(0);
  const inFlight = useRef(false);
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      const requestRevision = revision.current;
      try {
        const response = await fetch('/local/v1/obs/outputs', {
          cache: 'no-store',
          signal: AbortSignal.timeout(5000),
        });
        if (!response.ok) throw new Error('OBS unavailable');
        const value = (await response.json()) as ObsOutputsStatus;
        if (active && requestRevision === revision.current) setOutputs(value);
      } catch {
        if (active && requestRevision === revision.current) setOutputs(null);
      } finally {
        if (active) timer = setTimeout(() => void poll(), 1000);
      }
    };
    void poll();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, []);
  async function execute(command: ObsOutputCommand) {
    if (inFlight.current) return;
    inFlight.current = true;
    revision.current++;
    setPending(command);
    try {
      const response = await fetch('/operator/obs/output', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(command),
        signal: AbortSignal.timeout(25_000),
      });
      const result = (await response.json()) as { outputs?: ObsOutputsStatus; message?: string };
      if (!response.ok || !result.outputs)
        throw new Error(result.message ?? 'OBS 操作未完成，请核对当前状态。');
      revision.current++;
      setOutputs(result.outputs);
    } catch (error) {
      revision.current++;
      setOutputs(null);
      throw new Error(
        error instanceof Error && error.name !== 'TimeoutError'
          ? error.message
          : '操作结果尚未确认，请等待 OBS 状态更新。',
        { cause: error },
      );
    } finally {
      inFlight.current = false;
      setPending(null);
    }
  }
  return { outputs, pending, execute };
}

import { useEffect, useState } from 'react';

export interface ObsStatus {
  readonly connection: 'connected' | 'unavailable' | 'password_required' | 'invalid_password';
  readonly currentScene: string | null;
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

export async function obsCommand(
  action: 'open' | 'check' | 'repair' | 'configure',
  body: Record<string, unknown> = {},
): Promise<unknown> {
  const response = await fetch(`/operator/obs/${action}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(action === 'repair' ? 15_000 : 6000),
  });
  const value = (await response.json().catch(() => null)) as { message?: string } | null;
  if (!response.ok) throw new Error(value?.message ?? 'OBS 操作未完成，请检查连接与配置。');
  return value;
}

import type { ObsOutputsStatus } from '@mizar/protocol/obs';

export function obsOutputsIdle(status: ObsOutputsStatus | null): boolean {
  return (
    status?.stream.phase === 'idle' &&
    status.stream.active === false &&
    status.stream.pending === null &&
    status.record.phase === 'idle' &&
    status.record.active === false &&
    status.record.pending === null
  );
}

export async function readObsOutputsIdle(): Promise<boolean> {
  try {
    const response = await fetch('/local/v1/obs/outputs', {
      cache: 'no-store',
      signal: AbortSignal.timeout(5000),
    });
    return response.ok && obsOutputsIdle((await response.json()) as ObsOutputsStatus);
  } catch {
    return false;
  }
}

export async function confirmHudActivation(
  name: string,
  confirm: (message: string) => Promise<boolean>,
  isCurrent: () => boolean,
): Promise<'ready' | 'cancelled' | 'changed'> {
  const offline = await readObsOutputsIdle();
  if (
    !offline &&
    !(await confirm(`OBS 正在直播、录像或状态待确认。启用「${name}」会改变正式 HUD，确认启用？`))
  )
    return 'cancelled';
  return isCurrent() ? 'ready' : 'changed';
}

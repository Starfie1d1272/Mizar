// Join the current editor's commit before the existing enter-workspace intent.
let prepare: (() => Promise<void>) | undefined;
export function registerObserverPreparation(commit: () => Promise<void>) {
  prepare = commit;
  return () => {
    if (prepare === commit) prepare = undefined;
  };
}
export async function flushObserverPreparation(): Promise<boolean> {
  await prepare?.();
  const response = await fetch('/local/v1/observer-assist', {
    cache: 'no-store',
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error('请确认观察辅助设置可读取后重试进入工作台。');
  const value = (await response.json()) as { settings?: { enabled?: unknown } };
  if (typeof value.settings?.enabled !== 'boolean')
    throw new Error('请刷新准备中心后重试进入工作台。');
  return value.settings.enabled;
}

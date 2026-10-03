import { useState } from 'react';
import { Button, Panel, StatusBanner } from '../ui';
import { desktopInvoke } from '../workspace/client';

async function boundedStatus(operation: Promise<unknown>): Promise<unknown> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation.catch(() => null),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), 2000);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function booleans(value: unknown, keys: readonly string[]) {
  const input =
    typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
  return Object.fromEntries(
    keys.filter((key) => typeof input[key] === 'boolean').map((key) => [key, input[key]]),
  );
}

export function SupportExport() {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ error: boolean; message: string } | null>(null);

  async function exportBundle() {
    if (busy) return;
    setBusy(true);
    setResult(null);
    try {
      const desktop = Boolean(window.__TAURI_INTERNALS__);
      const [gsi, cs2] = desktop
        ? await Promise.all([
            boundedStatus(desktopInvoke('gsi_status')),
            boundedStatus(desktopInvoke('cs2_host_status')),
          ])
        : [null, null];
      const response = await fetch('/debug/support-bundle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          desktop: desktop
            ? {
                gsi:
                  gsi === null
                    ? null
                    : booleans(gsi, [
                        'detected',
                        'installed',
                        'conflict',
                        'fileConflict',
                        'endpointConflict',
                      ]),
                cs2: cs2 === null ? null : booleans(cs2, ['found', 'managed']),
              }
            : null,
        }),
        cache: 'no-store',
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) throw new Error('export_failed');
      const text = await response.text();
      if (
        new TextEncoder().encode(text).length > 256 * 1024 ||
        (JSON.parse(text) as { schema?: string }).schema !== 'mizar-support-bundle/1'
      )
        throw new Error('invalid_bundle');
      if (desktop) {
        const saved = await desktopInvoke<boolean>('save_support_bundle', { contents: text });
        setResult({
          error: false,
          message: saved
            ? '诊断包已保存，可将文件附在问题反馈中。'
            : '已取消保存。可以随时重新导出。',
        });
      } else {
        const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
        const link = document.createElement('a');
        link.href = url;
        link.download = `mizar-support-${new Date().toISOString().replaceAll(':', '-')}.json`;
        document.body.append(link);
        link.click();
        link.remove();
        window.setTimeout(() => URL.revokeObjectURL(url), 1000);
        setResult({
          error: false,
          message: '已发起下载。请在浏览器下载列表中确认文件后，再附在问题反馈中。',
        });
      }
    } catch {
      setResult({
        error: true,
        message:
          '诊断包未能导出。请确认 Mizar 本地服务正在运行，并检查保存位置是否可写，然后重试。',
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel>
      <h2>问题反馈</h2>
      <p>导出运行状态与启动记录，便于排查问题。</p>
      <Button
        loading={busy}
        onClick={() => void exportBundle()}
        aria-label={busy ? '正在生成诊断包' : '导出诊断包'}
      >
        导出诊断包
      </Button>
      {result === null ? null : (
        <StatusBanner tone={result.error ? 'danger' : 'info'}>{result.message}</StatusBanner>
      )}
    </Panel>
  );
}

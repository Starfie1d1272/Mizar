import { flushPerformanceJournal } from './performance-journal';
import { flushControlSnapshots, sendControlEvidence } from './control-journal';
import { useState } from 'react';
import { Field, Button, Panel, StatusBanner } from '../ui';
import { desktopInvoke } from '../workspace/client';

type CollectedStatus = { collectionStatus: 'available' | 'failed' | 'timeout'; value: unknown };
async function boundedStatus(operation: Promise<unknown>): Promise<CollectedStatus> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation.then(
        (value): CollectedStatus => ({ collectionStatus: 'available', value }),
        (): CollectedStatus => ({ collectionStatus: 'failed', value: null }),
      ),
      new Promise<CollectedStatus>((resolve) => {
        timer = setTimeout(() => resolve({ collectionStatus: 'timeout', value: null }), 8000);
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

function supportCs2(value: unknown) {
  const input =
    typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
  const fields = (value: unknown, keys: readonly string[]) => {
    if (value === null || typeof value !== 'object') return null;
    const data = value as Record<string, unknown>;
    return Object.fromEntries(
      keys.filter((key) => data[key] !== undefined).map((key) => [key, data[key]]),
    );
  };
  const geometry = fields(input.geometry, [
    'dpi',
    'client',
    'outer',
    'monitorBounds',
    'workArea',
    'layoutArea',
    'target',
    'alignmentRetries',
    'preserveSettings',
    'fullscreenLayout',
  ]);
  if (geometry) {
    const measured = input.geometry as Record<string, unknown>;
    for (const key of ['alignmentFailure', 'groupFailure'])
      geometry[key] = fields(measured[key], ['stage', 'api', 'lastError', 'target']);
    for (const key of ['hostElevation', 'gameElevation'])
      geometry[key] = fields(measured[key], ['elevated', 'lastError']);
  }
  return {
    ...booleans(value, ['found', 'managed']),
    ...(input.geometry !== undefined ? { geometry } : {}),
  };
}

function supportGsi(value: unknown) {
  const input =
    typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
  const operation =
    typeof input.lastOperation === 'object' && input.lastOperation !== null
      ? (input.lastOperation as Record<string, unknown>)
      : {};
  return {
    ...booleans(input, [
      'detected',
      'installed',
      'conflict',
      'fileConflict',
      'endpointConflict',
      'readFailed',
    ]),
    ...(typeof input.candidateCount === 'number' ? { candidateCount: input.candidateCount } : {}),
    ...(typeof input.conflictCount === 'number' ? { conflictCount: input.conflictCount } : {}),
    issueCodes: Array.isArray(input.issues)
      ? input.issues
          .slice(0, 16)
          .map((issue: { code?: unknown }) => issue.code)
          .filter((code) => typeof code === 'string')
      : [],
    lastOperation:
      typeof operation.code === 'string' && typeof operation.stage === 'string'
        ? { code: operation.code, stage: operation.stage }
        : null,
  };
}

export function SupportExport() {
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ error: boolean; message: string } | null>(null);

  async function exportBundle() {
    if (busy) return;
    setBusy(true);
    setResult(null);
    let stage: 'collect' | 'generate' | 'save' = 'collect';
    try {
      const desktop = Boolean(window.__TAURI_INTERNALS__);
      const [gsi, cs2, consoleStatus] = desktop
        ? await Promise.all([
            boundedStatus(desktopInvoke('gsi_status')),
            boundedStatus(desktopInvoke('cs2_host_status')),
            boundedStatus(desktopInvoke('cs2_console_status')),
          ])
        : [null, null, null];
      if (consoleStatus)
        await sendControlEvidence(
          'cs2_console_export_snapshot',
          consoleStatus.collectionStatus === 'available' ? 'result' : 'failure',
          { ...consoleStatus, deadlineMs: 8000 },
        );
      await flushControlSnapshots();
      await flushPerformanceJournal();
      stage = 'generate';
      const response = await fetch('/debug/support-bundle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...(from ? { from: new Date(from).toISOString() } : {}),
          ...(to ? { to: new Date(to).toISOString() } : {}),
          desktop: desktop
            ? {
                gsi:
                  gsi === null
                    ? null
                    : { collectionStatus: gsi.collectionStatus, ...supportGsi(gsi.value) },
                cs2:
                  cs2 === null
                    ? null
                    : {
                        collectionStatus: cs2.collectionStatus,
                        ...supportCs2(cs2.value),
                      },
              }
            : null,
        }),
        cache: 'no-store',
        signal: AbortSignal.timeout(120_000),
      });
      if (!response.ok) throw new Error(`export_http_${response.status}`);
      const text = await response.text();
      if (
        new TextEncoder().encode(text).length > 256 * 1024 * 1024 ||
        (JSON.parse(text) as { schema?: string }).schema !== 'mizar-support-bundle/1'
      )
        throw new Error('invalid_bundle');
      stage = 'save';
      if (desktop) {
        const saved = await desktopInvoke<boolean>('save_support_bundle', { contents: text });
        setResult({
          error: false,
          message: saved ? '诊断包已保存，请私下交付维护者。' : '已取消保存。可以随时重新导出。',
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
          message: '已发起下载。请在浏览器下载列表中确认文件后，再私下交付维护者。',
        });
      }
    } catch (error) {
      const code = error instanceof Error ? error.message : '';
      setResult({
        error: true,
        message:
          stage === 'save'
            ? '诊断包已生成，但未能保存。请检查保存位置后重新导出。'
            : code.startsWith('export_http_')
              ? `本地服务未能生成诊断包（HTTP ${code.slice(12)}），请稍后重试。`
              : code === 'invalid_bundle'
                ? '诊断包内容不完整或超过大小限制，请缩短导出时间范围后重试。'
                : stage === 'generate'
                  ? '诊断包生成请求未完成，请检查本地服务连接后重试。'
                  : '诊断信息收集未完成，请稍后重试。',
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel>
      <h2>问题反馈</h2>
      <p>
        诊断包包含操作记录、比赛账号信息（含名单和 Steam64）及相关 OBS
        日志。人工导出不会自动上传；技术诊断回传需另行同意。请私下交付维护者，反馈时附上版本、时间和操作步骤。
      </p>
      <p>
        <a
          href="https://github.com/Starfie1d1272/Mizar/issues/new?template=bug-report.yml"
          target="_blank"
          rel="noreferrer"
          onClick={(event) => {
            if (!window.__TAURI_INTERNALS__) return;
            event.preventDefault();
            void desktopInvoke('open_issue_report').catch(() =>
              setResult({
                error: true,
                message: '浏览器未能打开，请手动访问 github.com/Starfie1d1272/Mizar/issues。',
              }),
            );
          }}
        >
          在 GitHub 反馈问题
        </a>
      </p>
      <details>
        <summary>导出时间范围</summary>
        <Field
          label="开始时间（留空包含全部保留记录）"
          type="datetime-local"
          value={from}
          onChange={(e) => setFrom(e.target.value)}
        />
        <Field
          label="结束时间（留空至导出时）"
          type="datetime-local"
          value={to}
          onChange={(e) => setTo(e.target.value)}
        />
      </details>
      <Button
        variant="primary"
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

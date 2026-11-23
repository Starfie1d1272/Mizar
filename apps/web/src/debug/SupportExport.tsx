import { flushPerformanceJournal } from './performance-journal';
import {
  flushControlEvidence,
  flushControlSnapshots,
  sendControlEvidence,
} from './control-journal';
import { useEffect, useRef, useState } from 'react';
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

type ReadyExport = {
  exportId: string;
  expiresAt: string;
  knownGaps?: number;
  downloadName?: string;
  cleanupStatus?: 'unconfirmed';
};
const gapNotice = (job: ReadyExport) =>
  (job.knownGaps ? ` 部分记录缺失或覆盖范围未确认（${job.knownGaps} 处），详情在诊断包内。` : '') +
  (job.cleanupStatus === 'unconfirmed'
    ? ' 诊断包可用，但临时资源清理未确认，可能仍占用本机存储。'
    : '');
function download(job: ReadyExport) {
  const link = document.createElement('a');
  link.href = `/debug/support-exports/${job.exportId}/files/part-1.zip`;
  link.download = job.downloadName ?? 'mizar-support.zip';
  document.body.append(link);
  link.click();
  link.remove();
}

function defaultExportFrom(now = Date.now()): string {
  const date = new Date(now - 3 * 86_400_000);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function SupportExport() {
  const [from, setFrom] = useState(() => defaultExportFrom());
  const [to, setTo] = useState('');
  const [busy, setBusy] = useState(false);
  const [savingLocal, setSavingLocal] = useState(false);
  const busyRef = useRef(false);
  const [progress, setProgress] = useState<{
    exportId: string;
    phase: string;
    inputBytes?: number;
    outputBytes?: number;
  } | null>(null);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  const rangeRef = useRef('');
  useEffect(() => {
    rangeRef.current = `${from}\0${to}`;
  }, [from, to]);
  const [readyJob, setReadyJob] = useState<ReadyExport | null>(null);
  const hasReadyJob = readyJob !== null;
  const [result, setResult] = useState<{ error: boolean; message: string } | null>(null);

  async function exportBundle(regenerate = false) {
    const exportRange = rangeRef.current;
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setResult(null);
    setProgress(null);
    controller.current = new AbortController();
    const signal = controller.current.signal;
    let activeExportId: string | undefined;
    const cancelExport = () => {
      if (activeExportId)
        void fetch(`/debug/support-exports/${activeExportId}/cancel`, { method: 'POST' }).catch(
          () => undefined,
        );
    };
    signal.addEventListener('abort', cancelExport, { once: true });
    let stage: 'collect' | 'generate' | 'save' = 'collect';
    let deliveryJob = readyJob;
    const desktop = Boolean(window.__TAURI_INTERNALS__);
    try {
      const cached =
        !regenerate && readyJob && Date.parse(readyJob.expiresAt) > Date.now() ? readyJob : null;
      if (readyJob && !cached) {
        setReadyJob(null);
      }
      const save = async (job: ReadyExport) => {
        deliveryJob = job;
        setProgress({ exportId: job.exportId, phase: 'saving' });
        if (desktop) {
          const saved = await desktopInvoke('save_support_bundle', {
            exportId: job.exportId,
          });
          setResult({
            error: false,
            message:
              (saved
                ? '诊断包已保存，请私下交付维护者。'
                : '已取消保存，可重新保存同一份诊断包。') + gapNotice(job),
          });
        } else {
          download(job);
          setResult({
            error: false,
            message: '已发起诊断包下载，请在浏览器中确认文件。' + gapNotice(job),
          });
        }
      };
      if (cached) {
        stage = 'save';
        await save(cached);
        return;
      }
      const [gsi, cs2, consoleStatus] = desktop
        ? await Promise.all([
            boundedStatus(desktopInvoke('gsi_status')),
            boundedStatus(desktopInvoke('cs2_host_status')),
            boundedStatus(desktopInvoke('cs2_console_status')),
          ])
        : [null, null, null];
      if (consoleStatus)
        void sendControlEvidence(
          'cs2_console_export_snapshot',
          consoleStatus.collectionStatus === 'available' ? 'result' : 'failure',
          { ...consoleStatus, deadlineMs: 8000 },
        );
      flushControlSnapshots();
      void flushPerformanceJournal().catch(() =>
        sendControlEvidence('browser_performance', 'export_snapshot_failed', {
          reason: 'snapshot_unavailable',
        }),
      );
      // Let synchronous snapshot failures join the fixed document prefix.
      await Promise.resolve();
      const [documentHandoff, host] = await Promise.all([
        flushControlEvidence(),
        desktop ? boundedStatus(desktopInvoke('read_support_log_state')) : Promise.resolve(null),
      ]);
      if (signal.aborted) throw new Error('export_cancelled');
      stage = 'generate';
      const requestBody = JSON.stringify({
        ...(host?.collectionStatus === 'available' ? { host: host.value } : {}),
        documentHandoff,
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
      });
      // This admission request is issued once. Never replay an uncertain result
      // or follow a redirect that could change its destination/ownership.
      const response = await fetch('/debug/support-exports', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: requestBody,
        cache: 'no-store',
        redirect: 'error',
        signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
      });
      if (!response.ok) throw new Error(`export_http_${response.status}`);
      let job = (await response.json()) as {
        exportId: string;
        phase: string;
        error?: string;
        parts?: { name: string }[];
        expiresAt?: string;
        knownGaps?: number;
        downloadName?: string;
        cleanupStatus?: 'unconfirmed';
      };
      activeExportId = job.exportId;
      if (signal.aborted) cancelExport();
      setProgress(job);
      let unavailable = 0;
      while (!['ready', 'failed', 'cancelled'].includes(job.phase)) {
        if (signal.aborted) throw new Error('export_cancelled');
        await new Promise((resolve) => setTimeout(resolve, 1000));
        const status = await fetch(`/debug/support-exports/${activeExportId}`, {
          signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]),
          cache: 'no-store',
        }).catch(() => null);
        if ((!status || status.status >= 500) && !signal.aborted && ++unavailable < 3) continue;
        if (!status?.ok) throw new Error('export_status_unavailable');
        unavailable = 0;
        job = await status.json();
        if (job.exportId !== activeExportId) throw new Error('export_identity_mismatch');
        setProgress(job);
      }
      activeExportId = undefined;
      // A terminal phase may precede cleanup; pin release waits for confirmed settlement.
      if (job.phase === 'cancelled') throw new Error('export_cancelled');
      if (job.phase === 'failed' || job.parts?.length !== 1 || job.parts[0]?.name !== 'part-1.zip')
        throw new Error(job.error ?? 'invalid_bundle');
      if (!job.expiresAt) throw new Error('invalid_bundle');
      const ready: ReadyExport = {
        exportId: job.exportId,
        expiresAt: job.expiresAt,
        ...(job.knownGaps === undefined ? {} : { knownGaps: job.knownGaps }),
        ...(job.downloadName === undefined ? {} : { downloadName: job.downloadName }),
        ...(job.cleanupStatus === 'unconfirmed' ? { cleanupStatus: job.cleanupStatus } : {}),
      };
      if (rangeRef.current === exportRange) setReadyJob(ready);
      stage = 'save';
      await save(ready);
    } catch (error) {
      const code = error instanceof Error ? error.message : '';
      setResult({
        error: true,
        message:
          code === 'export_cancelled' || signal.aborted
            ? '已取消生成诊断包。'
            : stage === 'save'
              ? '诊断包已生成，但交付未完成。请重新保存或下载同一份诊断包。' +
                (deliveryJob ? gapNotice(deliveryJob) : '')
              : code === 'Error: export_cache_cleanup_failed'
                ? '诊断缓存清理未完成，请检查存储空间和文件权限后重试。原始日志已保留。'
                : code === 'Error: export_cache_lease_unconfirmed'
                  ? '诊断缓存的占用状态无法确认。若有诊断包保存窗口，请完成或取消保存后重试；否则可能是旧清理标记残留，当前不能安全自动移除，请联系维护者恢复缓存。原始日志已保留。'
                  : code.startsWith('export_http_')
                    ? `Mizar 后台服务未能生成诊断包（HTTP ${code.slice(12)}），请稍后重试。`
                    : code === 'invalid_bundle'
                      ? '诊断包内容不完整或超过大小限制，请缩短导出时间范围后重试。'
                      : stage === 'generate'
                        ? desktop
                          ? '结构化诊断包未能生成。你可以直接保存本机日志。'
                          : '诊断包生成请求未完成。请在 Mizar 桌面端直接保存本机日志。'
                        : '诊断信息收集未完成，请稍后重试。',
      });
    } finally {
      signal.removeEventListener('abort', cancelExport);
      busyRef.current = false;
      setBusy(false);
    }
  }

  return (
    <Panel id="support-export">
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
          label="开始时间（默认近 3 天，留空包含全部保留记录）"
          type="datetime-local"
          disabled={busy}
          value={from}
          onChange={(e) => {
            setFrom(e.target.value);
            setReadyJob(null);
          }}
        />
        <Field
          label="结束时间（留空至导出时）"
          type="datetime-local"
          disabled={busy}
          value={to}
          onChange={(e) => {
            setTo(e.target.value);
            setReadyJob(null);
          }}
        />
      </details>
      {busy && progress ? (
        <p role="status">
          {progress.phase === 'saving'
            ? '正在保存或下载诊断包'
            : progress.phase === 'collecting'
              ? '正在固定来源范围'
              : '正在生成诊断包'}{' '}
          · 已读取 {Math.round((progress.inputBytes ?? 0) / 1024)} KiB · 已输出{' '}
          {Math.round((progress.outputBytes ?? 0) / 1024)} KiB
        </p>
      ) : null}
      {busy && !['ready', 'saving'].includes(progress?.phase ?? '') ? (
        <Button onClick={() => controller.current?.abort()}>取消生成</Button>
      ) : null}
      {!busy && hasReadyJob ? (
        <Button
          onClick={() => {
            {
              setReadyJob(null);
            }
            void exportBundle(true);
          }}
        >
          重新生成诊断包
        </Button>
      ) : null}
      <Button
        variant="primary"
        loading={busy}
        onClick={() => void exportBundle()}
        aria-label={
          busy
            ? '正在处理诊断包'
            : hasReadyJob
              ? window.__TAURI_INTERNALS__
                ? '重新保存'
                : '重新下载'
              : '保存诊断包'
        }
      >
        {hasReadyJob ? (window.__TAURI_INTERNALS__ ? '重新保存' : '重新下载') : '保存诊断包'}
      </Button>
      {window.__TAURI_INTERNALS__ ? (
        <Button
          loading={savingLocal}
          onClick={() => {
            setSavingLocal(true);
            void desktopInvoke('save_local_logs')
              .then((saved) => {
                if (saved) setResult({ error: false, message: '本机日志已保存。' });
              })
              .catch((error: unknown) => {
                setResult({
                  error: true,
                  message: error instanceof Error ? error.message : '本机日志包未能保存。',
                });
              })
              .finally(() => setSavingLocal(false));
          }}
        >
          保存本机日志
        </Button>
      ) : null}
      {result === null ? null : (
        <StatusBanner tone={result.error ? 'danger' : 'info'}>{result.message}</StatusBanner>
      )}
    </Panel>
  );
}

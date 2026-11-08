import { flushPerformanceJournal } from './performance-journal';
import { flushControlSnapshots, sendControlEvidence } from './control-journal';
import { useRef, useState } from 'react';
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
  parts: { name: string }[];
  knownGaps?: number;
  downloadName?: string;
};
const gapNotice = (job: ReadyExport) =>
  job.knownGaps ? ` 部分记录未能读取（${job.knownGaps} 处），详情在诊断包内。` : '';
function download(job: ReadyExport, name: string) {
  const link = document.createElement('a');
  link.href = `/debug/support-exports/${job.exportId}/files/${name}`;
  link.download =
    job.parts.length === 1 && name.endsWith('.zip') ? (job.downloadName ?? name) : name;
  document.body.append(link);
  link.click();
  link.remove();
}

export function SupportExport() {
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [progress, setProgress] = useState<{
    exportId: string;
    phase: string;
    inputBytes?: number;
    outputBytes?: number;
  } | null>(null);
  const controller = useRef<AbortController | null>(null);
  const [readyJob, setReadyJob] = useState<ReadyExport | null>(null);
  const hasReadyJob = readyJob !== null;
  const [result, setResult] = useState<{ error: boolean; message: string } | null>(null);

  async function exportBundle(regenerate = false) {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setResult(null);
    setProgress(null);
    controller.current = new AbortController();
    const signal = controller.current.signal;
    const deadline = Date.now() + 120_000;
    let stage: 'collect' | 'generate' | 'save' = 'collect';
    let hostPinId: string | undefined;
    let deliveryJob = readyJob;
    try {
      const desktop = Boolean(window.__TAURI_INTERNALS__);
      const cached =
        !regenerate && readyJob && Date.parse(readyJob.expiresAt) > Date.now() ? readyJob : null;
      if (readyJob && !cached) {
        setReadyJob(null);
      }
      const save = async (job: ReadyExport) => {
        deliveryJob = job;
        setProgress({ exportId: job.exportId, phase: 'saving' });
        if (desktop) {
          const saved = await desktopInvoke<boolean>('save_support_bundle', {
            exportId: job.exportId,
          });
          setResult({
            error: false,
            message:
              (saved
                ? job.parts.length === 1
                  ? '诊断包已保存，请私下交付维护者。'
                  : `诊断包已保存，请一并交付 ${job.parts.length} 份 ZIP 和总清单。`
                : '已取消保存，可重新保存同一份诊断包。') + gapNotice(job),
          });
        } else {
          for (const name of [
            ...job.parts.map((part) => part.name),
            ...(job.parts.length > 1 ? ['generated.json'] : []),
          ])
            download(job, name);
          setResult({
            error: false,
            message:
              (job.parts.length === 1
                ? '已发起诊断包下载，请在浏览器中确认文件。'
                : `已发起 ${job.parts.length} 份 ZIP 和总清单的下载，请在浏览器中确认全部文件。`) +
              gapNotice(job),
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
        await sendControlEvidence(
          'cs2_console_export_snapshot',
          consoleStatus.collectionStatus === 'available' ? 'result' : 'failure',
          { ...consoleStatus, deadlineMs: 8000 },
        );
      await flushControlSnapshots();
      await flushPerformanceJournal();
      if (desktop) {
        hostPinId = crypto.randomUUID();
        try {
          await desktopInvoke('diagnostic_pin', {
            action: 'prepare',
            pinId: hostPinId,
            kind: 'export',
          });
          await desktopInvoke('diagnostic_pin', {
            action: 'commit',
            pinId: hostPinId,
            kind: 'export',
          });
        } catch (error) {
          // Companion verifies the fixed receipt itself and reports this producer's gap.
          // Failure to pin Host evidence must not discard other safely fixed sources.
          await sendControlEvidence('support_export_host_pin', 'failure', {
            exportId: hostPinId,
            error:
              error instanceof Error ? { name: error.name, message: error.message } : String(error),
          });
        }
      }
      if (signal.aborted) throw new Error('export_cancelled');
      stage = 'generate';
      const response = await fetch('/debug/support-exports', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...(hostPinId ? { hostPinId } : {}),
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
        signal: AbortSignal.any([signal, AbortSignal.timeout(120_000)]),
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
      };
      setProgress(job);
      while (!['ready', 'failed', 'cancelled'].includes(job.phase)) {
        if (signal.aborted) throw new Error('export_cancelled');
        if (Date.now() > deadline) throw new Error('export_deadline');
        await new Promise((resolve) => setTimeout(resolve, 250));
        const status = await fetch(`/debug/support-exports/${job.exportId}`, {
          signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]),
          cache: 'no-store',
        });
        if (!status.ok) throw new Error('export_status_unavailable');
        job = await status.json();
        setProgress(job);
      }
      if (job.phase === 'cancelled') throw new Error('export_cancelled');
      if (job.phase === 'failed' || !job.parts?.length)
        throw new Error(job.error ?? 'invalid_bundle');
      if (!job.expiresAt) throw new Error('invalid_bundle');
      const ready: ReadyExport = {
        exportId: job.exportId,
        parts: job.parts,
        expiresAt: job.expiresAt,
        ...(job.knownGaps === undefined ? {} : { knownGaps: job.knownGaps }),
        ...(job.downloadName === undefined ? {} : { downloadName: job.downloadName }),
      };
      setReadyJob(ready);
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
              : code.startsWith('export_http_')
                ? `本地服务未能生成诊断包（HTTP ${code.slice(12)}），请稍后重试。`
                : code === 'invalid_bundle'
                  ? '诊断包内容不完整或超过大小限制，请缩短导出时间范围后重试。'
                  : stage === 'generate'
                    ? '诊断包生成请求未完成，请检查本地服务连接后重试。'
                    : '诊断信息收集未完成，请稍后重试。',
      });
    } finally {
      if (hostPinId)
        await desktopInvoke('diagnostic_pin', {
          action: 'release',
          pinId: hostPinId,
          kind: 'export',
        }).catch(() => undefined);
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
        <Button
          onClick={() => {
            controller.current?.abort();
            if (progress)
              void fetch(`/debug/support-exports/${progress.exportId}/cancel`, { method: 'POST' });
          }}
        >
          取消生成
        </Button>
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
      {!busy &&
      hasReadyJob &&
      !window.__TAURI_INTERNALS__ &&
      readyJob &&
      readyJob.parts.length > 1 ? (
        <div aria-label="重新下载文件">
          {[...readyJob.parts.map((part) => part.name), 'generated.json'].map((name) => (
            <Button
              key={name}
              onClick={() => {
                if (readyJob) download(readyJob, name);
              }}
            >
              重新下载 {name}
            </Button>
          ))}
        </div>
      ) : null}
      {result === null ? null : (
        <StatusBanner tone={result.error ? 'danger' : 'info'}>{result.message}</StatusBanner>
      )}
    </Panel>
  );
}

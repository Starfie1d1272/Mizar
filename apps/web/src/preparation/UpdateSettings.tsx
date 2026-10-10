import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Checkbox, Panel, StatusBanner } from '../ui';
import { desktopInvoke } from '../workspace/client';
import './updates.css';
import { openTool } from './client';

interface UpdateStatus {
  phase:
    | 'idle'
    | 'checking'
    | 'current'
    | 'available'
    | 'downloading'
    | 'ready'
    | 'installing'
    | 'manual'
    | 'error';
  productionRevision: string;
  automatic: boolean;
  currentVersion: string;
  distribution: 'installed' | 'portable';
  error: string | null;
  failureDetails?: {
    stage: string;
    stageLabel?: string;
    summary: string;
    nextStep: string;
    operationId: string;
  }[];
  downloadedBytes: number;
  candidate: null | { version: string; notes: string; installer: { bytes: number } };
  installBlockedReason?: string | null;
  canResumeAutomatic?: boolean;
  lastResult?: 'installed' | 'restored' | 'recovery-required' | 'cancelled' | null;
}
const failures: Record<string, string> = {
  update_network_failed: '更新网络请求失败，具体原因请查看诊断；网络恢复后可重新检查。',
  update_trust_metadata_failed:
    'Sigstore 信任元数据未能刷新，尚未完成来源认证；请检查网络或从正式发布页下载完整离线包。',
  update_operation_failed: '更新未完成，原因未知。请导出诊断定位原因。',
  update_metadata_missing: '暂时无法验证更新，请从发布页下载。',
  update_provenance_failed:
    '更新来源认证未通过。请保留现有版本，导出诊断并从正式发布页核对安装包。',
  update_rollback_rejected: '更新版本发生回退，已拒绝安装。请从正式发布页核对版本。',
  update_identity_changed:
    '同版本更新内容发生变化，已拒绝安装。请导出诊断并从正式发布页核对安装包。',
  update_download_corrupt: '下载不完整，请重试。',
  update_settings_invalid: '更新设置无法保存，请检查资料目录。',
};
async function sendAction(action: string, enabled?: boolean): Promise<UpdateStatus> {
  const response = await fetch('/operator/updates', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, ...(enabled === undefined ? {} : { enabled }) }),
    signal: AbortSignal.timeout(75_000),
  });
  const value = (await response.json()) as UpdateStatus & { error?: string };
  if (!response.ok)
    throw new Error(
      value.failureDetails?.map((detail) => `${detail.summary} ${detail.nextStep}`).join('\n') ||
        failures[value.error ?? ''] ||
        '更新未完成，原因未知。请导出诊断定位原因。',
    );
  return value;
}
export function UpdateSettings() {
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [requested, setRequested] = useState(false);
  const [error, setError] = useState('');
  const [connectionError, setConnectionError] = useState('');
  const [diagnosticFeedback, setDiagnosticFeedback] = useState('');
  const [unavailable, setUnavailable] = useState(false);
  const installing = useRef(false);
  const resumed = useRef(false);
  const requestedRevision = useRef<string | null>(null);
  const desktop = Boolean(window.__TAURI_INTERNALS__);
  const applyStatus = useCallback((next: UpdateStatus) => {
    setStatus(next);
    if (
      next.phase === 'error' ||
      next.error === 'update_cancelled' ||
      (next.phase === 'ready' && next.installBlockedReason && !next.canResumeAutomatic)
    )
      setRequested(false);
  }, []);
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    let request: AbortController;
    const poll = async () => {
      request = new AbortController();
      try {
        const response = await fetch('/local/v1/updates', {
          cache: 'no-store',
          signal: AbortSignal.any([request.signal, AbortSignal.timeout(8000)]),
        });
        if (response.status === 404) {
          if (active) setUnavailable(true);
          return;
        }
        if (!response.ok) throw new Error();
        const next = (await response.json()) as UpdateStatus;
        if (active) {
          applyStatus(next);
          setConnectionError('');
        }
      } catch {
        if (active) setConnectionError('暂时无法检查更新。');
      } finally {
        if (active) timer = setTimeout(() => void poll(), 3000);
      }
    };
    void poll();
    return () => {
      active = false;
      clearTimeout(timer);
      request?.abort();
    };
  }, [applyStatus]);
  useEffect(() => {
    if (!requested || !status || installing.current) return;
    if (status.productionRevision !== requestedRevision.current) {
      setRequested(false);
      return;
    }
    if (status.phase === 'error' || status.error === 'update_cancelled') return;
    if (status.phase !== 'ready') return;
    if (status.installBlockedReason && (!status.canResumeAutomatic || resumed.current)) {
      return;
    }
    installing.current = true;
    const complete = async () => {
      try {
        if (status.installBlockedReason) {
          resumed.current = true;
          applyStatus(await sendAction('resume'));
        } else {
          await desktopInvoke('install_update');
          setRequested(false);
        }
      } catch (reason) {
        setRequested(false);
        setError(reason instanceof Error ? reason.message : '更新未完成，请重试。');
      } finally {
        installing.current = false;
      }
    };
    void complete();
  }, [requested, status, applyStatus]);
  const action = async (name: string, enabled?: boolean) => {
    if (busy || installing.current) return;
    if (name === 'cancel') setRequested(false);
    setBusy(true);
    setError('');
    try {
      applyStatus(await sendAction(name, enabled));
    } catch (reason) {
      setRequested(false);
      setError(reason instanceof Error ? reason.message : '更新未完成，请重试。');
    } finally {
      setBusy(false);
    }
  };
  const update = async () => {
    if (busy || !desktop || !status) return;
    setError('');
    resumed.current = false;
    requestedRevision.current = status.productionRevision;
    if (status.phase === 'available') {
      setBusy(true);
      try {
        applyStatus(await sendAction('download'));
        setRequested(true);
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : '更新未完成，请重试。');
      } finally {
        setBusy(false);
      }
    } else setRequested(true);
  };
  const openPage = async (source: 'github' | 'mirror') => {
    try {
      if (desktop)
        await desktopInvoke('open_update_page', {
          source,
          version: status?.candidate?.version ?? null,
        });
      else
        window.open(
          source === 'mirror'
            ? 'https://box.nju.edu.cn/d/91dec4c27e5d47f38fcf/'
            : 'https://github.com/Starfie1d1272/Mizar/releases',
          '_blank',
          'noopener,noreferrer',
        );
    } catch {
      setError('下载页面未能打开。');
    }
  };
  const copyDiagnostics = async () => {
    try {
      const response = await fetch('/debug/support-bundle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ desktop: null }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) throw new Error('export_failed');
      const text = await response.text();
      if (
        new TextEncoder().encode(text).length > 256 * 1024 ||
        (JSON.parse(text) as { schema?: string }).schema !== 'mizar-support-bundle/1'
      )
        throw new Error('export_too_large');
      await navigator.clipboard.writeText(text);
      setDiagnosticFeedback('诊断信息已复制，包含脱敏原因与相关输出。');
    } catch {
      setDiagnosticFeedback('诊断复制未完成，请打开诊断页面导出。');
    }
  };
  const phase = status?.phase;
  const waiting = busy || phase === 'checking' || phase === 'installing';
  const downloading = phase === 'downloading';
  const blocked = status?.installBlockedReason && !status.canResumeAutomatic;
  const failure =
    error ||
    connectionError ||
    (status?.error && status.error !== 'update_cancelled'
      ? status.failureDetails
          ?.map((detail) => `${detail.stageLabel ?? '更新'}：${detail.summary} ${detail.nextStep}`)
          .join('\n') ||
        failures[status.error] ||
        '更新未完成，原因未知。请导出诊断定位原因。'
      : '');
  return (
    <Panel className="settings-card settings-card--wide settings-update">
      <div className="settings-update-header">
        <div>
          <h2>应用更新</h2>
          {status ? <p className="settings-update-version">当前 v{status.currentVersion}</p> : null}
        </div>
        <Button
          disabled={!status || waiting || downloading || requested}
          onClick={() => void action('check')}
        >
          {phase === 'checking' ? '正在检查…' : '检查更新'}
        </Button>
      </div>
      {status?.candidate ? (
        <div className="settings-update-release">
          <h3>v{status.candidate.version}</h3>
          <div className="settings-update-notes">{status.candidate.notes}</div>
        </div>
      ) : phase === 'current' ? (
        <p>已是最新版本。</p>
      ) : unavailable ? (
        <p>请在桌面应用中检查更新。</p>
      ) : null}
      {downloading ? (
        <div className="settings-update-progress">
          <progress
            aria-label="更新下载进度"
            value={status?.downloadedBytes ?? 0}
            max={status?.candidate?.installer.bytes ?? 1}
          />
          <span>
            {Math.min(
              100,
              Math.floor(
                ((status?.downloadedBytes ?? 0) / (status?.candidate?.installer.bytes ?? 1)) * 100,
              ),
            )}
            %
          </span>
        </div>
      ) : null}
      {blocked && phase === 'ready' ? (
        <StatusBanner tone="warning">{status.installBlockedReason}</StatusBanner>
      ) : null}
      {failure ? (
        <StatusBanner tone="danger">
          <p>{failure}</p>
          <Button onClick={() => void copyDiagnostics()}>复制诊断信息</Button>
          <Button
            onClick={() =>
              void openTool('diagnostics').catch(() =>
                setDiagnosticFeedback('诊断页面未能打开，请从高级设置进入。'),
              )
            }
          >
            导出诊断包
          </Button>
          {diagnosticFeedback ? <p>{diagnosticFeedback}</p> : null}
        </StatusBanner>
      ) : null}
      {status?.lastResult === 'restored' ? (
        <StatusBanner tone="warning">升级未完成，已恢复旧版。</StatusBanner>
      ) : null}
      {status?.lastResult === 'recovery-required' ? (
        <StatusBanner tone="danger">
          升级需要恢复。
          <Button
            onClick={() =>
              void desktopInvoke('open_update_recovery').catch(() => setError('恢复工具未能打开。'))
            }
          >
            打开恢复工具
          </Button>
        </StatusBanner>
      ) : null}
      <div className="settings-update-footer">
        <div className="preparation-actions">
          {phase === 'available' || phase === 'ready' || requested ? (
            <Button
              variant="primary"
              disabled={waiting || downloading || requested || !desktop || Boolean(blocked)}
              aria-busy={requested || undefined}
              onClick={() => void update()}
            >
              {requested ? '正在更新…' : '一键更新'}
            </Button>
          ) : null}
          {downloading ? (
            <Button disabled={busy} onClick={() => void action('cancel')}>
              取消
            </Button>
          ) : null}
          {downloading && requested ? (
            <Button onClick={() => setRequested(false)}>稍后</Button>
          ) : null}
          {phase === 'manual' ? (
            <Button variant="primary" onClick={() => void openPage('mirror')}>
              下载新版
            </Button>
          ) : null}
          {phase === 'manual' || phase === 'error' ? (
            <Button onClick={() => void openPage('github')}>GitHub 下载</Button>
          ) : null}
        </div>
        {status ? (
          <details className="settings-update-options">
            <summary>更新设置</summary>
            <Checkbox
              label="自动检查更新"
              checked={status.automatic}
              disabled={waiting || downloading || requested}
              onChange={(event) => void action('automatic', event.target.checked)}
            />
          </details>
        ) : null}
      </div>
    </Panel>
  );
}

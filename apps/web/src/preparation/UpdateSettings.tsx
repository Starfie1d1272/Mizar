import { useState, type ReactNode } from 'react';
import { Button, Checkbox, Panel, StatusBanner } from '../ui';
import './updates.css';
import { openTool } from './client';
import {
  formatMegabytes,
  installDesktopUpdate,
  openUpdateReleasePage,
  sendUpdateAction,
  useUpdatePolling,
  useUpdateStatus,
} from './updates-client';

function StandaloneUpdateSettings({ children }: { children?: ReactNode }) {
  const polling = useUpdatePolling();
  return <UpdateSettingsView {...polling}>{children}</UpdateSettingsView>;
}

export function UpdateSettings({ children }: { children?: ReactNode }) {
  const shared = useUpdateStatus();
  if (!shared) return <StandaloneUpdateSettings>{children}</StandaloneUpdateSettings>;
  return <UpdateSettingsView {...shared}>{children}</UpdateSettingsView>;
}

function UpdateSettingsView({
  status,
  setStatus,
  connectionError,
  unavailable,
  children,
}: ReturnType<typeof useUpdatePolling> & { children?: ReactNode }) {
  const [busy, setBusy] = useState(false);
  const [installingNow, setInstallingNow] = useState(false);
  const [error, setError] = useState('');
  const [diagnosticFeedback, setDiagnosticFeedback] = useState('');
  const desktop = Boolean(window.__TAURI_INTERNALS__);

  const action = async (name: string, enabled?: boolean) => {
    if (busy || installingNow) return;
    setBusy(true);
    setError('');
    try {
      setStatus(await sendUpdateAction(name, enabled));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '更新未完成，请重试。');
    } finally {
      setBusy(false);
    }
  };

  const install = async () => {
    if (busy || installingNow || !desktop || !status?.staged || status.installBlockedReason) return;
    setInstallingNow(true);
    setError('');
    try {
      await installDesktopUpdate();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '更新未完成，请重试。');
    } finally {
      setInstallingNow(false);
    }
  };

  const openPage = async () => {
    try {
      await openUpdateReleasePage(status?.candidate?.version ?? status?.staged?.version ?? null);
    } catch {
      setError('下载页面未能打开。');
    }
  };

  const copyUpdateSummary = async () => {
    try {
      await navigator.clipboard.writeText(
        JSON.stringify(
          {
            schema: 'mizar-update-summary/1',
            time: new Date().toISOString(),
            currentVersion: status?.currentVersion ?? null,
            stagedVersion: status?.staged?.version ?? null,
            candidateVersion: status?.candidate?.version ?? null,
            distribution: status?.distribution ?? null,
            activity: status?.activity ?? null,
            error: status?.error ?? null,
            lastResult: status?.lastResult ?? null,
            failureDetails:
              status?.failureDetails?.map(
                ({ stage, stageLabel, summary, nextStep, operationId }) => ({
                  stage,
                  stageLabel,
                  summary,
                  nextStep,
                  operationId,
                }),
              ) ?? [],
          },
          null,
          2,
        ),
      );
      setDiagnosticFeedback('更新摘要已复制。完整操作记录请导出诊断包后私下交付维护者。');
    } catch {
      setDiagnosticFeedback('更新摘要未能复制，请导出诊断包。');
    }
  };

  const activity = status?.activity;
  const checking = activity === 'checking';
  const downloading = activity === 'downloading';
  const installing = activity === 'installing' || installingNow;
  const waiting = busy || checking || installing;
  const blocked = status?.installBlockedReason;
  const displayRelease = status?.candidate ?? status?.staged ?? null;
  const canDownloadCandidate = Boolean(
    status?.candidate &&
    !status.manual &&
    !downloading &&
    (!status.staged || status.candidate.version !== status.staged.version),
  );

  const recoveryFailures =
    status?.failureDetails?.filter(
      (detail) => detail.stage === 'result_load' || detail.stage === 'result_identity_load',
    ) ?? [];
  const showRemoteError = Boolean(
    status?.lastError && (status.lastError.manual || status.lastError.security),
  );
  const failure =
    error ||
    connectionError ||
    recoveryFailures
      .map((detail) => `${detail.stageLabel ?? '更新'}：${detail.summary} ${detail.nextStep}`)
      .join('\n') ||
    (showRemoteError && status?.lastError
      ? `${status.lastError.stageLabel}：${status.lastError.summary} ${status.lastError.nextStep}`
      : '');

  const totalBytes = status?.candidate?.installer.bytes ?? 0;
  const downloadedBytes = status?.downloadedBytes ?? 0;
  const percent =
    totalBytes > 0 ? Math.min(99, Math.floor((downloadedBytes / totalBytes) * 100)) : 0;

  return (
    <Panel className="settings-card settings-update">
      <div className="settings-update-header">
        <div>
          <h2>应用更新</h2>
          {status ? <p className="settings-update-version">当前 v{status.currentVersion}</p> : null}
        </div>
        <Button disabled={!status || waiting || downloading} onClick={() => void action('check')}>
          {checking ? '正在检查…' : '检查更新'}
        </Button>
      </div>
      {displayRelease ? (
        <div className="settings-update-release">
          <h3>
            v{displayRelease.version}
            {status?.staged?.version === displayRelease.version ? '（已准备就绪）' : ''}
          </h3>
          <details>
            <summary>更新说明</summary>
            <div className="settings-update-notes">{displayRelease.notes}</div>
          </details>
        </div>
      ) : status?.checkedCurrent && activity === 'idle' ? (
        <p>未发现可用更新。</p>
      ) : unavailable ? (
        <p>请在桌面应用中检查更新。</p>
      ) : null}
      {status?.staged && status.candidate && status.staged.version !== status.candidate.version ? (
        <p className="settings-update-version">
          本地已就绪 v{status.staged.version}，可随时重启安装。
        </p>
      ) : null}
      {downloading ? (
        <div className="settings-update-progress">
          {status?.transferStage === 'verifying' ? <span>正在校验</span> : null}
          <progress
            aria-label="更新下载进度"
            value={Math.min(downloadedBytes, Math.max(0, totalBytes - 1))}
            max={Math.max(1, totalBytes)}
          />
          <span>
            {status?.downloadSource ? `${status.downloadSource} · ` : ''}
            {formatMegabytes(downloadedBytes)} / {formatMegabytes(totalBytes)} MB · {percent}%
          </span>
        </div>
      ) : null}
      {downloading && status?.sourceMessage ? <p>{status.sourceMessage}</p> : null}
      {blocked && status?.staged ? (
        <StatusBanner tone="warning">{status.installBlockedReason}</StatusBanner>
      ) : null}
      {failure ? (
        <StatusBanner tone="danger">
          <p>{failure}</p>
          <Button onClick={() => void copyUpdateSummary()}>复制更新摘要</Button>
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
      {status?.lastResult === 'failed' ? (
        <StatusBanner tone="warning">
          应用更新未完成，当前仍运行旧版。原程序与配置未受影响，请查看诊断后重试。
        </StatusBanner>
      ) : null}
      <div className="settings-update-footer">
        <div className="preparation-actions">
          {status?.staged ? (
            <Button
              variant="primary"
              disabled={waiting || !desktop || Boolean(blocked)}
              aria-busy={installing || undefined}
              onClick={() => void install()}
            >
              {installing ? '正在更新…' : '重启并更新'}
            </Button>
          ) : null}
          {canDownloadCandidate && status?.candidate ? (
            <Button
              variant={status.staged ? 'secondary' : 'primary'}
              disabled={waiting || !desktop}
              onClick={() => void action('download')}
            >
              {status.staged ? `下载 v${status.candidate.version}` : '下载更新'}
            </Button>
          ) : null}
          {downloading ? (
            <Button disabled={busy} onClick={() => void action('cancel')}>
              取消
            </Button>
          ) : null}
          {status?.manual ? (
            <Button variant="primary" onClick={() => void openPage()}>
              前往下载
            </Button>
          ) : null}
          {failure ? <Button onClick={() => void openPage()}>GitHub 下载</Button> : null}
        </div>
        {status ? (
          <details className="settings-update-options">
            <summary>更新设置</summary>
            <Checkbox
              label="自动准备更新"
              checked={status.automatic}
              disabled={waiting}
              onChange={(event) => void action('automatic', event.target.checked)}
            />
            <p>启动 30 秒后及每 2 小时自动检查，并在非制播空闲时自动下载；重启安装始终由你决定。</p>
          </details>
        ) : null}
      </div>
      {children}
    </Panel>
  );
}

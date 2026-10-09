import { useEffect, useState } from 'react';
import { Button, Checkbox, Dialog, Panel, StatusBanner } from '../ui';
import { desktopInvoke } from '../workspace/client';
import './updates.css';

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
  automatic: boolean;
  currentVersion: string;
  distribution: 'installed' | 'portable';
  error: string | null;
  downloadedBytes: number;
  lastCheckedAt: number | null;
  candidate: null | { version: string; notes: string; installer: { bytes: number } };
  installBlockedReason?: string | null;
  canResumeAutomatic?: boolean;
  lastResult?: 'installed' | 'restored' | 'recovery-required' | 'cancelled' | null;
}
const failures: Record<string, string> = {
  update_metadata_missing: '该版本暂未提供可信更新清单，请打开正式发布页手动更新。',
  update_provenance_failed: '更新来源验证失败，安装已被阻止。请稍后重试或查看正式发布页。',
  update_rollback_rejected: '更新来源返回了更旧的版本，已拒绝回退。',
  update_identity_changed: '同一版本的更新内容发生变化，已阻止下载和安装。',
  update_download_corrupt: '安装包大小或完整性校验失败，请重新检查更新后重试。',
  update_cancelled: '已取消下载，临时文件已清理。',
  update_settings_invalid: '更新偏好无法读取，请检查用户数据目录权限。',
};
export function UpdateSettings() {
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [confirm, setConfirm] = useState(false);
  const [saved, setSaved] = useState(false);
  const desktop = Boolean(window.__TAURI_INTERNALS__);
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
          if (active) setMessage('请在正式 Mizar 桌面应用中检查更新。');
          return;
        }
        if (!response.ok) throw new Error();
        const next = (await response.json()) as UpdateStatus;
        if (active) setStatus(next);
      } catch {
        if (active) setError('无法读取更新状态，请检查本地服务后重试。');
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
  }, []);
  const action = async (name: string, enabled?: boolean) => {
    if (busy) return;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const response = await fetch('/operator/updates', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: name, ...(enabled === undefined ? {} : { enabled }) }),
        signal: AbortSignal.timeout(75_000),
      });
      const value = (await response.json()) as UpdateStatus & { error?: string };
      if (!response.ok)
        throw new Error(failures[value.error ?? ''] ?? '更新操作未完成，请检查状态后重试。');
      setStatus(value);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '更新操作未完成。');
    } finally {
      setBusy(false);
    }
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
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '下载页面未能打开。');
    }
  };
  const install = async () => {
    if (busy || !saved || status?.phase !== 'ready' || status.installBlockedReason) return;
    setBusy(true);
    setError('');
    try {
      await desktopInvoke('install_update');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '升级准备未完成，旧版保持可用。');
    } finally {
      setBusy(false);
      setConfirm(false);
      setSaved(false);
    }
  };
  const phase = status?.phase;
  const waiting = busy || phase === 'checking' || phase === 'installing';
  const total = status?.candidate?.installer.bytes ?? 1;
  return (
    <Panel className="settings-card">
      <h2>应用更新</h2>
      <p>检查新的 Stable 版本，阅读更新说明，并在制作结束后升级。</p>
      {status ? (
        <p>
          当前版本 v{status.currentVersion} ·{' '}
          {status.distribution === 'installed' ? '安装版' : '便携版'}
        </p>
      ) : null}
      <div className="preparation-actions">
        <Button
          disabled={!status || waiting || phase === 'downloading'}
          aria-busy={phase === 'checking' || undefined}
          onClick={() => void action('check')}
        >
          {phase === 'checking' ? '正在检查更新…' : '检查新版本'}
        </Button>
        <Button onClick={() => void openPage('github')}>打开正式发布页</Button>
      </div>
      {status ? (
        <Checkbox
          label="后台检查 Stable 更新"
          message="开启后最多每天检查一次；发现更新后由你决定何时下载和安装。"
          checked={status.automatic}
          disabled={waiting || phase === 'downloading'}
          onChange={(event) => void action('automatic', event.target.checked)}
        />
      ) : null}
      {phase === 'current' ? (
        <StatusBanner tone="success">当前已是最新 Stable 版本。</StatusBanner>
      ) : null}
      {status?.candidate ? (
        <>
          <p>可用版本 v{status.candidate.version}</p>
          <details className="settings-details">
            <summary>更新说明</summary>
            <div className="settings-update-notes">{status.candidate.notes}</div>
          </details>
        </>
      ) : null}
      {phase === 'available' ? (
        <Button variant="primary" disabled={waiting} onClick={() => void action('download')}>
          下载并验证更新
        </Button>
      ) : null}
      {phase === 'downloading' ? (
        <>
          <label>
            正在下载更新{' '}
            <progress aria-label="更新下载进度" value={status?.downloadedBytes ?? 0} max={total} />
          </label>
          <p>
            {Math.min(100, Math.floor(((status?.downloadedBytes ?? 0) / total) * 100))}% ·
            下载完成后验证全部文件。
          </p>
          <Button disabled={busy} onClick={() => void action('cancel')}>
            取消下载
          </Button>
        </>
      ) : null}
      {phase === 'manual' ? (
        <StatusBanner tone="info">
          {status?.distribution === 'portable'
            ? '便携版请下载新版 ZIP，备份原目录并核对 state/ 资料后更新。'
            : '该版本需要单独核对兼容性，请从正式发布页按说明手动更新。'}
        </StatusBanner>
      ) : null}
      {phase === 'ready' ? (
        <>
          <StatusBanner tone="success">安装包已下载并通过来源与完整性验证。</StatusBanner>
          {status?.installBlockedReason ? (
            <StatusBanner tone="warning">{status.installBlockedReason} 安装包会保留。</StatusBanner>
          ) : null}
          <div className="preparation-actions">
            {status?.canResumeAutomatic ? (
              <Button disabled={waiting} onClick={() => void action('resume')}>
                恢复自动编排
              </Button>
            ) : null}
            <Button
              variant="primary"
              disabled={waiting || !desktop || Boolean(status?.installBlockedReason)}
              onClick={() => {
                setSaved(false);
                setConfirm(true);
              }}
            >
              退出并升级
            </Button>
            <Button
              disabled={waiting}
              onClick={() => setMessage('安装包已保留，可在结束制作后回来安装。')}
            >
              稍后安装
            </Button>
            <Button disabled={waiting} onClick={() => void action('cancel')}>
              删除已下载更新
            </Button>
          </div>
        </>
      ) : null}
      {status?.lastResult === 'restored' ? (
        <StatusBanner tone="warning">
          上次升级未完成，已恢复旧版。请重新检查更新后重试。
        </StatusBanner>
      ) : null}
      {status?.lastResult === 'recovery-required' ? (
        <StatusBanner tone="danger">
          上次升级需要恢复。旧程序备份仍保留，请打开恢复目录并运行 Restore-Mizar.cmd。
          <Button
            onClick={() =>
              void desktopInvoke('open_update_recovery').catch(() =>
                setError('恢复目录未能打开，请查看桌面日志。'),
              )
            }
          >
            打开更新恢复目录
          </Button>
        </StatusBanner>
      ) : null}
      {error || status?.error ? (
        <StatusBanner tone="danger">
          {error ||
            failures[status?.error ?? ''] ||
            '更新验证或网络请求失败，安装已被阻止。请重新检查，或打开正式发布页。'}
        </StatusBanner>
      ) : null}
      {message ? <StatusBanner tone="info">{message}</StatusBanner> : null}
      <Dialog
        open={confirm}
        title="退出 Mizar 并升级"
        onClose={() => setConfirm(false)}
        canClose={() => !busy}
      >
        <p>
          将先结束制作、恢复游戏设置并保存已提交的资料，再关闭 Mizar
          并打开新版安装向导。安装完成后重新打开 Mizar。
        </p>
        <p>请先保存修改并关闭所有编辑与预览工具。安装失败或取消时保留用户资料并恢复旧版。</p>
        <Checkbox
          label="我已保存资料并关闭编辑工具"
          checked={saved}
          disabled={busy}
          onChange={(event) => setSaved(event.target.checked)}
        />
        {status?.installBlockedReason ? (
          <StatusBanner tone="warning">{status.installBlockedReason}</StatusBanner>
        ) : null}
        <div className="preparation-actions">
          <Button
            variant="primary"
            disabled={!saved || busy || phase !== 'ready' || Boolean(status?.installBlockedReason)}
            aria-busy={busy || undefined}
            onClick={() => void install()}
          >
            {busy ? '正在验证并安全退出…' : '确认退出并升级'}
          </Button>
          <Button disabled={busy} onClick={() => setConfirm(false)}>
            稍后安装
          </Button>
        </div>
      </Dialog>
    </Panel>
  );
}

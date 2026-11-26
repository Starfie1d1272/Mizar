import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from 'react';
import { desktopInvoke } from '../workspace/client';

export interface UpdateLastError {
  code: string;
  stage: string;
  stageLabel: string;
  summary: string;
  nextStep: string;
  operationId: string;
  manual: boolean;
  security: boolean;
}

export interface UpdateManifestView {
  version: string;
  notes: string;
  installer: { bytes: number };
}

export interface UpdateStatus {
  activity: 'idle' | 'checking' | 'downloading' | 'installing';
  staged: UpdateManifestView | null;
  candidate: UpdateManifestView | null;
  manual: boolean;
  checkedCurrent?: boolean;
  automatic: boolean;
  mulnx?: {
    installed: string | null;
    latest: string | null;
    checkedAt: number | null;
    checkResult: 'unchecked' | 'current' | 'available' | 'error';
    phase: string;
    busy: boolean;
  } | null;
  currentVersion: string;
  lastCheckedAt?: number | null;
  distribution: 'installed' | 'portable';
  error: string | null;
  lastError: UpdateLastError | null;
  failureDetails?: {
    stage: string;
    stageLabel?: string;
    summary: string;
    nextStep: string;
    operationId: string;
  }[];
  downloadedBytes: number;
  downloadSource?: string | null;
  sourceMessage?: string;
  transferStage?: 'downloading' | 'verifying';
  installBlockedReason?: string | null;
  lastResult?: 'installed' | 'restored' | 'cancelled' | 'failed' | null;
  lastResultVersion?: string | null;
}

export const updateFailureMessages: Record<string, string> = {
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

export function formatMegabytes(bytes: number): string {
  return (Math.max(0, bytes) / (1024 * 1024)).toFixed(1);
}

export async function sendUpdateAction(action: string, enabled?: boolean): Promise<UpdateStatus> {
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
        updateFailureMessages[value.error ?? ''] ||
        '更新未完成，原因未知。请导出诊断定位原因。',
    );
  return value;
}

export async function installDesktopUpdate(): Promise<void> {
  await desktopInvoke('install_update');
}

export async function openUpdateReleasePage(version?: string | null): Promise<void> {
  if (window.__TAURI_INTERNALS__) {
    await desktopInvoke('open_update_page', {
      source: 'github',
      version: version ?? null,
    });
  } else {
    window.open('https://github.com/Starfie1d1272/Mizar/releases', '_blank', 'noopener,noreferrer');
  }
}

export interface UpdateStatusContextValue {
  status: UpdateStatus | null;
  setStatus: (next: UpdateStatus) => void;
  connectionError: string;
  unavailable: boolean;
}

const UpdateStatusContext = createContext<UpdateStatusContextValue | null>(null);

export function useUpdatePolling(): UpdateStatusContextValue {
  const [status, setStatusState] = useState<UpdateStatus | null>(null);
  const [connectionError, setConnectionError] = useState('');
  const [unavailable, setUnavailable] = useState(false);

  const setStatus = useCallback((next: UpdateStatus) => {
    setStatusState(next);
  }, []);

  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    let request: AbortController | undefined;
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
          setStatusState(next);
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
  }, []);

  return { status, setStatus, connectionError, unavailable };
}

export function UpdateStatusProvider({ children }: { readonly children: ReactNode }) {
  const value = useUpdatePolling();
  return createElement(UpdateStatusContext.Provider, { value }, children);
}

export function useUpdateStatus(): UpdateStatusContextValue | null {
  return useContext(UpdateStatusContext);
}

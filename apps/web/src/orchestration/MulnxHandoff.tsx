import { useState } from 'react';
import { Button, StatusBanner } from '../ui';
import { desktopInvoke } from '../workspace/client';
import {
  productionAction,
  useLocalRead,
  type Production,
  type ExternalGameIdentity,
} from '../preparation/client';

type ProcessIdentity = {
  pid: number;
  created: string;
  executable: string;
  managed: boolean;
  borrowed?: boolean;
};
/** Native inspection does not turn an externally launched game into a managed session. */
export function MulnxHandoff() {
  const production = useLocalRead<Production>('/local/v1/production', 1000);
  const [processes, setProcesses] = useState<ProcessIdentity[] | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  if (!window.__TAURI_INTERNALS__) return null;
  async function run(open: boolean, external?: ExternalGameIdentity) {
    setBusy(true);
    setError('');
    try {
      if (external && production)
        await productionAction('enter', production, false, undefined, external);
      else if (open) await desktopInvoke('open_mulnx_browser');
      else
        setProcesses(
          (await desktopInvoke<{ processes: ProcessIdentity[] }>('mulnx_handoff_status')).processes,
        );
    } catch (e) {
      setError(e instanceof Error ? e.message : '联调入口不可用');
    } finally {
      setBusy(false);
    }
  }
  return (
    <details>
      <summary>MulNX 游戏交接</summary>
      <p>
        先配好 GSI 与 OBS，再通过 MulNX 启动游戏。借用时保持原设置和窗口，本机 HUD
        覆盖停用；退出工作台只解除借用。
      </p>
      <Button disabled={busy} onClick={() => void run(false)}>
        检查游戏实例
      </Button>
      <Button disabled={busy} onClick={() => void run(true)}>
        打开浏览器联调
      </Button>
      {processes?.length === 0 ? <p>未发现正在运行的 CS2。</p> : null}
      {processes?.map((p) => (
        <p key={`${p.pid}:${p.created}`}>
          PID {p.pid} · {p.borrowed ? '已借用' : p.managed ? 'Mizar 受管' : '外部进程'} · 创建标识{' '}
          {p.created}
          <br />
          {p.executable}
          {!p.managed ? (
            <Button
              disabled={busy || !production?.canEnter || production.mode !== 'preparation'}
              onClick={() => void run(false, { pid: p.pid, created: p.created })}
            >
              借用此游戏并进入工作台
            </Button>
          ) : null}
        </p>
      ))}
      {processes?.length ? (
        <p>
          进程检查不代表 MulNX
          已就绪或活动包已验证。交接会断开旧运镜连接；进入后需重新连接并确认隔离包。
        </p>
      ) : null}
      {error ? <StatusBanner tone="danger">{error}</StatusBanner> : null}
    </details>
  );
}

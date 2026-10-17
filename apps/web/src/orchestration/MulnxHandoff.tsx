import { useState } from 'react';
import { Button, StatusBanner } from '../ui';
import { desktopInvoke } from '../workspace/client';

type ProcessIdentity = { pid: number; created: string; executable: string; managed: boolean };
/** Native inspection does not turn an externally launched game into a managed session. */
export function MulnxHandoff() {
  const [processes, setProcesses] = useState<ProcessIdentity[] | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  if (!window.__TAURI_INTERNALS__) return null;
  async function run(open: boolean) {
    setBusy(true);
    setError('');
    try {
      if (open) await desktopInvoke('open_mulnx_browser');
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
      <summary>MulNX 浏览器联调</summary>
      <p>
        先通过 MulNX 启动游戏，再在浏览器准备比赛并进入制作。保持 Mizar
        运行；本入口不接管外部游戏进程、画质设置或窗口布局。
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
          PID {p.pid} · {p.managed ? 'Mizar 受管' : '外部进程'} · 创建标识 {p.created}
          <br />
          {p.executable}
        </p>
      ))}
      {processes?.length ? (
        <p>
          仅核对进程身份；不代表 MulNX 已就绪。外部游戏由原启动方退出，浏览器结束制作不会关闭它。
        </p>
      ) : null}
      {error ? <StatusBanner tone="danger">{error}</StatusBanner> : null}
    </details>
  );
}

import { useState } from 'react';
import { Button, StatusBanner } from '../ui';
import { desktopInvoke } from '../workspace/client';
import {
  command,
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
  const [expanded, setExpanded] = useState(() => window.location.hash === '#mulnx-launch');
  if (!window.__TAURI_INTERNALS__)
    return (
      <details>
        <summary>浏览器联调</summary>
        <p>独立于 Host 借用会话；仅可在准备阶段选择。之后重新连接并确认隔离包。</p>
        <Button
          disabled={busy || production?.mode !== 'preparation'}
          onClick={() => {
            setBusy(true);
            setError('');
            void command('/operator/orchestration', {
              action: 'browser',
              expectedRevision: production?.revision,
            })
              .catch((reason: unknown) =>
                setError(reason instanceof Error ? reason.message : '联调模式未确认'),
              )
              .finally(() => setBusy(false));
          }}
        >
          使用浏览器联调模式
        </Button>
        {error ? <StatusBanner tone="danger">{error}</StatusBanner> : null}
      </details>
    );
  async function run(open: boolean, external?: ExternalGameIdentity, demoTrial = false) {
    setBusy(true);
    setError('');
    try {
      if (external && production && demoTrial)
        await desktopInvoke('attach_external_cs2', {
          pid: external.pid,
          created: external.created,
          expectedRevision: production.revision,
          demoTrial: true,
        });
      else if (external && production)
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
    <details open={expanded} onToggle={(event) => setExpanded(event.currentTarget.open)}>
      <summary>MulNX 游戏交接</summary>
      <p>
        在官方启动器完成环境检查并启动游戏，再检查下方实际实例，核对程序路径与创建标识后明确借用。加载
        Demo 后也可试播运镜；结束后游戏保持运行。
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
            <>
              <Button
                disabled={busy || !production?.canEnter || production.mode !== 'preparation'}
                onClick={() => void run(false, { pid: p.pid, created: p.created })}
              >
                借用此游戏并进入工作台
              </Button>
              <Button
                disabled={busy || !production || production.mode !== 'preparation'}
                onClick={() => void run(false, { pid: p.pid, created: p.created }, true)}
              >
                运镜试播
              </Button>
            </>
          ) : null}
        </p>
      ))}
      {processes?.length ? <p>进入后连接 MulNX，并确认游戏中已加载的运镜包。</p> : null}
      {error ? <StatusBanner tone="danger">{error}</StatusBanner> : null}
    </details>
  );
}

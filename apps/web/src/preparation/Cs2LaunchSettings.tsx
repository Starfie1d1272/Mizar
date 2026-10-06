import { useEffect, useState } from 'react';
import { Button, Panel, StatusBanner } from '../ui';
import { desktopInvoke } from '../workspace/client';
import { useLocalRead, type Production } from './client';

interface Cs2ConfigStatus {
  preserveQuality: boolean;
  pending: boolean;
  running: boolean;
  message: string | null;
}

export function Cs2LaunchSettings() {
  const desktop = Boolean(window.__TAURI_INTERNALS__);
  const production = useLocalRead<Production>(desktop ? '/local/v1/production' : null);
  const [status, setStatus] = useState<Cs2ConfigStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!desktop) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const next = await desktopInvoke<Cs2ConfigStatus>('cs2_config_status');
        if (active) setStatus(next);
      } catch (reason) {
        if (active) setError(reason instanceof Error ? reason.message : '无法读取 CS2 设置。');
      } finally {
        if (active) timer = setTimeout(() => void poll(), 2000);
      }
    };
    void poll();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [desktop]);
  async function action(run: () => Promise<unknown>) {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await run();
      setStatus(await desktopInvoke<Cs2ConfigStatus>('cs2_config_status'));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'CS2 操作未完成。');
    } finally {
      setBusy(false);
    }
  }
  return (
    <Panel>
      <h2>CS2 启动设置</h2>
      <p>进入现场时由 Mizar 启动 CS2：窗口模式、1920×1080、最高画质。</p>
      <p>结束制作后关闭本次启动的游戏并恢复原设置；隐藏工作台不会关闭游戏。</p>
      {desktop ? (
        <div className="preparation-actions">
          <Button
            role="switch"
            aria-checked={status?.preserveQuality ?? false}
            disabled={!status || busy || status.pending}
            onClick={() =>
              void action(() =>
                desktopInvoke('set_cs2_preferences', { preserveQuality: !status?.preserveQuality }),
              )
            }
          >
            保留原画质 · {status?.preserveQuality ? '开' : '关'}
          </Button>
          <Button
            disabled={!status || busy || status.pending}
            onClick={() => void action(() => desktopInvoke('start_managed_cs2'))}
          >
            {busy ? '处理中…' : '启动 CS2'}
          </Button>
          {status?.pending ? (
            <Button
              disabled={busy || production?.mode !== 'preparation'}
              onClick={() => void action(() => desktopInvoke('finish_managed_cs2'))}
            >
              {status.running ? '退出 CS2 并恢复设置' : '重试恢复设置'}
            </Button>
          ) : null}
        </div>
      ) : (
        <p>请在 Mizar 桌面应用中设置并启动 CS2。</p>
      )}
      {status?.pending && production?.mode !== 'preparation' ? (
        <p>请先结束制作，再恢复游戏设置。</p>
      ) : null}
      {status?.message ? <StatusBanner tone="warning">{status.message}</StatusBanner> : null}
      {error ? <StatusBanner tone="danger">{error}</StatusBanner> : null}
    </Panel>
  );
}

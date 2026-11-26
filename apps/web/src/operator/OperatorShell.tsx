import { DesktopCanvas } from '../patterns/DesktopCanvas';
import { SessionContext } from '../preparation/SessionContext';
import type { UpdateStatus } from '../preparation/UpdateSettings';
import { Button } from '../ui';
import { desktopInvoke } from '../workspace/client';
import { useEffect, useState, type ReactNode } from 'react';
import './operator-shell.css';

function NavigationIcon({ path }: { readonly path: string }) {
  return (
    <svg
      className="product-nav-icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      aria-hidden="true"
    >
      {path === '/' ? (
        <>
          <rect x="3" y="3" width="6" height="6" rx="1" />
          <rect x="15" y="3" width="6" height="6" rx="1" />
          <rect x="3" y="15" width="6" height="6" rx="1" />
          <rect x="15" y="15" width="6" height="6" rx="1" />
        </>
      ) : path === '/resources' ? (
        <>
          <path d="M4 6h16M4 12h16M4 18h10" strokeLinecap="round" />
        </>
      ) : path === '/packages' ? (
        <>
          <polygon points="12 3 20 7.5 12 12 4 7.5 12 3" strokeLinejoin="round" />
          <path
            d="M4 12.5L12 17l8-4.5M4 17l8 4.5 8-4.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </>
      ) : path === '/picture' ? (
        <>
          <rect x="3" y="4" width="18" height="13" rx="2" />
          <path d="M8 20h8M12 17v3M7 8h10" strokeLinecap="round" />
        </>
      ) : (
        <>
          <path d="M4 7h2.5m5 0H20M4 17h8.5m5 0H20" strokeLinecap="round" />
          <circle cx="9" cy="7" r="2.5" />
          <circle cx="15" cy="17" r="2.5" />
        </>
      )}
    </svg>
  );
}

function SidebarUpdateEntry({
  status,
  onStatusChange,
}: {
  readonly status: UpdateStatus;
  readonly onStatusChange: (next: UpdateStatus) => void;
}) {
  const [acting, setActing] = useState(false);

  if (status.staged) {
    const blocked = Boolean(status.installBlockedReason);
    const install = async () => {
      if (acting || blocked) return;
      setActing(true);
      try {
        await desktopInvoke('install_update');
      } catch {
        // Error details are surfaced in Settings -> 应用更新.
      } finally {
        setActing(false);
      }
    };
    return (
      <div className="product-sidebar-update">
        <div className="product-sidebar-update__meta">
          <span className="product-sidebar-update__label">更新已就绪</span>
          <span className="product-sidebar-update__version">v{status.staged.version}</span>
        </div>
        <Button
          variant="primary"
          disabled={acting || blocked}
          aria-busy={acting || undefined}
          onClick={() => void install()}
        >
          {acting ? '正在更新…' : '重启并更新'}
        </Button>
        {status.installBlockedReason ? (
          <p className="product-sidebar-update__reason">{status.installBlockedReason}</p>
        ) : null}
      </div>
    );
  }

  if (
    !status.automatic &&
    status.candidate &&
    !status.manual &&
    status.activity !== 'downloading'
  ) {
    const download = async () => {
      if (acting) return;
      setActing(true);
      try {
        const response = await fetch('/operator/updates', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'download' }),
          signal: AbortSignal.timeout(15_000),
        });
        if (response.ok) onStatusChange((await response.json()) as UpdateStatus);
      } catch {
        // Ignore transient errors; Settings page handles manual troubleshooting.
      } finally {
        setActing(false);
      }
    };
    return (
      <div className="product-sidebar-update">
        <div className="product-sidebar-update__meta">
          <span className="product-sidebar-update__label">发现新版本</span>
          <span className="product-sidebar-update__version">v{status.candidate.version}</span>
        </div>
        <Button disabled={acting} aria-busy={acting || undefined} onClick={() => void download()}>
          下载更新
        </Button>
      </div>
    );
  }

  if (status.manual && status.candidate) {
    const openPage = () => {
      void desktopInvoke('open_update_page', {
        source: 'github',
        version: status.candidate?.version ?? null,
      }).catch(() => {});
    };
    return (
      <div className="product-sidebar-update">
        <div className="product-sidebar-update__meta">
          <span className="product-sidebar-update__label">发现新版本</span>
          <span className="product-sidebar-update__version">v{status.candidate.version}</span>
        </div>
        <Button onClick={openPage}>前往下载</Button>
      </div>
    );
  }

  return null;
}

export function OperatorShell({
  active,
  children,
}: {
  readonly active: string;
  readonly children: ReactNode;
}) {
  const desktop = Boolean(window.__TAURI_INTERNALS__);
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus | null>(null);

  useEffect(() => {
    if (!desktop) return;
    let mounted = true;
    let timer: ReturnType<typeof setTimeout>;
    let controller: AbortController | undefined;
    const poll = async () => {
      controller = new AbortController();
      try {
        const response = await fetch('/local/v1/updates', {
          cache: 'no-store',
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(8000)]),
        });
        if (response.status === 404) return;
        if (response.ok) {
          const next = (await response.json()) as UpdateStatus;
          if (mounted) setUpdateStatus(next);
        }
      } catch {
        // Fail silently in sidebar; Settings page shows connection status.
      } finally {
        if (mounted) timer = setTimeout(() => void poll(), 3000);
      }
    };
    void poll();
    return () => {
      mounted = false;
      clearTimeout(timer);
      controller?.abort();
    };
  }, [desktop]);

  const mulnxAvailable = updateStatus?.mulnx?.checkResult === 'available';

  return (
    <DesktopCanvas kind="product">
      <div className="product-shell mizar-surface">
        <a className="product-skip" href="#product-content">
          跳到主要内容
        </a>
        <aside className="product-sidebar">
          <a className="product-brand" href="/">
            <img className="product-brand__mark" src="/brand/mizar-mark.svg" alt="" />
            <span>MIZAR</span>
          </a>
          <nav aria-label="制作导航">
            {[
              ['/', '本场'],
              ['/resources', '比赛库'],
              ['/packages', '资源管理'],
              ['/picture', 'HUD 与画面'],
              ['/settings', '设置'],
            ].map(([path, label]) => (
              <a
                key={path}
                href={path}
                aria-current={
                  active === path || (path === '/' && active === '/matches') ? 'page' : undefined
                }
              >
                <NavigationIcon path={path ?? '/'} />
                <span>{label}</span>
                {path === '/packages' && mulnxAvailable ? (
                  <span
                    className="product-nav-badge"
                    aria-label="MulNX 有可用更新"
                    title="MulNX 有可用更新"
                  />
                ) : null}
              </a>
            ))}
          </nav>
          {desktop && updateStatus ? (
            <SidebarUpdateEntry status={updateStatus} onStatusChange={setUpdateStatus} />
          ) : null}
        </aside>
        <div className="product-content" id="product-content">
          <SessionContext />
          <div className="product-page">{children}</div>
        </div>
      </div>
    </DesktopCanvas>
  );
}

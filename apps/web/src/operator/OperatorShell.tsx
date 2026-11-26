import { SessionContext } from '../preparation/SessionContext';
import { SidebarUpdateEntry } from '../preparation/SidebarUpdateEntry';
import { UpdateStatusProvider, useUpdateStatus } from '../preparation/updates-client';
import type { ReactNode } from 'react';
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

function OperatorShellLayout({
  active,
  children,
}: {
  readonly active: string;
  readonly children: ReactNode;
}) {
  const updateContext = useUpdateStatus();
  const mulnxAvailable = updateContext?.status?.mulnx?.checkResult === 'available';

  return (
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
        <SidebarUpdateEntry />
      </aside>
      <div className="product-content" id="product-content">
        <SessionContext />
        <div className="product-page">{children}</div>
      </div>
    </div>
  );
}

export function OperatorShell({
  active,
  children,
}: {
  readonly active: string;
  readonly children: ReactNode;
}) {
  return (
    <UpdateStatusProvider>
      <OperatorShellLayout active={active}>{children}</OperatorShellLayout>
    </UpdateStatusProvider>
  );
}

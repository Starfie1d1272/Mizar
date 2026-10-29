import { DesktopCanvas } from '../patterns/DesktopCanvas';
import { SessionContext } from '../preparation/SessionContext';
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
      ) : path === '/matches' ? (
        <>
          <rect x="3" y="4" width="18" height="14" rx="2" />
          <path d="M8 22h8M12 18v4" />
        </>
      ) : (
        <>
          <ellipse cx="12" cy="12" rx="10" ry="6" transform="rotate(-35 12 12)" />
          <circle cx="12" cy="12" r="2" />
        </>
      )}
    </svg>
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
    <DesktopCanvas kind="product">
      <div
        className="product-shell mizar-surface"
        data-settings={active === '/settings' || active === '/packages' || undefined}
      >
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
                {label}
              </a>
            ))}
          </nav>
          <footer>Mizar · 制播工作台</footer>
        </aside>
        <div className="product-content" id="product-content">
          <SessionContext returnToWorkspace={active !== '/'} />
          <div className="product-page">{children}</div>
        </div>
      </div>
    </DesktopCanvas>
  );
}

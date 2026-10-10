import type { ReactNode } from 'react';
import { useObsStatus } from '../workspace/obs-client';
import './operator-shell.css';

export function OperatorShell({
  active,
  children,
}: {
  readonly active: string;
  readonly children: ReactNode;
}) {
  const obs = useObsStatus();
  const section =
    active === '/resources'
      ? new URLSearchParams(window.location.search).get('tab') === 'hud'
        ? '/resources?tab=hud'
        : '/resources'
      : active === '/settings'
        ? '/settings'
        : '/';
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
          {(
            [
              ['/', '本场'],
              ['/resources', '比赛库'],
              ['/resources?tab=hud', 'HUD'],
              ['/settings', '设置'],
            ] as const
          ).map(([path, label]) => (
            <a key={path} href={path} aria-current={section === path ? 'page' : undefined}>
              {label}
            </a>
          ))}
        </nav>
        <a href="/settings?tab=obs" className="product-obs-status">
          <strong>
            OBS ·{' '}
            {obs?.connection === 'connected'
              ? '已连接'
              : obs?.connection === 'invalid_password'
                ? '密码无效'
                : obs?.connection === 'password_required'
                  ? '需要密码'
                  : '待连接'}
          </strong>
        </a>
        <footer>Mizar · 本场制播</footer>
      </aside>
      <div className="product-content" id="product-content">
        {children}
      </div>
    </div>
  );
}

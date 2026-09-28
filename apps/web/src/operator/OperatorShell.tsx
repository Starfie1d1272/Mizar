import type { ReactNode } from 'react';
import './operator-shell.css';

export function OperatorShell({
  active,
  children,
}: {
  readonly active: string;
  readonly children: ReactNode;
}) {
  return (
    <div className="product-shell mizar-surface">
      <a className="product-skip" href="#product-content">
        跳到主要内容
      </a>
      <header className="product-topbar">
        <a className="product-brand" href="/">
          <img className="product-brand__mark" src="/brand/mizar-mark.svg" alt="" />
          <span>Mizar</span>
        </a>
        <nav aria-label="制作导航">
          {[
            ['/', '总览'],
            ['/matches', '比赛'],
            ['/picture', '画面'],
            ['/settings', '设置'],
          ].map(([path, label]) => (
            <a key={path} href={path} aria-current={active === path ? 'page' : undefined}>
              {label}
            </a>
          ))}
        </nav>
      </header>
      <div className="product-content" id="product-content">
        {children}
      </div>
      <footer className="product-footer">
        <span>Mizar</span>
        <span>本地制播工作台</span>
      </footer>
    </div>
  );
}

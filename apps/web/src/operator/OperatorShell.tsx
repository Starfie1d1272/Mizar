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
    <div className="product-shell">
      <a className="product-skip" href="#product-content">
        跳到主要内容
      </a>
      <header className="product-topbar">
        <a className="product-brand" href="/operator">
          <img className="product-brand__mark" src="/brand/mizar-mark.svg" alt="" />
          <span>Mizar</span>
        </a>
        <nav aria-label="制作导航">
          {[
            ['/operator', '制作控制'],
            ['/operator/bp', 'BP 制作'],
            ['/operator/hud', 'HUD 编辑器'],
            ['/debug', '运行诊断'],
          ].map(([path, label]) => (
            <a key={path} href={path} aria-current={active === path ? 'page' : undefined}>
              {label}
            </a>
          ))}
        </nav>
        <div className="product-topbar__actions">
          <a href="/qualification" aria-current={active === '/qualification' ? 'page' : undefined}>
            现场验收
          </a>
          <a className="product-output-link" href="/program" target="_blank" rel="noreferrer">
            打开播出画面 <span aria-hidden="true">↗</span>
          </a>
        </div>
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

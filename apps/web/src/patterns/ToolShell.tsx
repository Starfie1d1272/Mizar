import type { ReactNode } from 'react';
import './tool-shell.css';

/** A tool keeps its own window role; Main navigation belongs to Preparation. */
export function ToolShell({
  title,
  children,
  fill = false,
}: {
  title: string;
  children: ReactNode;
  fill?: boolean;
}) {
  return (
    <div className="product-shell mizar-tool-shell mizar-surface" data-fill={fill || undefined}>
      <a className="mizar-tool-skip" href="#tool-content">
        跳到工具内容
      </a>
      <header className="mizar-tool-heading">
        <span className="mizar-tool-brand">
          <img src="/brand/mizar-mark.svg" alt="" width="24" height="24" />
          Mizar
        </span>
        <h1>{title}</h1>
      </header>
      <div id="tool-content" tabIndex={-1}>
        {children}
      </div>
    </div>
  );
}

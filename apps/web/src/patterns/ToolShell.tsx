import type { ReactNode } from 'react';
import './tool-shell.css';

/** A tool keeps its own window role; Main navigation belongs to Preparation. */
export function ToolShell({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="product-shell mizar-tool-shell mizar-surface">
      <a className="mizar-tool-skip" href="#tool-content">
        跳到工具内容
      </a>
      <header className="mizar-tool-heading">
        <span className="mizar-tool-brand">
          <img src="/brand/mizar-mark.svg" alt="" width="24" height="24" />
          Mizar
        </span>
        <span>{title}</span>
      </header>
      <div id="tool-content" tabIndex={-1}>
        {children}
      </div>
    </div>
  );
}

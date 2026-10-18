import { DesktopCanvas } from './DesktopCanvas';
import type { ReactNode } from 'react';
import './tool-shell.css';

/** A tool keeps its own window role; Main navigation belongs to Preparation. */
export function ToolShell({
  title,
  context,
  children,
}: {
  title: string;
  context?: ReactNode;
  children: ReactNode;
}) {
  return (
    <DesktopCanvas kind="product">
      <div className="product-shell mizar-tool-shell mizar-surface" data-context={Boolean(context)}>
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
        {context}
        <div id="tool-content" tabIndex={-1}>
          {children}
        </div>
      </div>
    </DesktopCanvas>
  );
}

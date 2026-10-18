import type { ReactNode } from 'react';
import { Panel } from '../ui/index.js';
import './patterns.css';

export function Workbench({
  preview,
  inspector,
  layout = 'columns',
  className = '',
}: {
  preview: ReactNode;
  inspector: ReactNode;
  layout?: 'columns' | 'canvas';
  className?: string;
}) {
  return (
    <div className={`mizar-workbench ${className}`} data-layout={layout}>
      {preview}
      {inspector}
    </div>
  );
}
export function PreviewFrame({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section className="mizar-preview" aria-label={label}>
      <h2>{label}</h2>
      <div className="mizar-preview-frame">{children}</div>
    </section>
  );
}
export function Inspector({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Panel className="mizar-inspector">
      <h2>{title}</h2>
      {children}
    </Panel>
  );
}

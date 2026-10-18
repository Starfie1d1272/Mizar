import type { ReactNode } from 'react';
import { Button } from '../ui/index.js';
import './library-workspace.css';

export interface LibraryItem {
  id: string;
  title: string;
  summary: ReactNode;
  status: string;
}

/** Shared browsing surface; callers own selection, data and source-specific commands. */
export function LibraryWorkspace({
  items,
  selectedId,
  onSelect,
  browserHeader,
  browserActions,
  header,
  footer,
  children,
  emptyMessage,
  status,
}: {
  items: LibraryItem[];
  selectedId: string | undefined;
  onSelect: (id: string) => void;
  browserHeader: ReactNode;
  browserActions?: ReactNode;
  header?: ReactNode;
  footer?: ReactNode;
  children: ReactNode;
  emptyMessage: string;
  status?: ReactNode;
}) {
  return (
    <>
      {status ? <div className="library-source-status">{status}</div> : null}
      <div className="library-workspace">
        <section className="library-browser" aria-label="赛事与场次">
          {browserHeader}
          <div className="library-list" aria-label="赛事赛程">
            {items.length ? (
              items.map((item) => (
                <Button
                  key={item.id}
                  aria-pressed={selectedId === item.id}
                  onClick={() => onSelect(item.id)}
                >
                  <small>{item.summary}</small>
                  <strong>{item.title}</strong>
                  <small>{item.status}</small>
                </Button>
              ))
            ) : (
              <p>{emptyMessage}</p>
            )}
          </div>
          {browserActions ? <div className="library-browser-actions">{browserActions}</div> : null}
        </section>
        <section className="library-detail" aria-label="比赛详情">
          {header ? <header className="library-detail-heading">{header}</header> : null}
          <div className="library-detail-body">{children}</div>
          {footer ? <footer className="library-detail-actions">{footer}</footer> : null}
        </section>
      </div>
    </>
  );
}

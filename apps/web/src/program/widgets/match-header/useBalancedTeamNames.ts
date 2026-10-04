import { useLayoutEffect, useRef } from 'react';

export function useBalancedTeamNames<T extends HTMLElement = HTMLElement>(
  names: string,
  design: string,
  selector = '.match-header__team-name',
  maxHeight = Number.POSITIVE_INFINITY,
) {
  const ref = useRef<T>(null);
  useLayoutEffect(() => {
    const nodes = [...(ref.current?.querySelectorAll<HTMLElement>(selector) ?? [])];
    let disposed = false;
    const fit = () => {
      if (disposed) return;
      for (const node of nodes) node.style.fontSize = '';
      const sizes = nodes
        .filter((node) => node.clientWidth > 0)
        .map((node) => {
          const base = Number.parseFloat(getComputedStyle(node).fontSize);
          return (
            base *
            Math.min(
              1,
              Math.max(0, node.clientWidth - 2) / Math.max(1, node.scrollWidth),
              maxHeight / Math.max(1, node.scrollHeight),
            )
          );
        });
      if (sizes.length) for (const node of nodes) node.style.fontSize = `${Math.min(...sizes)}px`;
    };
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(fit);
    for (const node of nodes) observer?.observe(node);
    void document.fonts?.ready.then(fit);
    fit();
    return () => {
      disposed = true;
      observer?.disconnect();
    };
  }, [names, design, selector, maxHeight]);
  return ref;
}

import './scaled-canvas.css';
import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';

export function AspectRatioCanvas({
  width,
  height,
  children,
}: {
  width: number;
  height: number;
  children: ReactNode;
}) {
  const host = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);

  useLayoutEffect(() => {
    const element = host.current;
    if (!element) return;
    const resize = () => {
      const { clientWidth, clientHeight } = element;
      if (clientWidth <= 0 || clientHeight <= 0) return;
      setScale(Math.min(clientWidth / width, clientHeight / height));
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(element);
    return () => observer.disconnect();
  }, [width, height]);

  return (
    <div className="scaled-canvas" data-canvas="aspect-ratio" ref={host}>
      <div className="scaled-canvas__inner" style={{ width, height, zoom: scale }}>
        {children}
      </div>
    </div>
  );
}

export function MinBudgetCanvas({
  minWidth,
  minHeight,
  children,
}: {
  minWidth: number;
  minHeight: number;
  children: ReactNode;
}) {
  const host = useRef<HTMLDivElement>(null);
  const [innerStyle, setInnerStyle] = useState<CSSProperties>({
    width: '100%',
    height: '100%',
  });

  useLayoutEffect(() => {
    const element = host.current;
    if (!element) return;
    const resize = () => {
      const { clientWidth, clientHeight } = element;
      if (clientWidth <= 0 || clientHeight <= 0) return;
      const scale = Math.min(1, clientWidth / minWidth, clientHeight / minHeight);
      if (scale >= 1) {
        setInnerStyle({ width: '100%', height: '100%' });
      } else {
        setInnerStyle({
          width: clientWidth / scale,
          height: clientHeight / scale,
          zoom: scale,
        });
      }
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(element);
    return () => observer.disconnect();
  }, [minWidth, minHeight]);

  return (
    <div className="scaled-canvas" data-canvas="min-budget" ref={host}>
      <div className="scaled-canvas__inner" style={innerStyle}>
        {children}
      </div>
    </div>
  );
}

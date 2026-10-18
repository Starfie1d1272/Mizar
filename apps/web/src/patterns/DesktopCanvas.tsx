import './desktop-canvas.css';
import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';

// Logical 1080p coordinates keep shared 14px/32px controls usable at 1080p.
// At 2K every dimension scales by 4/3; at 4K it scales by 2, including text.
// Measure CSS pixels: WebView already accounts for Windows display scaling.
const surfaces = {
  left: { width: 480, height: 1080 },
  dock: { width: 1440, height: 270 },
  preview: { width: 1920, height: 1080 },
  product: { width: 1920, height: 1080 },
} as const;

export function DesktopCanvas({
  kind,
  children,
}: {
  kind: keyof typeof surfaces;
  children: ReactNode;
}) {
  const host = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  const size = surfaces[kind];
  useLayoutEffect(() => {
    const element = host.current;
    if (!element) return;
    const resize = () => {
      setScale(Math.min(element.clientWidth / size.width, element.clientHeight / size.height));
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(element);
    return () => observer.disconnect();
  }, [size]);
  return (
    <div className="desktop-canvas" data-kind={kind} ref={host}>
      <div className="desktop-canvas__canvas" style={{ ...size, zoom: scale }}>
        {children}
      </div>
    </div>
  );
}

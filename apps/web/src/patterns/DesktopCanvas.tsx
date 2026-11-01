import './desktop-canvas.css';
import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';

// The dock keeps one logical control layout across native display scales.
// The left panel remains responsive to its available CSS pixels.
const surfaces = {
  left: { width: 480, height: 1080 },
  dock: { width: 1280, height: 240 },
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
  const responsive = kind === 'left';
  useLayoutEffect(() => {
    if (responsive) return;
    const element = host.current;
    if (!element) return;
    const resize = () => {
      setScale(Math.min(element.clientWidth / size.width, element.clientHeight / size.height));
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(element);
    return () => observer.disconnect();
  }, [size, responsive]);
  return (
    <div className="desktop-canvas" data-kind={kind} ref={host}>
      <div
        className="desktop-canvas__canvas"
        style={responsive ? { width: '100%', height: '100%' } : { ...size, zoom: scale }}
      >
        {children}
      </div>
    </div>
  );
}

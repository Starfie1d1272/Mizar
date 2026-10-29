import { AssetFonts, assetStyle, useAssetUrl } from './assets.js';
import type { ReactNode } from 'react';

import './program.css';

export const PROGRAM_CANVAS_WIDTH = 1920;
export const PROGRAM_CANVAS_HEIGHT = 1080;

export interface ProgramCanvasProps {
  readonly children?: ReactNode;
  readonly className?: string;
}

export function ProgramCanvas({ children, className }: ProgramCanvasProps) {
  const resolve = useAssetUrl();
  const canvasClassName =
    className === undefined ? 'program-canvas' : `program-canvas ${className}`;

  return (
    <div className={canvasClassName} data-program-canvas="true" style={assetStyle(resolve)}>
      <AssetFonts />
      {children}
    </div>
  );
}

import type { CSSProperties } from 'react';
import { AssetProvider, type AssetUrlResolver } from './assets.js';
import type { BpSnapshot } from '@mizar/protocol/bp';
import { BpCompactPresentation, BpPresentation } from './BpPresentation.js';
import { ProgramSceneView, type ProgramSceneViewProps } from './ProgramSceneView.js';
import { GameplayHud, type GameplayHudProps } from './GameplayHud.js';

/** A host supplies projected data and configuration; rendering never opens a connection. */
export type ProgramViewProps =
  | ({ readonly kind: 'hud' } & GameplayHudProps)
  | ({ readonly kind: 'scene' } & ProgramSceneViewProps)
  | {
      readonly kind: 'bp';
      readonly snapshot: BpSnapshot | null;
      readonly animate: boolean;
      readonly compact: boolean;
    };

export function ProgramView(
  props: ProgramViewProps & {
    readonly resolveAssetUrl?: AssetUrlResolver;
    readonly sceneStyle?: CSSProperties | undefined;
  },
) {
  return (
    <AssetProvider resolve={props.resolveAssetUrl}>
      <div style={{ display: 'contents', ...props.sceneStyle }}>
        <ProgramViewContent {...props} />
      </div>
    </AssetProvider>
  );
}

function ProgramViewContent(props: ProgramViewProps) {
  if (props.kind === 'hud') return <GameplayHud {...props} />;
  if (props.kind === 'scene') return <ProgramSceneView {...props} />;
  return props.compact ? (
    <BpCompactPresentation snapshot={props.snapshot} animate={props.animate} />
  ) : (
    <BpPresentation snapshot={props.snapshot} animate={props.animate} />
  );
}

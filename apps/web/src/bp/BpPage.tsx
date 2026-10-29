import { pulseTokenStyle } from '../program/broadcast-display';
import { useBroadcastDisplayConfig } from '../realtime/broadcast-display-client';
import { ProgramView } from '@mizar/hud-view';
import { useProgramScenes } from '../workspace/client';
import { useBpSession } from './client';
import '@mizar/hud-view/bp.css';

export function BpPage({ compact = false }: { readonly compact?: boolean }) {
  const { snapshot, animate } = useBpSession();
  const scenes = useProgramScenes();
  const display = useBroadcastDisplayConfig(true, 'bp');
  if (display.current === null) return null;
  return (
    <ProgramView
      kind="bp"
      sceneStyle={
        display.current ? (pulseTokenStyle(display.current.program) ?? undefined) : undefined
      }
      compact={compact}
      snapshot={compact && scenes?.bpCompact !== 'on' ? null : snapshot}
      animate={animate}
    />
  );
}

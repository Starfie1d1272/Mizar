import { ProgramView } from '@mizar/hud-view';
import { useProgramScenes } from '../workspace/client';
import { useBpSession } from './client';
import '@mizar/hud-view/bp.css';

export function BpPage({ compact = false }: { readonly compact?: boolean }) {
  const { snapshot, animate } = useBpSession();
  const scenes = useProgramScenes();
  return (
    <ProgramView
      kind="bp"
      compact={compact}
      snapshot={compact && scenes?.bpCompact !== 'on' ? null : snapshot}
      animate={animate}
    />
  );
}

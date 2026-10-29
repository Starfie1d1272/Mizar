import { ProgramView } from '../program/ProgramView';
import { useProgramScenes } from '../workspace/client';
import { useBpSession } from './client';
import './bp.css';

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

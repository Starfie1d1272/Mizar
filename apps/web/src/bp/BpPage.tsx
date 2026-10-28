import { BpCompactPresentation, BpPresentation } from './BpPresentation';
import { useProgramScenes } from '../workspace/client';
import { useBpSession } from './client';
import './bp.css';

export function BpPage({ compact = false }: { readonly compact?: boolean }) {
  const { snapshot, animate } = useBpSession();
  const scenes = useProgramScenes();
  return compact ? (
    <BpCompactPresentation
      snapshot={scenes?.bpCompact === 'on' ? snapshot : null}
      animate={animate}
    />
  ) : (
    <BpPresentation snapshot={snapshot} animate={animate} />
  );
}

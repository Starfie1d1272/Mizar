import { BpPresentation } from './BpPresentation';
import { useBpSession } from './client';
import './bp.css';

export function BpPage() {
  const { snapshot, animate } = useBpSession();
  return <BpPresentation snapshot={snapshot} animate={animate} />;
}

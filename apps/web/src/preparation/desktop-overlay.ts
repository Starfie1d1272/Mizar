import { HUD_WIDGET_IDS } from '@mizar/hud-config';

export interface OverlayPolicy {
  revision: string;
  enabled: boolean;
  visibility: Record<string, boolean>;
}

export function overlayGroups(policy: OverlayPolicy, presetRadar = false) {
  return {
    radar: policy.enabled && (policy.visibility.radar ?? presetRadar),
    hud:
      policy.enabled &&
      HUD_WIDGET_IDS.some((id) => id !== 'radar' && policy.visibility[id] !== false),
  };
}

/** Turning HUD back on follows the selected preset; radar stays independent. */
export function toggleOverlayGroup(
  policy: OverlayPolicy,
  group: 'radar' | 'hud',
  presetRadar = false,
): OverlayPolicy {
  const groups = overlayGroups(policy, presetRadar);
  groups[group] = !groups[group];
  const visibility: Record<string, boolean> = { radar: groups.radar };
  if (!groups.hud) for (const id of HUD_WIDGET_IDS) if (id !== 'radar') visibility[id] = false;
  return { revision: policy.revision, enabled: groups.radar || groups.hud, visibility };
}

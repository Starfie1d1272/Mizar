import { describe, expect, it } from 'vitest';
import { HUD_WIDGET_IDS } from '@mizar/hud-config';
import { overlayGroups, toggleOverlayGroup, type OverlayPolicy } from './desktop-overlay';

describe('independent local overlay groups', () => {
  it('keeps radar off and other HUD on by default, and preserves each through all four states', () => {
    let policy: OverlayPolicy = {
      revision: 'local-1',
      enabled: true,
      visibility: { radar: false },
    };
    expect(overlayGroups(policy)).toEqual({ radar: false, hud: true });
    policy = toggleOverlayGroup(policy, 'radar');
    expect(overlayGroups(policy)).toEqual({ radar: true, hud: true });
    policy = toggleOverlayGroup(policy, 'hud');
    expect(overlayGroups(policy)).toEqual({ radar: true, hud: false });
    for (const id of HUD_WIDGET_IDS) if (id !== 'radar') expect(policy.visibility[id]).toBe(false);
    policy = toggleOverlayGroup(policy, 'radar');
    expect(overlayGroups(policy)).toEqual({ radar: false, hud: false });
    expect(policy.enabled).toBe(false);
    policy = toggleOverlayGroup(policy, 'hud');
    expect(overlayGroups(policy)).toEqual({ radar: false, hud: true });
    expect(policy.visibility).toEqual({ radar: false });
    expect(policy.revision).toBe('local-1');
  });

  it('does not restore HUD when only radar is enabled from a legacy disabled overlay', () => {
    const policy = toggleOverlayGroup({ revision: 'old', enabled: false, visibility: {} }, 'radar');
    expect(overlayGroups(policy)).toEqual({ radar: true, hud: false });
  });

  it('reads and toggles legacy radar-follow-preset using the selected preset', () => {
    const legacy = { revision: 'old', enabled: true, visibility: {} };
    expect(overlayGroups(legacy, true).radar).toBe(true);
    const policy = toggleOverlayGroup(legacy, 'hud', true);
    expect(overlayGroups(policy)).toEqual({ radar: true, hud: false });
  });
});

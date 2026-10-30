import { describe, expect, it } from 'vitest';
import {
  desktopWidgetVisible,
  overlayGroups,
  type OverlayPolicy,
} from '../src/preparation/desktop-overlay';

describe('desktop HUD display policy', () => {
  it('keeps every widget and overlay group off when the persisted policy is disabled', () => {
    const policy: OverlayPolicy = {
      revision: '1',
      enabled: false,
      visibility: { radar: true, health: true },
    };
    const before = structuredClone(policy);
    expect(desktopWidgetVisible(null, 'radar', true)).toBe(false);
    expect(desktopWidgetVisible(policy, 'radar', true)).toBe(false);
    expect(desktopWidgetVisible(policy, 'health', true)).toBe(false);
    expect(overlayGroups(policy, true)).toEqual({ radar: false, hud: false });
    expect(policy).toEqual(before);
  });
  it('still applies per-widget choices after the policy is ready', () => {
    const policy: OverlayPolicy = { revision: '2', enabled: true, visibility: { radar: false } };
    expect(desktopWidgetVisible(policy, 'radar', true)).toBe(false);
    expect(desktopWidgetVisible(policy, 'health', true)).toBe(true);
  });
});

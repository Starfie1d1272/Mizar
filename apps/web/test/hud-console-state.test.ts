import { describe, expect, it } from 'vitest';

import { getBuiltinLayout, getBuiltinPreset, getBuiltinTheme } from '@mizar/hud-config';

import { hudResourceNavigationBlockReason } from '../src/operator/hud-console-state';

const selectedIds = {
  preset: 'preset-a',
  layout: 'layout-a',
  theme: 'theme-a',
} as const;

describe('HUD console draft navigation', () => {
  it('keeps the layout dirty state scoped to layout selection', () => {
    expect(
      hudResourceNavigationBlockReason('layout', getBuiltinLayout(), selectedIds, {
        preset: true,
        layout: true,
        theme: true,
      }),
    ).toContain('布局');
  });

  it('only blocks a resource with its own dirty draft', () => {
    expect(
      hudResourceNavigationBlockReason('layout', getBuiltinLayout(), selectedIds, {
        preset: false,
        layout: false,
        theme: true,
      }),
    ).toBeNull();
    expect(
      hudResourceNavigationBlockReason('theme', getBuiltinTheme(), selectedIds, {
        preset: false,
        layout: true,
        theme: true,
      }),
    ).toContain('外观');
  });

  it('blocks preset changes that would replace a dirty referenced resource', () => {
    const nextPreset = {
      ...getBuiltinPreset(),
      layoutId: 'layout-b',
      themeId: 'theme-b',
    };
    expect(
      hudResourceNavigationBlockReason('preset', nextPreset, selectedIds, {
        preset: false,
        layout: true,
        theme: false,
      }),
    ).toContain('布局');
    expect(
      hudResourceNavigationBlockReason('preset', nextPreset, selectedIds, {
        preset: false,
        layout: false,
        theme: true,
      }),
    ).toContain('外观');
  });
});

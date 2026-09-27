import {
  getBuiltinLayout,
  getBuiltinPreset,
  getBuiltinTheme,
  hudThemeSchema,
  parseHudLayout,
  parseHudPreset,
  resolveHudPreset,
  type HudLayout,
  type HudPreset,
  type HudResolvedPreset,
  type HudTheme,
} from '@mizar/hud-config';

import { hudResourceNameError } from './hud-console-state';

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

function previewName(value: string, fallback: string): string {
  return hudResourceNameError(value) === null ? value.trim() : fallback;
}

export interface HudPreviewResources {
  readonly preset: HudPreset;
  readonly layout: HudLayout;
  readonly theme: HudTheme;
  readonly fallbackPreset?: HudPreset;
  readonly fallbackLayout?: HudLayout;
  readonly fallbackTheme?: HudTheme;
}

/** Keep valid resources visible while a sibling draft field is being edited. */
export function resolveHudPreview({
  preset,
  layout,
  theme,
  fallbackPreset = getBuiltinPreset(),
  fallbackLayout = getBuiltinLayout(),
  fallbackTheme = getBuiltinTheme(),
}: HudPreviewResources): HudResolvedPreset {
  const parsedPreset = (() => {
    try {
      return parseHudPreset({
        ...preset,
        name: previewName(preset.name, fallbackPreset.name),
      });
    } catch {
      return parseHudPreset(fallbackPreset);
    }
  })();
  const parsedLayout = (() => {
    try {
      return parseHudLayout({
        ...layout,
        name: previewName(layout.name, fallbackLayout.name),
      });
    } catch {
      return parseHudLayout(fallbackLayout);
    }
  })();
  const parsedTheme = (() => {
    try {
      return hudThemeSchema.parse({
        ...theme,
        name: previewName(theme.name, fallbackTheme.name),
        brandColor: HEX_COLOR.test(theme.brandColor)
          ? theme.brandColor.toLowerCase()
          : fallbackTheme.brandColor,
      });
    } catch {
      return hudThemeSchema.parse(fallbackTheme);
    }
  })();
  try {
    return resolveHudPreset(parsedPreset, parsedLayout, parsedTheme);
  } catch {
    return resolveHudPreset(
      parseHudPreset(fallbackPreset),
      parseHudLayout(fallbackLayout),
      hudThemeSchema.parse(fallbackTheme),
    );
  }
}

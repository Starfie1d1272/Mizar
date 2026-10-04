import type { z } from 'zod';
import type {
  HUD_WIDGET_IDS,
  HUD_BROADCAST_STYLES,
  HUD_ANCHORS,
  HUD_RESIZE_POLICIES,
  HUD_PANEL_STYLES,
  HUD_CORNER_STYLES,
  HUD_RESOLVED_SNAPSHOT_SCHEMA_VERSION,
} from './constants.js';
import type {
  hudLayoutSchema,
  hudWidgetPlacementSchema,
  hudThemeSchema,
  hudWidgetSettingsSchema,
  hudPresetSchema,
  hudConfigDocumentSchema,
} from './schemas.js';
export type HudWidgetId = (typeof HUD_WIDGET_IDS)[number];
export type HudAnchor = (typeof HUD_ANCHORS)[number];
export type HudResizePolicy = (typeof HUD_RESIZE_POLICIES)[number];
export type HudPanelStyle = (typeof HUD_PANEL_STYLES)[number];
export type HudCornerStyle = (typeof HUD_CORNER_STYLES)[number];

export interface HudSemanticColors {
  readonly textPrimary: string;
  readonly textMuted: string;
  readonly sideCt: string;
  readonly sideT: string;
  readonly stateDanger: string;
  readonly stateWarning: string;
  readonly stateSuccess: string;
  readonly stateUnknown: string;
  readonly objectiveBomb: string;
  readonly objectiveDefuse: string;
}

export interface HudSemanticSurface {
  readonly primary: string;
  readonly strong: string;
  readonly opacity: number;
  readonly borderOpacity: number;
}

export interface HudSemanticRadius {
  readonly sm: number;
  readonly md: number;
  readonly lg: number;
}

export interface HudResolvedTheme extends HudTheme {
  readonly semantic: {
    readonly colors: HudSemanticColors;
    readonly surface: HudSemanticSurface;
    readonly radius: HudSemanticRadius;
    readonly fontFamily: 'Inter';
  };
}

export interface HudThemeRecipe {
  readonly id: string;
  readonly colors: HudSemanticColors;
  readonly surfaces: Record<HudPanelStyle, HudSemanticSurface>;
  readonly radii: Record<HudCornerStyle, HudSemanticRadius>;
  readonly fontFamily: 'Inter';
}

export interface HudLayout extends z.infer<typeof hudLayoutSchema> {
  readonly widgets: Record<HudWidgetId, HudWidgetPlacement>;
}

export type HudWidgetPlacement = z.infer<typeof hudWidgetPlacementSchema>;
export type HudTheme = z.infer<typeof hudThemeSchema>;
export type HudWidgetSettings = z.infer<typeof hudWidgetSettingsSchema>;
export type HudPreset = Omit<z.infer<typeof hudPresetSchema>, 'widgets'> & {
  readonly widgets: Record<HudWidgetId, HudWidgetSettings>;
};

export interface HudResolvedPreset {
  readonly schemaVersion: typeof HUD_RESOLVED_SNAPSHOT_SCHEMA_VERSION;
  readonly preset: {
    readonly id: string;
    readonly name: string;
    readonly layoutId: string;
    readonly themeId: string;
  };
  readonly layout: HudLayout;
  readonly theme: HudResolvedTheme;
  readonly widgets: Record<HudWidgetId, HudWidgetSettings>;
}

export type HudConfigDocument = Omit<
  z.infer<typeof hudConfigDocumentSchema>,
  'customPresets' | 'customLayouts' | 'customThemes'
> & {
  readonly customPresets: HudPreset[];
  readonly customLayouts: HudLayout[];
  readonly customThemes: HudTheme[];
};
export type HudActivePresetReference = HudConfigDocument['activePreset'];

export type HudEditorControl = {
  readonly path: string;
  readonly label: string;
  readonly help?: string;
  readonly variants: readonly string[];
} & (
  | { readonly type: 'boolean' }
  | {
      readonly type: 'select';
      readonly options: readonly { readonly value: string; readonly label: string }[];
    }
);

export interface HudWidgetDescriptor {
  readonly id: HudWidgetId;
  readonly label: string;
  readonly rendererAvailability: 'implemented' | 'unimplemented';
  readonly supportedVariants: readonly [string, ...string[]];
  readonly defaultVariant: string;
  readonly variantLabels: Readonly<Record<string, string>>;
  readonly resizePolicy: HudResizePolicy;
  readonly defaultPlacement: HudWidgetPlacement;
  readonly dimensionsByVariant: Readonly<
    Record<string, { readonly width: number; readonly height: number }>
  >;
  readonly sourceOwner: 'program' | 'radar' | null;
  readonly settingsSchemaByVariant: Readonly<
    Record<string, (value: unknown) => Record<string, unknown>>
  >;
  readonly defaultSettingsByVariant: Readonly<Record<string, Record<string, unknown>>>;
  readonly editorControls: readonly HudEditorControl[];
  /** Registry-owned parser for the complete persisted widget settings envelope. */
  readonly validateSettings: (value: unknown) => HudWidgetSettings;
}

export type HudWidgetDescriptorDefinition = Omit<HudWidgetDescriptor, 'validateSettings'>;

export interface HudWidgetBox {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

export interface HudBroadcastStyleDefinition {
  readonly style: (typeof HUD_BROADCAST_STYLES)[number];
  readonly label: string;
  readonly showTeamName: boolean;
  readonly brandColor?: string;
  readonly recipe: HudThemeRecipe;
  readonly widgetDimensions?: Partial<
    Record<HudWidgetId, { readonly width: number; readonly height: number }>
  >;
  readonly layout?: {
    readonly name: string;
    readonly widgets: Partial<Record<HudWidgetId, HudWidgetPlacement>>;
  };
}

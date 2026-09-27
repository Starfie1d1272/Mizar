import type { ComponentType } from 'react';

import {
  HUD_WIDGET_IDS,
  HUD_WIDGET_REGISTRY,
  type HudResolvedPreset,
  type HudWidgetBox,
  type HudWidgetId,
  type HudWidgetPlacement,
  type HudWidgetSettings,
} from '@mizar/hud-config';
import type { ProgramSnapshot } from '@mizar/protocol/program';

import { RoundHistory, SeriesStrip, TopScoreBar } from './widgets/match-header';
import { FocusedPlayer } from './widgets/focused-player/FocusedPlayer';
import type { RadarSnapshot } from '@mizar/protocol/radar';
import type { LocalChannelClient } from '../realtime';
import { RadarWidget } from './widgets/radar/Radar';
import { PlayerRail } from './widgets/player-rails';

interface HudWidgetRendererBaseProps {
  readonly resolvedPreset: HudResolvedPreset;
  readonly widgetId: HudWidgetId;
  readonly placement: HudWidgetPlacement;
  readonly box: HudWidgetBox;
  readonly settings: HudWidgetSettings;
  readonly presentationRevision?: number;
}

/** Program-owned widgets cannot access Radar-only spatial truth by type. */
export interface HudWidgetRendererProps extends HudWidgetRendererBaseProps {
  readonly snapshot: ProgramSnapshot;
}

/** Radar owns an independent source contract and does not require ProgramSnapshot. */
export interface RadarHudWidgetRendererProps extends HudWidgetRendererBaseProps {
  readonly radarSnapshot?: RadarSnapshot | null | undefined;
  readonly radarClient?: LocalChannelClient<'radar'> | undefined;
}

export type HudRendererEntry =
  | {
      readonly availability: 'implemented';
      readonly source: 'program';
      readonly renderer: ComponentType<HudWidgetRendererProps>;
    }
  | {
      readonly availability: 'implemented';
      readonly source: 'radar';
      readonly renderer: ComponentType<RadarHudWidgetRendererProps>;
    }
  | {
      readonly availability: 'unimplemented';
      readonly source: null;
      readonly renderer: null;
    };

export type HudRendererRegistry = Readonly<Record<HudWidgetId, HudRendererEntry>>;

const UNIMPLEMENTED_RENDERER_ENTRY: HudRendererEntry = Object.freeze({
  availability: 'unimplemented',
  source: null,
  renderer: null,
});

const IMPLEMENTED_RENDERERS: Partial<Record<HudWidgetId, HudRendererEntry>> = {
  radar: { availability: 'implemented', source: 'radar', renderer: RadarWidget },
  'focused-player': { availability: 'implemented', source: 'program', renderer: FocusedPlayer },
  'top-score-bar': { availability: 'implemented', source: 'program', renderer: TopScoreBar },
  'team-ct-rail': { availability: 'implemented', source: 'program', renderer: PlayerRail },
  'team-t-rail': { availability: 'implemented', source: 'program', renderer: PlayerRail },
  'series-strip': { availability: 'implemented', source: 'program', renderer: SeriesStrip },
  'round-history': { availability: 'implemented', source: 'program', renderer: RoundHistory },
};

/** Web-owned React seam. Future component Issues add their renderer here only. */
export const HUD_RENDERER_REGISTRY: HudRendererRegistry = Object.freeze(
  Object.fromEntries(
    HUD_WIDGET_IDS.map((id) => [id, IMPLEMENTED_RENDERERS[id] ?? UNIMPLEMENTED_RENDERER_ENTRY]),
  ) as Record<HudWidgetId, HudRendererEntry>,
);

export function getHudRendererEntry(
  id: HudWidgetId,
  registry: HudRendererRegistry = HUD_RENDERER_REGISTRY,
): HudRendererEntry {
  const entry = registry[id];
  if (entry === undefined) throw new Error(`缺少 Web HUD renderer registry entry：${id}`);
  return entry;
}

/** Keep framework-neutral descriptor availability and Web renderer availability in lockstep. */
export function assertHudRendererRegistryConsistency(): void {
  for (const descriptor of HUD_WIDGET_REGISTRY) {
    const entry = getHudRendererEntry(descriptor.id);
    if (entry.availability !== descriptor.rendererAvailability) {
      throw new Error(`HUD renderer availability 不一致：${descriptor.id}`);
    }
    if ((entry.renderer === null) !== (entry.availability === 'unimplemented')) {
      throw new Error(`HUD renderer entry 状态不一致：${descriptor.id}`);
    }
    if (entry.renderer !== null) {
      const expectedSource = descriptor.id === 'radar' ? 'radar' : 'program';
      if (entry.source !== expectedSource) {
        throw new Error(`HUD renderer source owner 不一致：${descriptor.id}`);
      }
    }
  }
}

assertHudRendererRegistryConsistency();

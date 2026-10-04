import { deepFreeze } from '../json.js';
import { EWC_STYLE } from './ewc.js';
import { IEM_STYLE } from './iem.js';
import { PERFECTWORLD_STYLE } from './perfectworld.js';
import type { HudBroadcastStyleDefinition } from '../types.js';

/** Add a registered broadcast design here; authoring presets can also use portable JSON packs. */
export const HUD_BROADCAST_STYLE_CATALOG: readonly HudBroadcastStyleDefinition[] = deepFreeze([
  EWC_STYLE,
  IEM_STYLE,
  PERFECTWORLD_STYLE,
]);

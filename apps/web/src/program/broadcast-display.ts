import type {
  BroadcastDisplayConfig,
  ProgramVisualConfigV1,
  ResolvedHudModule,
} from '@mizar/broadcast-config';
import { HUD_BROADCAST_STYLES } from '@mizar/hud-config';
import type { ProgramSceneId } from '@mizar/protocol/program-scenes';

export function supportsHud(hud: ResolvedHudModule): boolean {
  if (hud.renderer !== 'native') return false;
  const visual = hud.overlays.pause.visual;
  return (
    visual === 'legacy' || visual === 'current' || HUD_BROADCAST_STYLES.some((id) => id === visual)
  );
}

export function supportsProgramScene(
  program: ProgramVisualConfigV1,
  scene: Exclude<ProgramSceneId, 'gameplay'>,
): boolean {
  const selected = program.scenes[scene];
  return (
    selected.kind === 'builtin' &&
    selected.id === 'pulse' &&
    selected.apiVersion === 1 &&
    Object.keys(program.tokens).length === 0 &&
    Object.keys(program.assets).length === 0
  );
}

export function supportsBroadcastDisplay(
  config: BroadcastDisplayConfig,
  scene: ProgramSceneId = 'gameplay',
): boolean {
  return scene === 'gameplay'
    ? supportsHud(config.hud)
    : supportsProgramScene(config.program, scene);
}

import type { BroadcastDisplayConfig } from '@mizar/broadcast-config';
import { HUD_BROADCAST_STYLES } from '@mizar/hud-config';

/** Reject unimplemented visuals instead of silently substituting an on-air design. */
export function supportsBroadcastDisplay(config: BroadcastDisplayConfig): boolean {
  if (config.hud.renderer !== 'native') return false;
  const visual = config.hud.overlays.pause.visual;
  if (
    visual !== 'legacy' &&
    visual !== 'current' &&
    !HUD_BROADCAST_STYLES.some((id) => id === visual)
  )
    return false;
  // Accept a complete scene set together so independent OBS sources never
  // switch to a partially supported configuration.
  return (
    Object.values(config.program.scenes).every(
      (selected) =>
        selected.kind === 'builtin' && selected.id === 'pulse' && selected.apiVersion === 1,
    ) &&
    Object.keys(config.program.tokens).length === 0 &&
    Object.keys(config.program.assets).length === 0
  );
}

import type { CSSProperties } from 'react';
import type {
  BroadcastDisplayConfig,
  ProgramVisualConfigV1,
  ResolvedHudModule,
} from '@mizar/broadcast-config';
import { isSupportedHudPauseVisual } from '@mizar/broadcast-config';
import type { ProgramSceneId } from '@mizar/protocol/program-scenes';

export function supportsHud(hud: ResolvedHudModule): boolean {
  if (hud.renderer !== 'native') return false;
  return isSupportedHudPauseVisual(hud.overlays.pause.visual);
}

const pulseTokens = {
  'pulse.white': '--mizar-broadcast-pulse-white',
  'pulse.blue': '--mizar-broadcast-pulse-blue',
  'pulse.gold': '--mizar-broadcast-pulse-gold',
  'pulse.muted': '--mizar-broadcast-pulse-muted',
  'pulse.canvas': '--mizar-broadcast-pulse-canvas',
  'pulse.shell': '--mizar-broadcast-pulse-shell',
} as const;

export function pulseTokenStyle(program: ProgramVisualConfigV1): CSSProperties | null {
  const result: Record<string, string> = {};
  if (Object.keys(program.assets).some((name) => name !== 'pulse.background')) return null;
  const background = program.assets['pulse.background'];
  if (background) {
    const query = new URLSearchParams({
      resourceId: background.resource.id,
      version: background.resource.version,
      digest: background.resource.digest,
      fileId: background.fileId,
    });
    result['--pulse-background-image'] = `url("/local/v1/broadcast-assets?${query.toString()}")`;
  }
  for (const [name, value] of Object.entries(program.tokens)) {
    const property = pulseTokens[name as keyof typeof pulseTokens];
    if (!property || typeof value !== 'string' || !/^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/i.test(value))
      return null;
    result[property] = value;
  }
  return result as CSSProperties;
}

export function pulseBackgroundUrl(program: ProgramVisualConfigV1): string | null {
  const ref = program.assets['pulse.background'];
  if (!ref) return null;
  return `/local/v1/broadcast-assets?${new URLSearchParams({ resourceId: ref.resource.id, version: ref.resource.version, digest: ref.resource.digest, fileId: ref.fileId })}`;
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
    pulseTokenStyle(program) !== null
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

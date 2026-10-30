import { canonicalJson, resolveHudPreset } from '@mizar/hud-config';
import { MUSIC_GROUPS } from '@mizar/protocol/music';
import { assertSupportedHudModule } from '@mizar/broadcast-config';
import type {
  ActiveBroadcastSnapshot,
  AssetRef,
  CameraSourceRef,
  HudModule,
  ModuleRecord,
  ProgramVisualConfigV1,
  MulnxToolRef,
  PresetResolver,
  ResourceRef,
  SceneVisualRef,
} from '@mizar/broadcast-config';

/** Each operation checks installed, verified bytes or a registered built-in capability. */
export interface BroadcastDependencyResolver {
  asset(ref: AssetRef): Promise<void>;
  image?(ref: AssetRef): Promise<void>;
  hud(value: Extract<HudModule, { renderer: { kind: 'web-hud' } }>): Promise<void>;
  scene(value: SceneVisualRef): Promise<void>;
  camera(source: CameraSourceRef): Promise<MulnxToolRef>;
}
const pulseColorTokens = new Set([
  'pulse.white',
  'pulse.blue',
  'pulse.gold',
  'pulse.muted',
  'pulse.canvas',
  'pulse.shell',
]);
/** The renderer implements the Pulse background slot and six color tokens. */
export function assertSupportedProgram(value: ProgramVisualConfigV1): void {
  if (
    Object.entries(value.tokens).some(
      ([key, color]) =>
        !pulseColorTokens.has(key) ||
        typeof color !== 'string' ||
        !/^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/i.test(color),
    ) ||
    Object.keys(value.assets).some((key) => key !== 'pulse.background')
  )
    throw new Error('capability_unsupported');
  if (
    Object.values(value.scenes).some(
      (scene) => scene.kind !== 'builtin' || scene.id !== 'pulse' || scene.apiVersion !== 1,
    )
  )
    throw new Error('capability_unsupported');
}
export function createBroadcastResolver(
  dependencies: BroadcastDependencyResolver,
): PresetResolver & {
  resolveModule(module: ModuleRecord): Promise<{
    value: ActiveBroadcastSnapshot['resolved'][ModuleRecord['kind']];
    lock: ActiveBroadcastSnapshot['lock'];
  }>;
} {
  async function resolveModule(module: ModuleRecord) {
    const resources = new Map<string, ResourceRef>();
    const tools = new Map<string, MulnxToolRef>();
    const addResource = (resource: ResourceRef) => {
      resources.set(canonicalJson(resource), resource);
    };
    const asset = async (ref: AssetRef) => {
      await dependencies.asset(ref);
      addResource(ref.resource);
    };
    let value: ActiveBroadcastSnapshot['resolved'][ModuleRecord['kind']];
    switch (module.kind) {
      case 'hud': {
        assertSupportedHudModule(module);
        const hudValue = module.value;
        if ('preset' in hudValue) {
          value = {
            renderer: 'native',
            config: resolveHudPreset(hudValue.preset, hudValue.layout, hudValue.theme),
            overlays: hudValue.overlays,
            accent: hudValue.accent,
          };
        } else {
          await dependencies.hud(hudValue);
          addResource(hudValue.renderer.resource);
          for (const ref of Object.values(hudValue.panelAssets)) await asset(ref);
          value = { renderer: 'web-hud', config: hudValue };
        }
        break;
      }
      case 'program':
        assertSupportedProgram(module.value);
        for (const visual of Object.values(module.value.scenes)) {
          await dependencies.scene(visual);
          if (visual.kind === 'declarative') addResource(visual.resource);
        }
        for (const ref of Object.values(module.value.assets)) {
          if (!dependencies.image) throw new Error('capability_unsupported');
          await dependencies.image(ref);
          addResource(ref.resource);
        }
        value = module.value;
        break;
      case 'music':
        for (const group of MUSIC_GROUPS)
          for (const track of module.value.groups[group].tracks) await asset(track.asset);
        value = module.value;
        break;
      case 'camera':
        for (const map of module.value.maps) {
          const tool = await dependencies.camera(map.source);
          tools.set(canonicalJson(tool), tool);
          if (map.openingSound) await asset(map.openingSound.asset);
        }
        value = module.value;
        break;
    }
    return { value, lock: { resources: [...resources.values()], tools: [...tools.values()] } };
  }
  return {
    resolveModule,
    async resolve(modules) {
      const hud = modules.get('hud');
      const program = modules.get('program');
      const music = modules.get('music');
      const camera = modules.get('camera');
      if (
        !hud ||
        hud.kind !== 'hud' ||
        !program ||
        program.kind !== 'program' ||
        (music && music.kind !== 'music') ||
        (camera && camera.kind !== 'camera')
      )
        throw new Error('module_missing');
      const resolvedHud = await resolveModule(hud);
      const resolvedProgram = await resolveModule(program);
      const resolvedMusic = music ? await resolveModule(music) : null;
      const resolvedCamera = camera ? await resolveModule(camera) : null;
      const resources = new Map<string, ResourceRef>();
      const tools = new Map<string, MulnxToolRef>();
      for (const result of [resolvedHud, resolvedProgram, resolvedMusic, resolvedCamera]) {
        if (!result) continue;
        for (const ref of result.lock.resources) resources.set(canonicalJson(ref), ref);
        for (const ref of result.lock.tools) tools.set(canonicalJson(ref), ref);
      }
      return {
        resolved: {
          hud: resolvedHud.value as ActiveBroadcastSnapshot['resolved']['hud'],
          program: resolvedProgram.value as ActiveBroadcastSnapshot['resolved']['program'],
          music: (resolvedMusic?.value ?? null) as ActiveBroadcastSnapshot['resolved']['music'],
          camera: (resolvedCamera?.value ?? null) as ActiveBroadcastSnapshot['resolved']['camera'],
        },
        lock: { resources: [...resources.values()], tools: [...tools.values()] },
      };
    },
  };
}

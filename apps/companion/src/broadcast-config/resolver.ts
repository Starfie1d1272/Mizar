import { canonicalJson, resolveHudPreset } from '@mizar/hud-config';
import { MUSIC_GROUPS } from '@mizar/protocol/music';
import type {
  AssetRef,
  CameraSourceRef,
  HudModule,
  MulnxToolRef,
  PresetResolver,
  ResourceRef,
  SceneVisualRef,
} from '@mizar/broadcast-config';

/** Each operation checks installed, verified bytes or a registered built-in capability. */
export interface BroadcastDependencyResolver {
  asset(ref: AssetRef): Promise<void>;
  hud(value: Extract<HudModule, { renderer: { kind: 'web-hud' } }>): Promise<void>;
  scene(value: SceneVisualRef): Promise<void>;
  camera(source: CameraSourceRef): Promise<MulnxToolRef>;
}
export function createBroadcastResolver(dependencies: BroadcastDependencyResolver): PresetResolver {
  return {
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
      const resources = new Map<string, ResourceRef>();
      const tools = new Map<string, MulnxToolRef>();
      const addResource = (resource: ResourceRef) => {
        resources.set(canonicalJson(resource), resource);
      };
      const asset = async (ref: AssetRef) => {
        await dependencies.asset(ref);
        addResource(ref.resource);
      };
      const hudValue = hud.value;
      let resolvedHud: import('@mizar/broadcast-config').ResolvedHudModule;
      if ('preset' in hudValue) {
        resolvedHud = {
          renderer: 'native',
          config: resolveHudPreset(hudValue.preset, hudValue.layout, hudValue.theme),
          overlays: hudValue.overlays,
          accent: hudValue.accent,
        };
      } else {
        await dependencies.hud(hudValue);
        addResource(hudValue.renderer.resource);
        for (const ref of Object.values(hudValue.panelAssets)) await asset(ref);
        resolvedHud = { renderer: 'web-hud', config: hudValue };
      }
      for (const visual of Object.values(program.value.scenes)) {
        await dependencies.scene(visual);
        if (visual.kind === 'declarative') addResource(visual.resource);
      }
      for (const ref of Object.values(program.value.assets)) await asset(ref);
      if (music)
        for (const group of MUSIC_GROUPS)
          for (const track of music.value.groups[group].tracks) await asset(track.asset);
      if (camera)
        for (const map of camera.value.maps) {
          const tool = await dependencies.camera(map.source);
          tools.set(canonicalJson(tool), tool);
          if (map.openingSound) await asset(map.openingSound.asset);
        }
      return {
        resolved: {
          hud: resolvedHud,
          program: program.value,
          music: music?.value ?? null,
          camera: camera?.value ?? null,
        },
        lock: { resources: [...resources.values()], tools: [...tools.values()] },
      };
    },
  };
}

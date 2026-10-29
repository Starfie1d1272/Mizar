import type { ObsRpc } from './reconcile.js';

type Item = {
  sceneItemId: number;
  sourceUuid: string;
  sourceName: string;
  sceneItemEnabled: boolean;
  isGroup?: boolean;
  sourceType?: string;
};

export type AudioSceneContainer = {
  name: string;
  group: boolean;
  items: Item[];
  managedRoots: Set<string>;
  activeManagedRoots: Set<string>;
  otherRoots: Set<string>;
};

/** Read the entire scene graph before planning any changes. */
export async function inspectAudioSceneGraph(obs: ObsRpc, managedNames: readonly string[]) {
  const scenes = (await obs.call('GetSceneList')).scenes;
  if (!Array.isArray(scenes)) throw new Error('audio_scenes_unknown');
  const names = scenes.map((scene: unknown) => {
    if (
      !scene ||
      typeof scene !== 'object' ||
      typeof (scene as Record<string, unknown>).sceneName !== 'string'
    )
      throw new Error('audio_scenes_unknown');
    return (scene as unknown as { sceneName: string }).sceneName;
  });
  if (new Set(names).size !== names.length) throw new Error('audio_scene_identity_ambiguous');
  if (managedNames.some((name) => !names.includes(name))) throw new Error('audio_scene_missing');

  const containers = new Map<string, AudioSceneContainer>();
  const read = async (name: string, group: boolean): Promise<AudioSceneContainer> => {
    const key = `${group ? 'group' : 'scene'}\0${name}`;
    const cached = containers.get(key);
    if (cached) return cached;
    const raw = (
      await obs.call(group ? 'GetGroupSceneItemList' : 'GetSceneItemList', { sceneName: name })
    ).sceneItems;
    if (!Array.isArray(raw)) throw new Error('audio_scene_items_unknown');
    const items: Item[] = raw.map((value: unknown) => {
      if (!value || typeof value !== 'object') throw new Error('audio_scene_items_unknown');
      const item = value as Record<string, unknown>;
      if (
        typeof item.sceneItemId !== 'number' ||
        typeof item.sourceUuid !== 'string' ||
        typeof item.sourceName !== 'string' ||
        typeof item.sceneItemEnabled !== 'boolean'
      )
        throw new Error('audio_scene_items_unknown');
      return item as Item;
    });
    const container = {
      name,
      group,
      items,
      managedRoots: new Set<string>(),
      activeManagedRoots: new Set<string>(),
      otherRoots: new Set<string>(),
    };
    containers.set(key, container);
    return container;
  };
  const nestedScenes = new Set<string>();
  const discovered = new Set<string>();
  const discover = async (name: string, group: boolean, ancestors: Set<string>): Promise<void> => {
    const key = `${group ? 'group' : 'scene'}\0${name}`;
    if (ancestors.has(key) || ancestors.size >= 32) throw new Error('audio_scene_cycle');
    if (discovered.has(key)) return;
    const next = new Set(ancestors).add(key);
    const container = await read(name, group);
    for (const item of container.items) {
      if (item.isGroup !== true && item.sourceType !== 'OBS_SOURCE_TYPE_SCENE') continue;
      if (item.isGroup !== true) nestedScenes.add(item.sourceName);
      await discover(item.sourceName, item.isGroup === true, next);
    }
    discovered.add(key);
  };
  for (const name of names) await discover(name, false, new Set());
  const walk = async (
    name: string,
    group: boolean,
    root: string,
    managed: boolean,
    active: boolean,
    ancestors: Set<string>,
  ): Promise<void> => {
    const key = `${group ? 'group' : 'scene'}\0${name}`;
    if (ancestors.has(key) || ancestors.size >= 32) throw new Error('audio_scene_cycle');
    const container = await read(name, group);
    (managed ? container.managedRoots : container.otherRoots).add(root);
    if (managed && active) container.activeManagedRoots.add(root);
    const next = new Set(ancestors).add(key);
    for (const item of container.items) {
      if (item.isGroup !== true && item.sourceType !== 'OBS_SOURCE_TYPE_SCENE') continue;
      // Disabled parents may later be enabled outside this operation, so retain
      // them in the ownership graph even though they are not audible now.
      await walk(
        item.sourceName,
        item.isGroup === true,
        root,
        managed,
        active && item.sceneItemEnabled,
        next,
      );
    }
  };
  for (const name of managedNames) await walk(name, false, name, true, true, new Set());
  // Other top-level scenes can reach a managed nested container. Nested scenes
  // are traversed from their roots, rather than counted as a second owner.
  for (const name of names)
    if (!managedNames.includes(name) && !nestedScenes.has(name))
      await walk(name, false, name, false, true, new Set());
  return [...containers.values()];
}
